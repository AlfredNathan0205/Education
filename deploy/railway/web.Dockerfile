# Railway: the web service. Same build as the root Dockerfile, ending at the web runtime (Railway builds the last stage).
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

# ── Web runtime ──────────────────────────────────────────────────────────
FROM base AS web
COPY --from=build /app /app
EXPOSE 3000
# next start listens on $PORT (Railway sets it), 3000 otherwise.
CMD ["pnpm", "--filter", "@exam-app/web", "start"]
