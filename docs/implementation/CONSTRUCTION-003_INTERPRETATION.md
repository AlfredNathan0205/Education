# CONSTRUCTION-003 — Curriculum Governance machinery (Build Sequence step 4)

**Status:** code complete on branch; not complete as a block (see CURRENT_BLOCK.md).

## What this block is

The machinery that lets a curriculum become canonical: data model, lifecycle state machine, automated structural validation, evidence packs, review/approval/activation, and revisioning. It contains **no syllabus content**. Nothing about ICSE Grade 8 is seeded; the syllabus source and human approver are still to be supplied by the PM (see Inputs needed).

## Spec rules and where they are enforced

| Rule (CURRICULUM_GOVERNANCE.md / STATE_MACHINES.md) | Enforced in |
| --- | --- |
| Approval unit = Curriculum + Version + Grade + Subject | `curriculum_subject_version` unique on (version, grade, subject, revision) |
| Evidence Pack required; provenance values | `curriculum_evidence_pack`, `curriculum_provenance`; validator `MISSING_EVIDENCE`, `UNKNOWN_EVIDENCE`, `EVIDENCE_PACK_EMPTY` |
| Automated validation precedes human review | No transition `DRAFT -> ADMIN_REVIEW`; `VALIDATED` is reachable only by the SYSTEM via `runValidation` |
| APPROVED is not ACTIVE; only authorized human activation | Separate `approve` and `activate`; `activate` is `humanOnly`, APPROVER/SUPER_ADMIN; AI and SYSTEM refused |
| Material edit after validation reopens validation | `stateAfterEdit`: VALIDATED / ADMIN_REVIEW / APPROVED -> VALIDATION_PENDING. Evidence changes also reopen and un-verify the pack |
| Activated version is immutable; correction creates a new version | `canEditContent` false from ACTIVE on; `createCorrectionRevision` copies to a new DRAFT revision |
| Evidence packs verified before activation | `activate` refuses unless the pack is VERIFIED by a human |
| School plans may reference only ACTIVE canonical curriculum | `getActiveTree` returns only `ACTIVE`, else null |

## Builder choices to confirm (not stated in the spec)

1. **Every content edit is treated as material.** The builder does not decide what counts as a minor syllabus edit.
2. **Evidence verification is a human attestation** by REVIEWER/APPROVER/SUPER_ADMIN with a required note. A correction revision copies evidence but it must be verified again.
3. **Non-official provenance** (SYSTEM_DERIVED, ADMIN_ADDED) is allowed but yields a reviewer WARNING; any non-EXPLICIT node needs a rationale.
4. **`ACTIVE_WITH_REVIEW` and `SUSPENDED`** are modelled but `getActiveTree` serves only strict `ACTIVE`. Whether a suspended or under-review curriculum should keep serving is a product decision.
5. **No separation-of-duties rule** (e.g. approver must differ from last editor) is enforced, because a one-person team would be blocked. Recommend revisiting before a second staff member exists. `last_edited_by` is stored so the rule can be added.
6. Actor ids carry no foreign key to `account`, so curriculum governance does not depend on 01a rows.

## Not in this block

- HTTP endpoints. The authorization layer (01c) is not wired to HTTP, so roles arrive as an in-process `CurriculumActor`. When endpoints are added, the role must be resolved from `role_assignment`, never from the request body.
- An AI research pipeline. The AI actor type exists only so the rules are testable.
- Schema-level guard that two revisions are never live at once. Prisma cannot express it; add to the migration:

```sql
CREATE UNIQUE INDEX curriculum_subject_version_one_live
  ON curriculum_subject_version (curriculum_version_id, grade_id, subject_id)
  WHERE state IN ('ACTIVE', 'ACTIVE_WITH_REVIEW');
```

## Verification

- Prisma schema (all of Blocks 002 and 003) validated locally with the Prisma schema validator shipped for the pinned engine version: **VALID**. This is a parse/validate check, not a migration.
- 66 unit tests for the state machine, validator and service (service tests use an in-memory fake, so SQL is not exercised).
- CI (`prisma generate`, typecheck, tests) and a real-database test pass are still required.

## Inputs needed from the PM

- ICSE Grade 8 2026-27 syllabus source(s) and the named human approver.
- No evidence pack can be verified, and nothing can be activated, until these exist.
