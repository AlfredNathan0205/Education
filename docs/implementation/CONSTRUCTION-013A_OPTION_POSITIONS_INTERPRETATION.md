# Fix 13A: the exam engine and the question bank disagreed on option positions

## What was wrong
- The question bank stores the four options of a question at positions **0, 1, 2, 3**. This covers authoring, CSV/JSON import and the AI factory, which all go through `QuestionService.apply`, and the labels A–D are indexed the same way.
- The exam engine has shuffled positions **1, 2, 3, 4** since Block 009: `optionOrder: shuffle([1, 2, 3, 4])`.
- The result: **every question that came through the real bank failed the presentation check**. Since Step 11, the check is `presentable()`, which looks for position 4 and doesn't find it. Every such question was removed as a TECHNICAL_FAILURE, so no student could answer a single one. Before Step 11, option A would never have been shown, and the fourth slot would have shown blank.
- **Why no test caught it.** The exam unit fake and the integration `bank()` fixture both wrote options at 1..4 by hand, matching the engine instead of the bank. The browser tests run against a stub. The bug was found when the Step 13 hand test was tried against the real API.
- **The Step 13 report's explanation was wrong.** It blamed the expiry sweeper and called the result "working correctly". The sweeper never marks questions as technical failures. This was a real defect.

## Fix
- `OPTION_POSITIONS = [0, 1, 2, 3]` and `optionRows()` in `question-domain.ts` are now the one place that decides positions. `QuestionService.apply` stores options through `optionRows()`, and the assembly engine shuffles `OPTION_POSITIONS`.
- **Fixtures follow the bank:**
  - the exam unit fake uses 0..3;
  - the integration `bank()` fixture builds its options with `optionRows()` itself;
  - the technical-failure test deletes position 3.
- **New contract test** (`option-positions.contract.spec.ts`). It builds options with the bank's own `optionRows()` and checks them against the engine's own `assemble()`, `presentable()` and `slotToPosition()`. It was confirmed to fail on the old engine line (2 of 3 tests failed) and to pass on the fix.
- **Database guard** (`CONSTRUCTION-013A_OPTION_POSITIONS_MIGRATION_EXTRA.sql`), so the two sides cannot drift apart silently again:
  - `question_option.position` must be between 0 and 3;
  - `assessment_instance_question.option_order` must be a permutation of {0, 1, 2, 3}.

  Both are added NOT VALID, then validated only if no existing row breaks them:
  - on a clean database (CI, staging, production) they end up fully validated;
  - on a development database holding old 1..4 test instances, the migration still succeeds, Postgres prints a NOTICE, and every new row is checked.

  Tested on a throwaway Postgres 16, clean and dirty, including duplicate and short orders.

## Not changed and worth knowing
- Assessment instances already assembled in a development database have 1..4 orders and remain unservable. Discard them: start new tests.
- Determinism is unchanged. The same seed draws the same random numbers, and the orders are shifted down by one.
- Mastery (Step 13) does not read option positions, so it is unaffected.

## Checks done here
- Unit tests: 56 suites, 930 tests pass. That is the 926 from Step 13, the 3 new contract tests and `app.module.spec`.
- The contract test fails on the old engine line and passes on the fix.
- No new type errors in the changed files.
- The migration SQL was run against a throwaway Postgres 16.
- **Not run here:** the integration tests, because the Prisma engines aren't available in this sandbox. Claude Code runs them.
