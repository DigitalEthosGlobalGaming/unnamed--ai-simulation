# Server + world workers. Node runs the TypeScript sources directly (type stripping), no build step.
FROM docker.io/library/node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# Lockfile-faithful install of the server workspace and its @uas/* dependencies only.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/sim/package.json packages/sim/
COPY packages/mind/package.json packages/mind/
COPY packages/models/package.json packages/models/
COPY packages/store/package.json packages/store/
COPY packages/pack-basic/package.json packages/pack-basic/
COPY packages/client/package.json packages/client/
COPY packages/evals/package.json packages/evals/
COPY packages/server/package.json packages/server/
# The viewer is built separately; its manifest is only here so the lockfile matches.
COPY apps/viewer/package.json apps/viewer/
# better-sqlite3 ships prebuilt binaries (linux x64/arm64, glibc and musl), so no install scripts or toolchain are needed.
RUN npm ci --omit=dev --workspace=@uas/server --ignore-scripts --no-audit --no-fund

COPY packages ./packages
COPY worlds ./worlds

ENV UAS_DB=/data/uas.db UAS_WORLDS=/app/worlds PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/src/main.ts"]
