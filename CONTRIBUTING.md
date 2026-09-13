# Contributing

## Build Sequence

This repo follows a strict build sequence. Each block must be completed and verified before the next begins.

| Block | Step | Description | Status |
|-------|------|-------------|--------|
| 001 | 2 | Engineering Foundation | In Progress |
| 002 | 3 | Identity & Privacy Skeleton | Blocked (UAE PDPL scoping) |
| 003 | 4 | Curriculum Governance | Blocked (syllabus source) |
| 004 | 5 | Content Modeling | Pending |
| 005 | 6 | Assessment Engine Core | Pending |
| 006 | 7 | Question Governance | Pending |
| 007 | 8 | AI Question Factory | Pending |
| 008 | 9 | Question Bank & Publication | Pending |
| 009 | 10+ | Competition, Mastery, Social | Pending |

## Domain Boundaries

Each of the 21 domains from `DOMAIN_MAP.md` owns its state exclusively. When adding code:

1. Identify which domain owns the state you're writing to.
2. Place your module under that domain's boundary within `apps/api/src/`.
3. Never write to another domain's tables directly — use the transactional outbox to emit events that the owning domain consumes.

## Database Changes

All schema changes go through Prisma migrations. No direct SQL against production.

```bash
# Create a migration after editing schema.prisma
pnpm --filter @exam-app/database db:migrate:dev --name descriptive_name
```

## Open Blocking Questions

These must be resolved before their respective blocks can begin:

1. **UAE PDPL / India DPDP Act scoping** — Which consent and child-data regime governs Release 1? Blocks Block 002.
2. **ICSE Grade 8 syllabus source** — Who acquires/licenses the curriculum content and who are the human academic approvers (H1/H2)? Blocks Block 003.
