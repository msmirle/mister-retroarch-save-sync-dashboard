ARG SYNC_IMAGE=ghcr.io/juaniwck/mister-retroarch-save-sync:latest
FROM ${SYNC_IMAGE} AS dashboard-base

LABEL org.opencontainers.image.source="https://github.com/msmirle/mister-retroarch-save-sync-dashboard" \
      org.opencontainers.image.description="Read-only MiSTer / RetroArch save comparison dashboard" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

WORKDIR /dashboard
COPY package.json ./
COPY src ./src
COPY public ./public
COPY LICENSE ./LICENSE

ENV HOST=0.0.0.0 PORT=8080 REFRESH_SECONDS=60 SYNC_MODULE_ROOT=/app/src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(e=>{console.error(e.message);process.exit(1)})"]
CMD ["node", "src/server.js"]

FROM dashboard-base AS test
COPY test ./test
RUN node --test

FROM dashboard-base AS runtime
