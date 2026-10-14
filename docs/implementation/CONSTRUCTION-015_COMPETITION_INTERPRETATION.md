# Step 15: Competitive points, XP and weekly leaderboards

Spec sources:
- `COMPETITION_CHALLENGES.md`: CP for qualified competitive assessment, XP for participation and practice; the weekly board is primary; ranking minimum of 2 qualified assessments and 20 eligible questions; the tie order; speed is not a ranking factor; minor default Friends Only; safe public profile ID.
- `INVARIANTS_AND_POLICIES.md`: invariant 13 (Mastery != CP, CP != XP, CP != Rank); invariant 17 (repeats cannot inflate CP); invariant 20 (LLMs cannot write CP); the CP baselines (Quick10 100, Chapter20 200, Subject25 250; a versioned, accuracy-dominant formula; practice earns XP only; the CP ledger is immutable with compensating corrections).
- `MASTER_SPEC.md`: no purchasable CP, multipliers or paid ranking advantage; no public academic weakness, exact location or unrestricted child contact.
- `CANONICAL_DATA_MODEL.md`: the Competition tables.

**The exact CP weights are not in the spec.** CP_V1 below is provisional and lives in a versioned policy row.

## Built
- **CP for each finished test, once per result revision**, worked out by a reconciler every 30 seconds (`COMPETITION_UPDATES_ENABLED`). The pattern is the same as mastery: a unique row per (session, revision) under the student's row lock, so retries never award twice.
  - **What qualifies:** a TEST whose first answer was locked, from a competitive design (QUICK10 and FOCUS10 up to 100 CP, SUBJECT20 up to 200, SUBJECT25 up to 250), with at least 5 counted questions.
  - **What doesn't:** practice, PRACTICE10 and RETEST10 earn XP only. Each non-qualifying test records its reasons (NOT_A_TEST, NOT_COMPETITIVE_DESIGN, NOT_COMMITTED, INVALIDATED, TOO_FEW_QUESTIONS).
- **CP_V1 formula (provisional).**
  - **Accuracy part:** 90% of the maximum × difficulty-weighted accuracy on fresh questions (easy 1, medium 1.25, hard 1.5) × the share of the test's questions that were fresh.
  - **Improvement part:** up to 10% of the maximum for beating the student's last qualified test of the same design in the same subject (never a penalty).
  - **Rounding:** rounded, and never below 0 or above the maximum.
  - **Rules within it:**
    - A question the student met before, in any earlier test or practice where it was actually shown, earns nothing and costs nothing (invariant 17).
    - Unanswered questions count as wrong.
    - Removed questions are left out.
- **The CP ledger (`cp_event`) is append-only, enforced by the database.** A trigger refuses UPDATE and DELETE.
  - The first scoring adds an AWARD.
  - A rescore (Step 11 invalidation) adds an ADJUSTMENT.
  - An invalidated test adds a REVERSAL.

  Every entry is dated to the test's finish time, so a past week's board is corrected in place. CHECKs keep AWARD positive, REVERSAL negative and nothing zero. `competitive_qualification` keeps every revision with its numbers and the parts of the CP.
- **XP:** 1 per locked answer plus 5 per finished test or practice. Recorded once per session and never reversed, because the effort happened.
- **Weekly boards,** Monday 00:00 to Monday 00:00 India time (provisional). Worked out on request from the ledger: a subject board for each of the student's subjects, and a whole-cohort board ("All subjects · ICSE Grade 8").
  - **Ranking:** needs 2 qualified tests and 20 eligible questions in the scope and week. Ties go by average accuracy, then the most recent qualified test, then average difficulty, then a shared rank (1, 1, 3). Speed plays no part.
  - **What a board shows:** the top 10 plus the student's own row, as handle and CP only. No names, schools, places or accuracy.
  - **Ranks are worked out among students others may see, plus the viewer,** so a hidden student never leaves a visible gap.
