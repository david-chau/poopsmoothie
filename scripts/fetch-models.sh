#!/usr/bin/env bash
# Downloads the voice-chat models (VAD, per-language ASR, speaker embedding —
# see server/stt.js) into ./models on the host, instead of baking them into
# the Docker image. docker-compose.yml / docker-compose.prod.yml bind-mount
# this directory in, so the published image stays ~100MB instead of ~800MB+
# and pulling a newer app version never re-pulls the models.
#
#   ./scripts/fetch-models.sh                    # default English model
#   EN_MODEL=fast-conformer ./scripts/fetch-models.sh   # lighter, less accurate
#
# Safe to re-run: each piece is skipped if already present. Delete a language
# directory under ./models to force re-fetching just that one.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models
cd models

case "${EN_MODEL:-parakeet}" in
  parakeet)
    # Most accurate option tested (see docs/ARCHITECTURE.md#voice-chat-pipeline)
    # and the heaviest, ~630MB unpacked. Swap to fast-conformer below if
    # `npm run stt-bench` says the host can't keep up.
    en_url=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
    en_dir=sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
    ;;
  fast-conformer)
    en_url=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-fast-conformer-transducer-en-24500-int8.tar.bz2
    en_dir=sherpa-onnx-nemo-fast-conformer-transducer-en-24500-int8
    ;;
  *)
    echo "unknown EN_MODEL: ${EN_MODEL} (expected parakeet or fast-conformer)" >&2
    exit 1
    ;;
esac

if [ -f en/model.json ]; then
  echo "en: already present, skipping"
else
  echo "en: fetching ${EN_MODEL:-parakeet}..."
  mkdir -p en
  curl -fsSL -o en.tar.bz2 "$en_url"
  tar xjf en.tar.bz2
  mv "$en_dir/encoder.int8.onnx" en/encoder.onnx
  mv "$en_dir/decoder.int8.onnx" en/decoder.onnx
  mv "$en_dir/joiner.int8.onnx" en/joiner.onnx
  mv "$en_dir/tokens.txt" en/tokens.txt
  echo '{"kind":"offline"}' > en/model.json
  rm -rf en.tar.bz2 "$en_dir"
fi

if [ -f zh/model.json ]; then
  echo "zh: already present, skipping"
else
  echo "zh: fetching..."
  mkdir -p zh
  curl -fsSL -o zh.tar.bz2 \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2
  tar xjf zh.tar.bz2
  zh_dir=sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30
  mv "$zh_dir/encoder.int8.onnx" zh/encoder.onnx
  mv "$zh_dir/decoder.onnx" zh/decoder.onnx
  mv "$zh_dir/joiner.int8.onnx" zh/joiner.onnx
  mv "$zh_dir/tokens.txt" zh/tokens.txt
  echo '{"kind":"online"}' > zh/model.json
  rm -rf zh.tar.bz2 "$zh_dir"
fi

if [ -f silero_vad.onnx ]; then
  echo "vad: already present, skipping"
else
  echo "vad: fetching..."
  curl -fsSL -o silero_vad.onnx \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
fi

if [ -f speaker_embedding.onnx ]; then
  echo "speaker embedding: already present, skipping"
else
  echo "speaker embedding: fetching..."
  curl -fsSL -o speaker_embedding.onnx \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
fi

echo "models ready in ./models"
