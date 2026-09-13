# Completed Construction Blocks

## CONSTRUCTION-001 — Engineering Foundation
- **Build Sequence Step:** 2
- **Domain:** 21 — Shared Platform Infrastructure
- **Completed:** 2026-09-13
- **Scope:** Monorepo skeleton (pnpm + Turborepo), PostgreSQL via Prisma (outbox_event + health_check tables), transactional outbox with relay loop, BullMQ job pipeline with retry/backoff/dead-letter, CI pipeline (GitHub Actions with Postgres 16 + Redis 7), health endpoints on both apps.
- **What it did NOT include (by design):** No domain business logic, no auth/sessions, no curriculum content, no user-facing features. Those belong to steps 3+.
- **ACR required:** No. Nothing deviated from frozen architecture.
