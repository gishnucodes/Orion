# Orion job scanner — Cloud Run Job image.
#
# Runs the nightly pipeline once per invocation (Cloud Scheduler triggers it).
# Bundles Node 20, the app, and Chromium (via Playwright). The model and search
# are now remote APIs; the only local model is the small sentence-embedding
# model used for semantic scoring, downloaded into the image at build time.

FROM node:20-bookworm-slim

# better-sqlite3 is a native module: it needs a toolchain at `npm ci` time.
# ca-certificates is needed for outbound HTTPS (Gemini, Custom Search, Resend).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Keep Playwright's browser download inside the image at a stable path.
# ONNXRUNTIME_NODE_INSTALL=skip: the CPU runtime ships inside the npm package;
# skip the optional CUDA download that would only bloat the image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    ONNXRUNTIME_NODE_INSTALL=skip \
    ORION_HF_CACHE=/opt/hf-cache

# Install dependencies first so this layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Chromium + its system libraries, matching the installed Playwright version.
RUN npx playwright install --with-deps chromium

# Embedding model for semantic scoring (~35 MB, quantised), cached in the image.
COPY config.yml ./
COPY deploy/fetch-embedding-model.mjs deploy/
RUN node deploy/fetch-embedding-model.mjs

# Application source (see .dockerignore for what is excluded).
COPY . .

# Ephemeral working directories; the database is synced from GCS at runtime.
RUN mkdir -p db raw output/logs

CMD ["node", "deploy/cloudrun-entrypoint.mjs"]
