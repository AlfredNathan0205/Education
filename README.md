# Exam App

Competitive, curriculum-aligned assessment platform for school students.

## Repository Layout

```
apps/
  api/          NestJS API server (port 3001)
  web/          Next.js web app (port 3000)
packages/
  database/     Prisma schema, migrations, typed client
  shared/       Cross-app types and constants
```

This is a **modular monolith** — a single deployable API with domain boundaries enforced at the module level, not at the network level. The 21 domains defined in the architecture spec map to NestJS modules within `apps/api`.

## Run locally (Docker)

The fastest way to run everything — no local PostgreSQL or Redis install needed.

```bash
# 1. Create a .env with an OTP signing key (the .env.example shows all variables)
cp .env.example .env
#    Generate a secret and paste it into OTP_HMAC_SECRET:
openssl rand -hex 32

# 2. Start all services
docker compose up --build

# 3. Open the app
#    Web:  http://localhost:3000
#    API:  http://localhost:3001/health
```

**Sign-in codes** — the API uses a console OTP sender in development. After
requesting a code on the sign-in page, read it from the API container logs:

```bash
docker compose logs api | grep "DEV ONLY"
```

**Roles CLI** — to run the roles command inside the running API container:

```bash
docker compose exec api node apps/api/dist/authz/cli/roles.js <command> [args...]
```

Data is stored in a Docker named volume (`pgdata`) and survives restarts.
Run `docker compose down -v` to wipe everything and start fresh.

## Prerequisites

- Node.js >= 20
- pnpm 9.x (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- PostgreSQL 16
- Redis 7

## Setup

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your local PostgreSQL and Redis connection details

# Generate Prisma client
pnpm --filter @exam-app/database db:generate

# Run database migrations
pnpm --filter @exam-app/database db:migrate:dev

# Start both apps in dev mode
pnpm dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps in watch mode |
| `pnpm build` | Build all apps and packages |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint` | Run linters |
| `pnpm test` | Run test suites |
| `pnpm format` | Format code with Prettier |

## Architecture

See the spec repository for full architecture documentation:
- `MASTER_SPEC.md` — Platform, domain model, governance
- `DOMAIN_MAP.md` — 21-domain boundary definitions
- `DECISION_REGISTER.md` — Frozen architectural decisions (D01–D10)

## Current State

**Construction Block 001 — Engineering Foundation** (Domain 21: Shared Platform Infrastructure)

This block provides:
- Monorepo skeleton with Turborepo
- PostgreSQL via Prisma with migration tooling
- Transactional outbox pattern (atomic event publishing)
- BullMQ job processing with retry/backoff/dead-letter
- CI pipeline (GitHub Actions)

No domain business logic is implemented yet. Steps 3+ are gated on open decisions (see CONTRIBUTING.md).
