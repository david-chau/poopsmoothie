# Multi-stage: build the client, then run just the server + built assets.
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Voice capture's models (VAD, per-language ASR, speaker embedding — see
# server/stt.js) are *not* baked into this image: they're ~100MB-1GB+
# depending on which English model is picked, and baking them in meant every
# pull re-downloaded them even for a plain code change. Run
# `./scripts/fetch-models.sh` on the host once and bind-mount the result in
# (docker-compose.yml / docker-compose.prod.yml already do, at
# `./models:/app/models`) — server/index.js already treats a missing/empty
# model dir as "voice chat unavailable, text chat still works", so this is a
# pure size/caching win, not a new failure mode.
#
# sherpa-onnx-node ships prebuilt glibc binaries (no musl/alpine build), so
# the runtime stage below isn't alpine — client-build above stays alpine,
# that one never touches the native addon.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY scripts/*.mjs ./scripts/
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PS_STT_MODEL_DIR=/app/models
EXPOSE 4321
EXPOSE 4322
CMD ["node", "server/index.js"]
