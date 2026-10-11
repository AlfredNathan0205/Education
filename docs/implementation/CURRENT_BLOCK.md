# Current Block

## Status: IN_PROGRESS

**CONSTRUCTION-002 — Identity & Privacy Skeleton** (Build Sequence step 3). See [`CONSTRUCTION-002_INTERPRETATION.md`](./CONSTRUCTION-002_INTERPRETATION.md).

Authorized by the PM on 2026-10-11, scoped to the parts that hold under every plausible legal outcome.

## Progress (code complete on branch `build-series-002-004`)

Done: Prisma models for 01a/01b/01c plus minimal `student` and `audit_event`; pure domain logic with unit tests; `IdentityService` (passwordless OTP, sessions) and `PrivacyService` (policy activation gate, age classification, consent grant/withdraw/evaluate), each with mocked-database tests. `AuthzService` (role grant/revoke/list with SUPER_ADMIN authorization) and `CurriculumAdminService` (account-based facade that resolves roles from the database).

### Items resolved in this pass (2026-10-11)

1. **Migration generated and deployed.** `20261011195403_identity_privacy_curriculum_authz` includes all Block 002, 003, and authorization tables. Two partial unique indexes appended manually:
   - `jurisdiction_policy_one_active_per_jurisdiction` — one ACTIVE per jurisdiction
   - `curriculum_subject_version_one_live` — one live (ACTIVE/ACTIVE_WITH_REVIEW) revision per unit
   Both verified against a fresh database (`db:migrate:deploy` from scratch).

2. **Build and typecheck green.** `pnpm run build` and `pnpm run typecheck` pass across all four packages. No type errors introduced by the patch.

3. **Unit tests green.** 282 tests pass across 17 suites (identity, privacy, curriculum state machine, curriculum validation, curriculum service, authz service, authz roles, roles CLI, student, UAE policy, consent evaluator, age classification, identifier, OTP, jurisdiction policy, policy CLI). `app.module.spec.ts` (from CONSTRUCTION-001) fails due to Prisma query engine incompatibility on Windows ARM64 — pre-existing, not a regression.

4. **Real-database integration tests written.** `apps/api/src/integration/services.integration.spec.ts` covers:
   - **IdentityService:** OTP request/verify, account creation, session auth, revocation, wrong-code rejection
   - **PrivacyService:** policy draft/review/activate lifecycle, one-ACTIVE index enforcement, age classification with supersede, DOB never in outbox/audit, fail-closed without ACTIVE policy, consent grant and withdraw
   - **AuthzService:** operator bootstrap grant, idempotent re-grant, SUPER_ADMIN can grant to others, non-SUPER_ADMIN refused, revoke + list, operator required for null actor, findAccountId
   - **CurriculumService:** full lifecycle to ACTIVE, correction revision superseding, one-live-revision index rejection, getActiveTree
   - **CurriculumAdminService:** account with no role refused, EDITOR can create but not approve, full EDITOR→REVIEWER→APPROVER lifecycle to ACTIVE

   Run with `pnpm --filter @exam-app/api test:integration`. CI step added to `.github/workflows/ci.yml`.

### Items NOT yet verified (blocked by local environment)

5. **Integration tests not run locally.** The local machine is Windows ARM64; Prisma 6.19.3 ships only an x86-64 query engine DLL, which cannot load at runtime. The tests are written, the CI step is added, and they will execute on CI (ubuntu-latest x86-64). This does not affect the migration CLI or unit tests — only runtime PrismaClient usage.

6. **End-to-end browser walkthrough not performed.** Same Prisma engine blocker prevents starting the API locally. The web app builds (`next build` passes), and the API builds (`nest build` passes), but neither can serve requests on this machine.

7. **Role assignment via CLI not exercised.** The `roles` CLI and the two test accounts (alfredsunil@gmail.com, alfred@nevodia.com) were not tested end-to-end. The CLI's unit tests pass (roles-cli.spec.ts).

### Still required before this block can be marked COMPLETED

1. ~~Generate the migration~~ — **done** (2026-10-11).
2. **CI green** on the pull request — integration tests added but not yet run (awaiting CI).
3. ~~A real-database test pass~~ — **tests written** (2026-10-11), **not yet run** (blocked locally, will run on CI).
4. ~~PM ratification of D11~~ — **done** (2026-10-11).
5. **Counsel's values** — UAE policy v1 prepared as `apps/api/policy-templates/ae.v1.json` but deliberately NOT loaded or activated. Activating it blocks the DOB step until a verification flow exists (see `docs/decisions/UAE_POLICY_V1.md`). Until activated, every student is treated as a minor needing guardian consent.
6. **Lint:** web app (`@exam-app/web`) has no ESLint config — `next lint` prompts interactively. Pre-existing issue from CONSTRUCTION-001.

## Blockers, and how they are handled

1. **UAE child-data regime — counsel's values RECEIVED (2026-10-11), policy v1 prepared but NOT loaded or activated.** See [`../decisions/UAE_POLICY_V1.md`](../decisions/UAE_POLICY_V1.md). Activating it blocks the date-of-birth step until a verification flow exists. The system fails closed without an ACTIVE policy.
2. **Consent/age ownership — RESOLVED, ratified by the PM** by [`../decisions/D11_CONSENT_STATE_OWNERSHIP.md`](../decisions/D11_CONSENT_STATE_OWNERSHIP.md) (sub-module 01b under Domain 01).

## Also on this branch (code complete, not a completed block)

- **CONSTRUCTION-003 — Curriculum Governance machinery.** See [`CONSTRUCTION-003_INTERPRETATION.md`](./CONSTRUCTION-003_INTERPRETATION.md). Migration done, partial unique index added, integration tests written (including CurriculumAdminService with role-based access). Needs CI pass and the syllabus source / approver before anything can be activated.

- **CONSTRUCTION-004 — Student web slice (first cut).** See [`CONSTRUCTION-004_INTERPRETATION.md`](./CONSTRUCTION-004_INTERPRETATION.md). Welcome, sign-in, profile with age gate. Web builds successfully. E2E not performed (Prisma ARM64 blocker).

- **Authorization — role assignment resolved from the database.** AuthzService, CurriculumAdminService, roles CLI. Unit and integration tests written.

## Still gated, not part of this block

- Activating any ICSE Grade 8 curriculum, and the AI Question Factory (step 8), remain gated on the ICSE Grade 8 syllabus source / human approver details.
- Any age-verification UX and mandatory-method decision wait on counsel.
- Activating the UAE policy is the PM's decision (see UAE_POLICY_V1.md blockers).

## Previous Block

CONSTRUCTION-001 — Engineering Foundation — **COMPLETED** (2026-09-13). See `COMPLETED_BLOCKS.md`.
