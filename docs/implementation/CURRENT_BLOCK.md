# Current Block

## Status: IN_PROGRESS

**CONSTRUCTION-002 — Identity & Privacy Skeleton** (Build Sequence step 3). See [`CONSTRUCTION-002_INTERPRETATION.md`](./CONSTRUCTION-002_INTERPRETATION.md).

Authorized by the PM on 2026-10-11, scoped to the parts that hold under every plausible legal outcome.

## Progress (code complete on branch `construction-002-identity-privacy`; NOT yet complete as a block)

Done: Prisma models for 01a/01b/01c plus minimal `student` and `audit_event`; pure domain logic with unit tests; `IdentityService` (passwordless OTP, sessions) and `PrivacyService` (policy activation gate, age classification, consent grant/withdraw/evaluate), each with mocked-database tests.

Still required before this block can be marked COMPLETED:

1. **Generate the migration** on a machine with Postgres and Prisma engines: `pnpm --filter @exam-app/database db:migrate:dev --name identity_privacy_skeleton`, then add the partial unique index described in `CONSTRUCTION-002_INTERPRETATION.md`. No migration exists yet, so none of the new tables exist in any database.
2. **CI green** on the pull request. The Prisma schema and the type-checking of the DB-backed services were only validated by CI's `prisma generate` + `typecheck`; they could not be run in the authoring environment.
3. **A real-database test pass** of the services (the existing tests use an in-memory fake of the Prisma client and do not exercise SQL).
4. ~~PM ratification of D11~~ — **done** (2026-10-11). Register entry in the spec repository still to add.
5. **Counsel's values** loaded through `apps/api/src/privacy/cli/policy.ts` (`draft`, `review`, `activate`). Until then no policy is ACTIVE and every student is treated as a minor needing guardian consent.

## Blockers, and how they are handled

1. **UAE child-data regime — still OPEN, awaiting counsel.** Two UAE federal laws apply (PDPL 45/2021 + Child Digital Safety 26/2025); see [`../decisions/BLOCKER_01_UAE_CHILD_DATA_REGIME.md`](../decisions/BLOCKER_01_UAE_CHILD_DATA_REGIME.md). Block 002 does not guess: thresholds and verification methods live in versioned policy data, the system fails closed (treat as minor, guardian consent required) without an ACTIVE policy, and no policy can be activated until marked counsel-reviewed.
2. **Consent/age ownership — RESOLVED, ratified by the PM** by [`../decisions/D11_CONSENT_STATE_OWNERSHIP.md`](../decisions/D11_CONSENT_STATE_OWNERSHIP.md) (sub-module 01b under Domain 01). 

## Also on this branch (code complete, not a completed block)

- **CONSTRUCTION-003 — Curriculum Governance machinery.** See [`CONSTRUCTION-003_INTERPRETATION.md`](./CONSTRUCTION-003_INTERPRETATION.md). Needs the same migration, CI and real-DB pass as 002, plus the partial unique index listed there, and the syllabus source / approver before anything can be activated.

- **CONSTRUCTION-004 — Student web slice (first cut).** See [`CONSTRUCTION-004_INTERPRETATION.md`](./CONSTRUCTION-004_INTERPRETATION.md). Welcome, sign-in, profile with age gate. Verified in a browser against a stand-in API only.

## Still gated, not part of this block

- Activating any ICSE Grade 8 curriculum, and the AI Question Factory (step 8), remain gated on the ICSE Grade 8 syllabus source / human approver details (the machinery exists; the content and approver do not).
- Any age-verification UX and mandatory-method decision wait on counsel.

## Previous Block

CONSTRUCTION-001 — Engineering Foundation — **COMPLETED** (2026-09-13). See `COMPLETED_BLOCKS.md`.
