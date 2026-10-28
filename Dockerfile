FROM oven/bun:1-alpine AS base
WORKDIR /app

# Isolated browser bundle; no dev dependencies or build tools in the final image.
FROM base AS picker-build
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY scripts/build-model-picker.ts ./scripts/build-model-picker.ts
COPY web/model-picker/ ./web/model-picker/
RUN bun run scripts/build-model-picker.ts

FROM base AS runtime

# su-exec lets the entrypoint fix bind-mount perms then drop to non-root.
RUN apk add --no-cache su-exec

# Install deps (none beyond bun runtime, but cache the install step)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY --from=picker-build /app/dist/admin-ui/ ./dist/admin-ui/

# Entrypoint (fixes logs/ perms, then drops privileges)
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create the unprivileged user and a logs dir owned by it (used when no
# bind mount overlays /app/logs).
RUN adduser -D -h /app gateway \
  && mkdir -p /app/logs /app/logs/errors /home/gateway/.devin-gateway /home/gateway/.devin-gateway-settings \
  && chown -R gateway:gateway /app/logs /home/gateway/.devin-gateway /home/gateway/.devin-gateway-settings \
  && chmod 700 /home/gateway/.devin-gateway-settings

ENV PORT=3000
ENV HOST=0.0.0.0
ENV LOG_FILE=/app/logs/gateway.log
ENV DEVIN_GATEWAY_CONFIG_DIR=/home/gateway/.devin-gateway
ENV DEVIN_GATEWAY_SETTINGS_DIR=/home/gateway/.devin-gateway-settings
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

CMD ["/docker-entrypoint.sh"]
