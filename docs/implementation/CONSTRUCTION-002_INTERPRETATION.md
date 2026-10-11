# Implementation Interpretation — CONSTRUCTION-002: Identity & Privacy Skeleton

**Build Sequence step:** 3 · **Domains:** 01 (Identity & Access, sub-modules 01a/01b/01c), stubs of 02 and 20
**Authorized by:** PM instruction 2026-10-11 ("lets start building"), on the basis of `D11` and a narrowed Blocker 01.

## Design rule: legal answers live in data, never in code

Counsel has not yet confirmed the child-data rules (age thresholds, Article 8 age-verification mechanics, guardian-consent mechanics). So Block 002 builds only what holds under every plausible legal outcome, and puts everything legal into versioned policy data.

1. **Thresholds come from `jurisdiction_policy.config`**, not constants in code.
2. **Fail closed.** With no ACTIVE policy for a jurisdiction, or one with null thresholds, the student is classified as a minor who requires guardian consent. The conservative answer never depends on the legal answer.
3. **Activation is gated.** A policy cannot become ACTIVE unless `legal_review = COUNSEL_REVIEWED` and its config is complete. This turns the legal gate into a code-level guard.
4. **Verification method is a field, not a decision.** `dob_evidence_method` and `guardian_verification.method` are open strings, validated against the policy's accepted-methods list when one exists. No method is hard-coded as mandatory.
5. **Consent is purpose-specific, versioned, append-only.** Withdrawal is a separate record. Active consent is derived, never edited.

## In scope

- Prisma models for 01a, 01b, 01c, minimal `student`, minimal `audit_event`.
- Pure, unit-tested domain logic: identifier normalization, OTP generation/hashing/attempt evaluation, age classification, consent evaluation, policy-activation guard.
- NestJS services: passwordless OTP request/verify (with a sender port), session creation, age classification recording, consent grant/withdraw. Every state change writes an outbox event and an audit event in the same transaction.
- Enumeration protection: OTP request returns the same response whether or not the identifier exists. Per-identifier cooldown and per-challenge attempt cap.

## Explicitly NOT in scope

- Choosing a mandatory age-verification method, or any consent UX or guardian-invite flow (waits on counsel).
- Seeding a real jurisdiction policy. UAE and India policies must be authored with counsel and are not invented here.
- Per-IP rate limiting, MFA for privileged roles, authorization evaluation logic (role/permission tables only), privacy-request / deletion sagas, SMS/email provider integration.
- Real OTP delivery. The only sender is a development console sender that refuses to run when `NODE_ENV=production`.

## Known follow-ups for the migration step

- Generate the migration on a machine with Postgres and Prisma engines: `pnpm --filter @exam-app/database db:migrate:dev --name identity_privacy_skeleton`.
- Add a partial unique index so at most one `jurisdiction_policy` per jurisdiction is ACTIVE (Prisma cannot express this): `CREATE UNIQUE INDEX ... ON jurisdiction_policy (jurisdiction_code) WHERE status = 'ACTIVE';`. The service also enforces it inside a transaction.

## ACR needed?

No. D11 is a clarification of ownership inside the existing map, not a change to frozen architecture.
