# Step 10: Assessment blueprints and assembly

Spec rule: **Blueprint != Instance**. A blueprint version is the design of a kind of test (how many questions, the difficulty
mix, which chapters, what must be covered). An instance is one student's locked test built from it. A published version is
never edited; a change is a new version. Every assembly is recorded, with one decision per question and the list of anything
that had to be relaxed.

Written without the frozen spec in hand (it was not attached in this session), from the build handover. Table and column
names follow the canonical table names the handover lists; **columns are my design and may need renaming against
`modules/*.md` / `architecture/*.md`.**

## Built
- **Tables** (`assessment_blueprint`, `assessment_blueprint_version`, `blueprint_scope`, `blueprint_difficulty_requirement`,
  `blueprint_type_requirement`, `blueprint_cell_requirement`, `assessment_assembly_run`, `assessment_assembly_decision`).
  At most one PUBLISHED and one DRAFT version per blueprint (partial unique indexes), plus CHECK constraints on counts.
  The extra SQL is in `CONSTRUCTION-010_BLUEPRINT_MIGRATION_EXTRA.sql` and must be appended to the generated migration.
- **Seeds (in the migration):**
  - `QUICK10` v1: **published and on**. It has the same numbers as the code before this step: 10 questions (5 easy / 3 medium / 2 hard), whole subject, unseen questions preferred, opening with an easy one. Nothing changes for students.
  - `SUBJECT20` v1: a **draft, and off**. The 8 / 7 / 5 split is a guess (see 2 below).
  - `SUBJECT25`: **off, with no version**. The spec builds it only when content readiness permits.
- **Assembly engine** (`apps/api/src/assembly/assembly-engine.ts`, pure, seeded). It replaces the hard-coded `assembleQuick10` (kept as a thin wrapper for the old tests, which all still pass). The order is:
  1. Remove duplicates and wrong question types, and keep to the scope.
  2. Meet the cell minimums, scarcest cell first, without breaking the difficulty mix.
  3. Fill the difficulty mix, scarcest band first.
  4. Fill a short band from the nearest band.
  5. Shuffle with the seed, then put the opening difficulty first.

  Candidates are ranked in this order:
  - in scope
  - not seen before
  - bank health (a question on WATCH goes last; DEGRADED is never served, as in Step 9)
  - a chapter not used yet
  - an objective not used yet
  - a cognitive level not used yet
  - least recently seen
  - **the seeded tie-break last**

  Each decision records why the question was chosen: UNSEEN, NEW_CHAPTER, NEW_COGNITIVE, OUT_OF_SCOPE, HEALTH_WATCH, TIE_BREAK_RANDOM and so on, plus how many questions were eligible for that slot.
- **Relaxations recorded.** Each assembly lists every place it could not follow the design exactly:
  - DIFFICULTY_SUBSTITUTED: a difficulty slot was filled from another difficulty.
  - CELL_MINIMUM_UNMET: a cell rule's minimum was not reached.
  - SCOPE_WIDENED: questions came from outside the scope.
  - SEEN_QUESTIONS_USED: questions the student had seen were used.
  - HEALTH_WATCH_USED: questions on WATCH were used.
- **Exam engine.** Tests are built from the **published version** of a **switched-on** blueprint that applies to the subject.
  - Quick 10 is the default. `POST /exam/assessments` accepts an optional `blueprint` code.
  - Each instance records the code and version, and gets an assembly run.
  - A resumed test must match the blueprint as well as the mode and subject.
  - `GET /exam/units` now lists the `tests` each subject offers.
  - Fail-closed: no published or switched-on QUICK10 means no Quick 10.
- **Scope.**
  - *Whole subject.*
  - *Listed chapters*: the blueprint must be bound to one subject, and the chapters are checked against that subject's curriculum when saved and when published.
  - *The student's chosen chapters* (Step 5).

  A **strict** scope never leaves its chapters; too few questions means no test. A **loose** scope substitutes a difficulty before leaving its chapters, and widens only when they hold too few questions. A strict focus test with no chapters chosen asks the student to choose some.
- **Admin API** (`/admin/blueprints`): list, detail, create (switched off, draft v1), save draft (replace the open draft or open the next version), discard draft, publish draft (retires the published version), switch on/off (needs a published version), and **preview**.
  - The preview is read-only and needs no student: what a version would build for a subject now, with the reasons and relaxations, reproducible by seed.
  - Audit events and a `blueprint.version_published.v1` outbox event are written.
- **Screen:** `/admin/blueprints`. Edit the design (mix, scope, strict, prefer unseen, first question, cell rules, notes), publish or discard, switch on or off, and preview against any subject.

## Assumptions and open decisions (please confirm)
1. **Three difficulty levels, not D1-D5.** The bank has EASY / MEDIUM / HARD; blueprints store (level, count) rows, so moving to
   five levels later is a new enum value and data, not new assembly code.
2. **SUBJECT20 split 8 / 7 / 5 is a guess.** The spec's 3/5/6/4/2 grouped D1+D2 / D3 / D4+D5 gives 8/6/6; I moved one from hard to
   medium. It is seeded as a draft and switched off until you confirm it.
3. **Who does what.** Anyone with a curriculum role (editor and up) may draft and preview; only an approver or super admin publishes a
   version or switches a blueprint on or off (the same people who publish questions). No separate "assessment designer" role.
4. **No four-eyes rule on publishing a design.** The person who drafted it may publish it if they are an approver. Say if you want one.
5. **Exposure ranks above bank health.** An unseen question on WATCH is chosen over a healthy one the student has seen.
6. **Loose scope substitutes a difficulty before widening.** My choice: a student who chose chapters sees those chapters, even if the
   mix bends. Strict scope never widens.
7. **Cognitive "balancing" is only spread.** C1-C4 have no agreed meaning yet, so the engine only avoids repeating a level when it
   can, and cell rules can ask for "at least N at C3". No quality judgement is made on cognitive levels.
8. **Scoring policy name.** Quick 10 results keep `QUICK10_V1`; other blueprints are scored the same way (one mark per correct
   locked answer) under `ONE_MARK_PER_CORRECT_V1`. Competitive scoring is Step 15.
9. **Failed assemblies are not stored.** "Not enough questions" is returned to the student and shown in the preview, but no run row
   is written (the transaction rolls back). Content readiness (Step 21) may want these counted.
10. **Turning a blueprint off does not end open tests.** Tests already started keep running on their own instance.
11. **At most 50 questions per blueprint** (the proxy allows two-digit question positions).

## Not built
- `assessment_equivalence_policy` and equivalence between instances: reasoning and scenario families (R01-R16) are not in the
  bank, so there is nothing to make equivalent yet.
- Subject Test 25 content readiness gating: the blueprint exists and is off; readiness rules arrive with Step 21.
- A student screen to choose SUBJECT20 or other tests (the API supports it; the student web slice is Step 12).
- An operator command for blueprints (everything goes through the signed-in screen, so each change is tied to a role).

## Checks done here
Unit tests (fake Prisma) for the engine, the blueprint rules, the service, both controllers and the exam service's use of
blueprints; all earlier exam tests pass unchanged. Typecheck clean apart from the known Prisma-untyped codes. Schema checked
with the WASM validator. The extra migration SQL (partial indexes, checks, seeds) was run against a throwaway PostgreSQL 18 (the npm build available here; production is 16, and nothing used is new in 17 or 18)
with hand-written tables: seeds load, a second PUBLISHED or DRAFT version is refused, a 0-question version is refused.
**Not run here:** the generated migration, the integration tests and the screen in a browser. Those need Docker or CI.
