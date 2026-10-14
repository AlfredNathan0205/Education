# Step 11: Assessment execution (finishing)

Most of execution was built with the exam engine (CONSTRUCTION-009): one question at a time, lock, skip and revisit once, submit with "Review skipped / Submit anyway", deterministic scoring, expiry, full review after the result, and idempotent locks. This step finishes what that block left out, as agreed with the PM:
- **item invalidation**
- **technical failures**
- **an expiry sweeper**
- **idempotent skip**

Spec used:
- `ASSESSMENT_ENGINE.md` ("technical failures excluded/replaced safely")
- `STATE_MACHINES.md` (the Response states `TECHNICAL_FAILURE` and `INVALIDATED`, and the Assessment terminal state `INVALIDATED`)
- `COMMAND_EVENT_CATALOG.md` (`InvalidateAssessmentItem`, and the atomic effects of LockAnswer and SubmitAssessment)
- invariants 11, 12 and 18 (a locked answer is immutable, a technical failure never counts as learner error, invalidation propagates recalculation)

## Built
- **Item exclusion.** `assessment_instance_question.excluded` is `TECHNICAL_FAILURE` or `INVALIDATED`.
  - An excluded item is never presented again, can't be locked or skipped, and is left out of the summary and the score.
  - The review shows it as "Removed: does not count", without the answer key or explanation, because the key may be what was wrong.
  - Locked answers are never edited; the item is excluded instead (invariant 11).
- **Technical failure (system-detected).**
  - When a question is about to be shown and its wording or options are missing or don't match the instance, it is excluded and the next one is shown.
  - When an answer can't be scored safely (not 4 options, not exactly one correct option, or the chosen option is missing), the item is excluded and the student is told it doesn't count against them.
  - Events: a `TECHNICAL_FAILURE` response event and `assessment.item_excluded.v1`.
- **InvalidateAssessmentItem** (approver or super admin).
  - The question version must already be out of serving (QUARANTINED, RETIRED or SUPERSEDED), so no new test picks it up.
  - It takes a listed reason and a note of at least 10 characters.
  - In every test that used the version:
    - running tests skip the item;
    - finished results are **rescored in place**, with the old and new figures kept in `assessment_result_correction` and an `assessment.rescored.v1` event (so Step 13 mastery and Step 15 CP can recalculate);
    - a test left with no counting items becomes **INVALIDATED** and stops being competitive.
  - Sessions are locked in a fixed order.
  - It is one decision per version, enforced by a unique index; repeating it, or two approvers at once, returns the first decision.
  - Recorded in the audit log and as `assessment_item.invalidated.v1`.
  - An impact check shows how many finished and running tests would change before anyone acts.
  - Screen: question bank, on a quarantined, retired or replaced question, "Tests already taken".
- **Cancelled tests.** When every item in a test is excluded, the test becomes `INVALIDATED`. It has no new result, and the student sees "This test was cancelled … not because of anything you did".
- **Expiry sweeper.**
  - Every 5 minutes it settles tests whose resume window has passed: scored if an answer was locked, void otherwise.
  - It handles batches of 100, up to 1,000 per run, each test under its session row lock, so it is safe with several API instances.
  - `EXAM_SWEEP_ENABLED=false` turns it off.
  - A void attempt now emits `assessment.expired_incomplete.v1`.
- **Idempotent skip.** The skip request takes an optional `idempotencyKey`, and the web runner sends one. A retry with the same key returns the same answer; without a key, behaviour is as before.

## State names (spec vs stored)

| Spec | Stored here |
| --- | --- |
| `IN_PROGRESS`, `COMPLETED_PENDING_SUBMISSION` | `IN_PROGRESS` (the summary phase is derived) |
| `SUBMITTED` → `SCORED` → `RESULT_READY` | `SUBMITTED`; the result is written in the same transaction, so it is never `SUBMITTED` without a result |
| `EXPIRED_INCOMPLETE` | `VOID` (name kept to avoid a data migration) |
| `INVALIDATED` | `INVALIDATED` (new) |
| Response `TECHNICAL_FAILURE` / `INVALIDATED` | the item's `excluded`, plus a response event of the same name. An item may never have had a response, so this lives on the item |

`CREATED`, `READY`, `PAUSED`, `ABANDONED` and `CANCELLED` are not stored. Nothing yet needs them: a test is ready when created and pausing is just leaving the page.

## Assumptions and open decisions (please confirm)
1. **Excluded, not replaced.** The spec says "excluded/replaced safely". Replacing mid-test needs an equivalent question (the equivalence policy, not built), so items are only excluded.
2. **Only system-detected technical failures.** A student cannot report "this question didn't load" to remove it; that could be used to dodge hard questions. Student reports belong with issue reports (not built).
3. **Invalidation needs the version out of serving first.** Quarantine or retire it, then invalidate. This keeps "stop new tests" and "fix old tests" as two deliberate steps.
4. **The result row is corrected in place, with full history.** The spec says CP corrections are compensating entries; for the result itself I keep the current value in `assessment_result` and every change in `assessment_result_correction`. The submission row is not changed.
5. **A test keeps its competitive status after a correction** unless nothing is left to count. I set no minimum number of counting items for a competitive result (Step 15's "20 eligible questions" applies to ranking).
6. **Approver or super admin** invalidates, the same people who publish questions.
7. **Sweeper timing.** It runs every 5 minutes, with up to 1,000 tests per run.
8. **Invalidation runs in one transaction** (60 s timeout). That is fine at beta scale. At larger scale it should run in batches as a job.

## Not built
- Replacing a failed item mid-test (needs equivalence).
- Student issue reports.
- Abandon and cancel by the student.
- Mastery and CP recalculation themselves (Steps 13 and 15 consume `assessment.rescored.v1`).

## Checks done here
- Unit tests: 49 suites, 876 tests (Step 10 was 46 / 854).
  - Pure rules: scoring and flow with excluded items.
  - Exam service: technical failure at present and at lock, cancelled test, result review, idempotent skip, sweep.
  - Invalidation service: roles, input, out-of-serving rule, impact, rescoring with corrections, invalidated test, repeat.
  - Sweeper.
  - Both controllers.
- Typecheck is clean (API, apart from the known Prisma-untyped codes; and web). Schema checked with the WASM validator.
- **Not run here:** the migration, the 4 new integration tests (real-database invalidation across two students, technical failure, concurrent skip retry, sweeper) and the screens in a browser.
