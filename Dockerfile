# Shared multi-stage Dockerfile for both API and Web apps.
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
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

# ── Web runtime ──────────────────────────────────────────────────────────
FROM base AS web
COPY --from=build /app /app
EXPOSE 3000
CMD ["pnpm", "--filter", "@exam-app/web", "start"]
