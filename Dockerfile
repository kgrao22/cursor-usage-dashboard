# One image, two roles.
#   Cloud Run Service : node src/server.js       (default CMD) — reads, IAP-protected
#   Cloud Run Job     : node scripts/ingest-cli.mjs  (overridden) — writes, no ingress
# Same code, same dependencies, no drift between what ingests and what displays.

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so a code-only change reuses the layer.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

# Cloud Run injects PORT; the app reads it and falls back to 8080.
EXPOSE 8080
CMD ["node", "src/server.js"]
