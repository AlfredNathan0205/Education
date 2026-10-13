# CONSTRUCTION-005 — School & Academic Plan, first cut (Build Sequence step 5, partial)

**Status:** code complete on branch `construction-005-school-registry`; not a completed block. Authorized scope chosen by the PM on 2026-10-13: **registry + student selection**, admin-entered school list. Term/chapter plan mapping is deliberately NOT in this block.

## Spec basis

`docs/modules/SCHOOL_ACADEMIC_PLAN.md`: registry of school/branch/alias/geography/candidates kept separate from curriculum; association states UNVERIFIED, STUDENT_SELECTED, VERIFIED, SCHOOL_CONFIRMED; student may self-select without a verified plan; leaving or changing school preserves learner history. Invariants: official curriculum != school academic plan; **no school access merely from a student-selected association**; no exact location.

## What exists

- **Schema:** `school`, `school_alias`, `school_branch`, `school_candidate`, `student_school_association` (append-only history), `student_academic_context` (curriculum + grade the student states).
- **Operator CLI** (`node apps/api/dist/school/cli/schools.js`, needs `ADMIN_OPERATOR`): `add`, `alias`, `branch`, `retire`, `list`, `candidates`, `accept`, `reject`. Nothing is imported or invented; every school is typed in by a person, and every change is audited with the operator's name.
- **Student API** (session-guarded, own student only): `GET /students/me/academic`, `PUT /students/me/grade`, `POST /students/me/schools/search`, `PUT /students/me/school`, `POST /students/me/school/leave`.
- **Web:** after the name step, a grade step, an optional school step (search, "my school is not listed", skip), then Ready with a summary and "I have left this school".

## Builder decisions (please confirm or change)

1. **Student choice never produces more than STUDENT_SELECTED.** A registry pick is STUDENT_SELECTED; free text is stored as a PENDING `school_candidate` and the association stays UNVERIFIED. VERIFIED and SCHOOL_CONFIRMED have no route in this block (they need verification flows that do not exist). `associationGrantsSchoolAccess` is `false` for every state and is tested.
2. **Collection is fail-closed like the display name.** Setting grade or school returns 403 while guardian consent is required (`StudentService.studentIdForDataCollection`). Reading your own academic state is allowed. This is data minimisation chosen by the builder, not a legal conclusion; counsel may say school/grade is fine to collect earlier.
3. **Launch cohort is code:** `LAUNCH_COHORT` = ICSE / GRADE_8 (the PM's stated launch scope). Any other curriculum or grade returns 422. Widening it is a reviewed code change. It is the student's own, unverified statement; it is not linked to the curriculum tables, because no curriculum is ACTIVE yet.
4. **Admin resolution of free text.** `accept` makes the text an alias of a chosen registry school and moves only OPEN associations onto that school (STUDENT_SELECTED). `reject` ends open associations (reason `CANDIDATE_REJECTED`) so the student can choose again. Ended rows are history and are never rewritten.
5. **Coarse geography only:** country code (2 letters) and optional city name. City text that looks like coordinates or addresses is refused.
6. **Free text and names stay out of events/audit.** Events and audit rows carry ids and the state only.
7. **School search** returns ACTIVE schools of `DEFAULT_JURISDICTION` only, max 20, over a restricted alphabet (no `%`/`_`), as a bound parameter.
8. **Skipping the school step stores nothing** (the student is asked again next visit unless they add one). No "independent / no school" state exists yet.
9. **Country of a student-typed school** is taken from `DEFAULT_JURISDICTION`, the same placeholder as the age policy (per-student jurisdiction is still a follow-up).

## Migration requirements (the sandbox cannot generate it)

On a machine with Postgres: `pnpm --filter @exam-app/database db:migrate:dev --name school_registry`, then add to the generated SQL:

```sql
-- at most ONE open association per student
CREATE UNIQUE INDEX student_school_association_one_open_per_student
  ON student_school_association (student_id) WHERE ended_at IS NULL;

-- exactly one of school_id / candidate_id is set
ALTER TABLE student_school_association
  ADD CONSTRAINT student_school_association_school_xor_candidate
  CHECK ((school_id IS NOT NULL) <> (candidate_id IS NOT NULL));
```

The code relies on both: a concurrent double-submit makes the second insert fail with a unique violation, which the controller maps to 409 "please try again".

## Verification

Unit tests (fake Prisma client) cover the domain rules, both services, the CLI, input parsing and the new `StudentService` gate. Prisma schema validated with the Prisma schema validator. Web `tsc` passes. Module wiring checked with a throwaway Nest test (removed). **Not run here:** real-database tests of the new tables, the partial unique index, the web in a browser against the real API. Those need Docker or CI.

## Not in this block

Academic-year/term/assessment plan mapping (needs Grade 8 chapters and an ACTIVE curriculum); school verification and school-confirmed associations; school-side reporting authority (REPORTING_AUTHORIZED, MANAGED_ACCOUNT); geography beyond country/city; moderation of student-typed names beyond the alphabet check.