- **Who appears to whom:**
  - **Handles:** every student gets a neutral handle (`Learner-XXXXXX`, no ambiguous letters).
  - **Minors are never shown to other students** (Release 1). They see the boards and their own rank, and cannot change this.
  - **A student with no age classification is treated as a minor** (fail closed).
  - **Adults are shown by default** and can hide or come back.
- **API:** `GET /compete` and `PUT /compete/visibility` (behind the web proxy's allow-list).
- **Web:** the Compete page replaces "Coming soon". It shows this week's dates, the student's handle, XP, whether others see them (with the switch for adults), what's still needed to be ranked, and each board.
- **Outbox:** `competition.cp_recorded.v1` for every ledger entry.

## Assumptions and open decisions (please confirm)
1. **Minors are never shown to other students in Release 1** (my reading of "Minor defaults: Friends Only" before friends exist). Whether a minor, or their guardian, may opt in is **for you and counsel**, along with whether the handle itself needs guardian consent.
2. **The CP_V1 weights:** 90/10 accuracy/improvement, difficulty weights 1/1.25/1.5, fresh-only scoring, and a 5-question minimum. The spec says "accuracy-dominant with difficulty/exposure/integrity plus small improvement"; these numbers are mine.
3. **Which designs earn CP.** FOCUS10 earns like QUICK10, and SUBJECT20 gets the spec's "Chapter20" 200. RETEST10 earns no CP: it comes straight after practice that showed the answers, so it is not fresh competitive evidence.
4. **"Seen before"** means shown in any earlier test or practice, at any time, not just recently. That is stricter than "near repeat", so a large, fresh bank matters for fair CP.
5. **The week runs Monday to Sunday in India time** (UTC+5:30), from the policy. A second cohort in another time zone would need its own policy setting.
6. **The cohort board is curriculum version plus grade.** There are no school, city, state or country boards. A school board would need the student-chosen school, which the spec says is not reporting authority; it can come later behind a flag.
7. **Boards are worked out on request,** not stored projections (`leaderboard_*` tables are not built). This is fine at beta scale (100 to 300 students). A rebuildable projection is the change to make before general release.
8. **Erasure.** The ledger can't be deleted row by row. A future erasure request would need a deliberate, audited path (for example, anonymising `student_id`). That is **for counsel** when the data-retention policy is written.

## Not built
- Friends, challenges, challenge CP and the challenge component of the formula (Step 16, behind a flag).
- Monthly and all-time boards, and rank snapshots (`leaderboard_rank_snapshot`).
- A staff view of CP, and manual adjustments (`cp_adjustment` with an approver).
- A Leaderboard card on Home (spec Home priority 2): it needs a wording decision, so for now it lives on Compete.

## Checks done here
- **Unit tests: 60 suites, 982 tests** (Step 14 had 961). They cover:
  - qualification and every reason; the formula (accuracy, difficulty, fresh-only, improvement, the caps);
  - ledger entries; XP; week boundaries in India time; ranking and every tie-break; the minimums; handles; policy parsing; the seeded SQL matching the code;
  - the service against an in-memory fake: award once, adjust, reverse, XP only for practice, repeats earning nothing, boards hiding minors and hidden adults, the minor switch refused, an unclassified student treated as a minor.
- **Browser tests: 22 of 22 pass** (11 × phone and desktop). The new ones: ranked after two tests, the hide and show switch, and the minor view.
- **Typecheck:** the web app is clean. The API shows only the known untyped-Prisma warnings in the integration test file, which Prisma's generated client resolves.
- **The schema validates** (Prisma's schema engine). **The SQL extras** were run on a throwaway Postgres 16: the trigger refuses UPDATE and DELETE (TRUNCATE still works, for test databases), and every CHECK and the one-active index hold.
- The Compete page was checked by eye at phone width.
- **Not run here:** the migration and the 2 new real-database integration tests:
  - CP once, then a compensating adjustment after an invalidation, and the ledger refusing edits;
  - the board's minimums, handles and CP only, a minor hidden from others, an adult hiding, and practice earning XP only.
