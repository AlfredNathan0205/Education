# Railway: the API service. Same build as the root Dockerfile, ending at the API runtime (Railway builds the last stage).
# Build context must be the repo root so the full monorepo is available.

FROM node:20-slim AS base
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# ── Install ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

# ── Build everything ─────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# COPY . . overwrites pnpm workspace symlinks stripped by .dockerignore.
# Re-link, then generate the Prisma client before compiling TypeScript.
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @exam-app/database db:generate
RUN pnpm run build

# ── API runtime ──────────────────────────────────────────────────────────
FROM base AS api
COPY --from=build /app /app
ENV NODE_OPTIONS=--enable-source-maps
EXPOSE 3001
# Apply pending migrations, then start. A failed migration stops the deploy (the old version keeps running).
CMD ["sh", "-c", "cd packages/database && npx prisma migrate deploy && cd /app && node apps/api/dist/main.js"]
