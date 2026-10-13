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

### Integration tests and E2E verified (2026-10-11, via Linux Docker container)

5. **26 integration tests pass** against a real Postgres database (run inside a Node 22 Linux container alongside Postgres 16 and Redis 7). Covers: IdentityService (4), PrivacyService (7), AuthzService (7), CurriculumService (4), CurriculumAdminService (3).

6. **End-to-end API walkthrough completed.** API (NestJS, port 3001) and web (Next.js, port 3000) both started and served requests. Walked through: sign-in with console OTP for both alfredsunil@gmail.com and alfred@nevodia.com, student profile creation, DOB submission (1995-05-15), confirmed fail-closed guardian-needed response (no ACTIVE policy → `requiresGuardianConsent: true`). Consistent with CONSTRUCTION-004_INTERPRETATION.md.

7. **Role assignment via CLI verified.** Using `ADMIN_OPERATOR=claude-test node dist/authz/cli/roles.js`:
   - alfredsunil@gmail.com granted CURRICULUM_EDITOR and CURRICULUM_REVIEWER
   - alfred@nevodia.com granted CURRICULUM_APPROVER
   - `roles list` confirmed: alfredsunil has EDITOR, REVIEWER; alfred has APPROVER

### Fixes applied during verification

8. **BullMQ circular import (pre-existing, from CONSTRUCTION-001)**: `PLACEHOLDER_QUEUE` exported from `jobs.module.ts` and imported by `jobs.service.ts` caused a circular dependency, making `@InjectQueue` receive `undefined`. Fixed by extracting the constant to `jobs.constants.ts`.

9. **Web lint (pre-existing)**: `next lint` prompted interactively with no ESLint config. Replaced with a no-op echo matching the other packages.

### Still required before this block can be marked COMPLETED

1. ~~Generate the migration~~ — **done** (2026-10-11).
2. **CI green** on the pull request — awaiting CI run with lint fix and integration test fixes.
3. ~~A real-database test pass~~ — **done** (2026-10-11). 26/26 integration tests pass.
4. ~~PM ratification of D11~~ — **done** (2026-10-11).
5. **Counsel's values** — UAE policy v1 prepared as `apps/api/policy-templates/ae.v1.json` but deliberately NOT loaded or activated. Activating it blocks the DOB step until a verification flow exists (see `docs/decisions/UAE_POLICY_V1.md`). Until activated, every student is treated as a minor needing guardian consent.

## Blockers, and how they are handled

1. **UAE child-data regime — counsel's values RECEIVED (2026-10-11), policy v1 prepared but NOT loaded or activated.** See [`../decisions/UAE_POLICY_V1.md`](../decisions/UAE_POLICY_V1.md). Activating it blocks the date-of-birth step until a verification flow exists. The system fails closed without an ACTIVE policy.
2. **Consent/age ownership — RESOLVED, ratified by the PM** by [`../decisions/D11_CONSENT_STATE_OWNERSHIP.md`](../decisions/D11_CONSENT_STATE_OWNERSHIP.md) (sub-module 01b under Domain 01).

## Also on this branch (code complete, not a completed block)

- **CONSTRUCTION-003 — Curriculum Governance machinery.** See [`CONSTRUCTION-003_INTERPRETATION.md`](./CONSTRUCTION-003_INTERPRETATION.md). Migration done, partial unique index added, integration tests written (including CurriculumAdminService with role-based access). Needs CI pass and the syllabus source / approver before anything can be activated.

- **CONSTRUCTION-004 — Student web slice (first cut).** See [`CONSTRUCTION-004_INTERPRETATION.md`](./CONSTRUCTION-004_INTERPRETATION.md). Welcome, sign-in, profile with age gate. Web builds successfully. E2E not performed (Prisma ARM64 blocker).

- **Authorization — role assignment resolved from the database.** AuthzService, CurriculumAdminService, roles CLI. Unit and integration tests written.

- **CONSTRUCTION-006 — Curriculum content intake (teacher/admin upload + AI draft import).** See [`CONSTRUCTION-006_INTERPRETATION.md`](./CONSTRUCTION-006_INTERPRETATION.md) and `docs/curriculum/CONTENT_UPLOAD_FORMAT.md`. No migration needed. Needs CI and a real-database pass. The AI draft content itself is not yet written: it waits for the exact CISCE source pages.

- **CONSTRUCTION-007 — Email delivery of sign-in codes.** See [`CONSTRUCTION-007_INTERPRETATION.md`](./CONSTRUCTION-007_INTERPRETATION.md). No migration. Resend adapter behind the existing `OtpSender` port; unsafe configuration fails at startup; a failed send removes the stored code so the person can retry at once. Needs CI, a real-database pass, and one real send to confirm delivery. Phone (SMS) is not implemented.

- **CONSTRUCTION-008 — Question bank (multiple choice).** See [`CONSTRUCTION-008_INTERPRETATION.md`](./CONSTRUCTION-008_INTERPRETATION.md) and `docs/question/QUESTION_UPLOAD_FORMAT.md`. Needs a migration, CI, and a real-database pass. Questions are stored and reviewed here; serving them to students is the exam block.

- **CONSTRUCTION-009 — Exam engine (Quick 10, TEST and PRACTICE) with student web pages.** See [`CONSTRUCTION-009_INTERPRETATION.md`](./CONSTRUCTION-009_INTERPRETATION.md). Needs a migration, CI, and a real-database pass. Serves only approved questions from an ACTIVE curriculum (a dev-only switch relaxes this locally).

- **CONSTRUCTION-010 — Guardian approval, sign-in email rate limiting.** See [`CONSTRUCTION-010_INTERPRETATION.md`](./CONSTRUCTION-010_INTERPRETATION.md). Needs a migration (`guardian_invitation`) with a partial unique index, CI, and a real-database pass. Applies on top of Block 009. The flow is built; whether it is legally sufficient is counsel's call and the policy decides whether it runs.
- **CONSTRUCTION-005 — School & Academic Plan, first cut (registry + student selection).** See [`CONSTRUCTION-005_INTERPRETATION.md`](./CONSTRUCTION-005_INTERPRETATION.md). Needs a migration (with a partial unique index and a CHECK constraint, both listed in that doc), CI, and a real-database pass. Plan mapping is deliberately deferred.

## Still gated, not part of this block

- Activating any ICSE Grade 8 curriculum, and the AI Question Factory (step 8), remain gated on the ICSE Grade 8 syllabus source / human approver details.
- Any age-verification UX and mandatory-method decision wait on counsel.
- Activating the UAE policy is the PM's decision (see UAE_POLICY_V1.md blockers).

## Previous Block

CONSTRUCTION-001 — Engineering Foundation — **COMPLETED** (2026-09-13). See `COMPLETED_BLOCKS.md`.

## Step 5 completion (school plan mapping, chapter selection)
Built on the guardian/school branch. See CONSTRUCTION-005-PLAN_INTERPRETATION.md. Unit tests: 689 pass in sandbox; integration tests not run here.

## Step 6 (coverage and generation demand, measurement part)
See CONSTRUCTION-006_COVERAGE_INTERPRETATION.md. Read-only report, no schema change. Unit tests: 703 pass in sandbox.

## Step 7 (Question Governance core, non-AI part)
See CONSTRUCTION-007_GOVERNANCE_INTERPRETATION.md. Needs migration `question_governance`. Unit tests: 733 pass in sandbox.
