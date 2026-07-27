# Multi-stage: build the client, fetch the voice models, then run just the
# server + built assets + models.
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Voice capture's models (VAD, per-language streaming ASR, speaker embedding —
# see server/stt.js), fetched once at build time so the runtime image never
# needs network access. Alpine here only for curl/tar/bzip2 — this stage's own
# base image doesn't need to match the runtime stage's below.
#
# One model per language, never a combined bilingual one: that was tried first
# and dropped — trained on Mandarin/English code-switching speech, it was
# biased toward hearing Chinese even from a pure-English speaker. Each
# language directory below is single-language, so output can't cross-
# contaminate; server/stt.js picks which recognizer decodes a given room's
# audio from its `voiceLanguage` setting.
FROM alpine:3.20 AS models
RUN apk add --no-cache curl tar bzip2
WORKDIR /models

# English: NeMo parakeet-tdt-0.6b-v2, int8. An *offline* model — this pipeline
# VAD-segments before decoding, so it only ever hands over complete utterances
# and gains nothing from a streaming model's incremental machinery. Chosen by
# measurement, not vibes: against the streaming zipformer it previously used,
# on the short phrases people actually say across a table ("The Tooth Fairy"),
# that model returned "THE TWO FA" where this one is exact — and this one
# emits real capitalization and punctuation rather than ALL CAPS.
#
# It is also the heaviest option here (~630MB unpacked, ~3x the runtime cost
# of the alternatives). If `npm run stt-bench` says this box can't keep up,
# swap this block for the much lighter
# `sherpa-onnx-nemo-fast-conformer-transducer-en-24500-int8` — same file
# layout and same "offline" kind below, so only these URLs change.
RUN mkdir -p en \
    && curl -fsSL -o en.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2 \
    && tar xjf en.tar.bz2 \
    && EN_DIR=sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 \
    && mv "$EN_DIR/encoder.int8.onnx" en/encoder.onnx \
    && mv "$EN_DIR/decoder.int8.onnx" en/decoder.onnx \
    && mv "$EN_DIR/joiner.int8.onnx" en/joiner.onnx \
    && mv "$EN_DIR/tokens.txt" en/tokens.txt \
    && echo '{"kind":"offline"}' > en/model.json \
    && rm -rf en.tar.bz2 "$EN_DIR"

# Chinese streaming zipformer, int8 (this release ships int8 encoder/joiner
# only — the decoder network is tiny enough that quantizing it barely
# matters, so its one fp32 file is used as-is).
RUN mkdir -p zh \
    && curl -fsSL -o zh.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2 \
    && tar xjf zh.tar.bz2 \
    && ZH_DIR=sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30 \
    && mv "$ZH_DIR/encoder.int8.onnx" zh/encoder.onnx \
    && mv "$ZH_DIR/decoder.onnx" zh/decoder.onnx \
    && mv "$ZH_DIR/joiner.int8.onnx" zh/joiner.onnx \
    && mv "$ZH_DIR/tokens.txt" zh/tokens.txt \
    && echo '{"kind":"online"}' > zh/model.json \
    && rm -rf zh.tar.bz2 "$ZH_DIR"

RUN curl -fsSL -o silero_vad.onnx \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
# Speaker embedding (bilingual zh+en CAM++, small/fast) — Phase 5's voice
# enrollment/matching. Bilingual is fine here: voice-print matching doesn't
# care what language is spoken, only whose voice it is — the contamination
# problem above was specific to transcription, not identification.
RUN curl -fsSL -o speaker_embedding.onnx \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx

# sherpa-onnx-node ships prebuilt glibc binaries (no musl/alpine build), so the
# runtime stage moves off alpine — client-build above stays alpine, that one
# never touches the native addon.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY scripts/*.mjs ./scripts/
COPY --from=client-build /app/client/dist ./client/dist
COPY --from=models /models ./models

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PS_STT_MODEL_DIR=/app/models
EXPOSE 4321
EXPOSE 4322
CMD ["node", "server/index.js"]
