# Step 14: Recommendations, practice and retest

Spec sources:
- `MASTER_SPEC.md`: the core loop Choose → Test → Score → Understand mistakes → Practice → Retest → See progress. TEST measures, PRACTICE teaches; practice has lower evidential weight.
- `MASTERY_DIAGNOSTICS.md`: context weights Quick 0.9, independent Retest 0.9, Practice 0.6.
- `CLAIM_GATING_PARENT.md`: practice alone cannot manufacture mastery.
- `DOMAIN_MAP.md`: domain 15, Recommendations (Next Best Action, practice/retest recommendations); Result → Mastery Evidence → Diagnostics → Recommendation.
- `CANONICAL_DATA_MODEL.md`: `recommendation`, `recommendation_reason`, `recommendation_policy_version`, `recommendation_event`, `next_best_action`.
- `STUDENT_WEB.md`: the journey Results → Review → Practice → Retest → Progress, and Home priorities.
- Handoff section 20: recommendations must be traceable to structured academic evidence, not opaque LLM judgement.

**The spec names the kinds of next action but gives no selection rules.** Every rule and number below is provisional. They live in the versioned policy row `RECO_V1` (and in two seeded blueprints), not in code constants.

## Built
- **Practise what you missed.** A finished test's result offers a 10-question practice set (PRACTICE10).
  - It targets the objectives of the wrong or unanswered questions, most missed first, up to 3 objectives.
  - Removed questions (technical failure, invalidated) never count as missed.
  - Asking again for the same test resumes the same set.
- **Recommendations from mastery.** After every mastery run, a reconciler refreshes that student's recommendation for the subject. It runs every 30 seconds and can be switched off with `RECOMMENDATIONS_ENABLED`.
  - There is one refresh per run (a unique row), under the student's row lock, so retries and a second worker never act twice.
  - Candidates, in order:
    1. objectives the gates already mark Needs attention;
    2. then Developing;
    3. then objectives below every gate with at least 2 answers and posterior mastery below 0.5 (more missed than right).

    Within each tier the lowest mastery comes first, then the most recent evidence. At most 3 objectives.
  - Secure, Strong, not-started and one-answer objectives are never chosen.
- **The loop.** At most one OPEN or STARTED recommendation per student and subject, enforced by a partial unique index.
  - A practice finished with at least 5 answers is completed, and a **retest** (RETEST10, a TEST) is offered on the same objectives.
  - A practice finished with fewer answers, or abandoned, is reopened.
  - A finished retest is completed and the subject is looked at afresh.
  - An open practice is replaced when the chosen objectives change, and withdrawn when nothing qualifies any more.
  - **"Not now"** puts those objectives off for 7 days.
- **Evidence.** Mastery is unchanged: practice counts 0.6 and a retest counts as a Quick-size test, 0.9. This matches the spec's "independent Retest 0.9". Mastery alone decides what the new evidence means.
- **Assembly: objective scope.** A new scope mode, OBJECTIVES. A set prefers its target objectives. When they hold too few questions, it widens one ring at a time (same micro-concept, topic, chapter, then subject) and records how far in the assembly report (`SCOPE_WIDENED … to: TOPIC`). Unseen questions come first, so a retest is as independent as the bank allows.
  - Objective-scope designs are never listed as ordinary tests.
  - The API refuses to start one without a recommendation.
- **Traceability.** Every recommendation stores:
  - its policy;
  - its source (MASTERY, RESULT or PRACTICE_DONE);
  - the mastery run or test it came from, and the practice a retest follows;
  - one reason per objective, with the facts behind it (label, answers, mastery, or the test and how many were missed).

  Every change is a `recommendation_event` (CREATED, STARTED, COMPLETED, REOPENED, DISMISSED, SUPERSEDED) and an outbox event `recommendation.*.v1`. Practice and retest instances carry `recommendation_id` and `target_objectives`.
- **API.**
  - `GET /recommendations`
  - `POST /recommendations/:id/start`
  - `POST /recommendations/:id/dismiss`
  - `POST /recommendations/from-result/:assessmentId`

  All are behind the web proxy's allow-list. Students see objective statements and reason codes only, never mastery numbers or confidence.
- **Web.**
  - Results: a "Practise what you missed" button, and after practice, a note that a retest will follow.
  - Home: the next best action is now resume → finish profile → coming soon → not ready → first test → **retest → practice** → untested subject → longest ago. The retest or practice card has Start and Not now. Other open recommendations are listed under "Focus next", or "Also to focus on" when one is already the next action.

## Assumptions and open decisions (please confirm)
1. **The selection rules** (tiers, at most 3 objectives, at least 2 answers, mastery below 0.5) are mine. Using sub-gate evidence to *suggest practice* is not a claim, so it doesn't need the claim gates. The wording stays factual: "You have missed more of these than you got right so far".
2. **Retest after practice needs at least 5 locked practice answers.** Skipping through a set is not practice.
3. **PRACTICE10 and RETEST10 split 4/4/2** (easy/medium/hard), open with an easy question, and are seeded switched on. The split is a guess. A retest could reasonably match Quick 10's 5/3/2.
4. **"Not now" lasts 7 days** and covers those objectives, not the subject.
5. **Retest weight.** No new mastery context: a 10-question retest already counts 0.9 as a Quick-size test, which equals the spec's retest weight. If retests should ever differ from Quick tests, that needs a new mastery policy version.
6. **Practise-what-you-missed works from any finished test,** including a retest, and replaces an open (not started) recommendation in that subject.
7. **The next best action is computed, not stored.** `next_best_action` (canonical model) is not a table yet; Home works it out on each request from stored recommendations.
8. **Students see the same recommendation reasons parents will later see** (Step 17 decides parent wording through claim gating).

## Not built
- "Reinforce prerequisite" (handoff section 20): there is no prerequisite graph in the curriculum yet.
- "Review explanation" as a separate recommendation: the result page's review already shows every explanation.
- A staff or parent view of recommendations (Step 17 for parents).
- Recommendation analytics: the outbox events carry what's needed for review → practice → retest funnels (ANALYTICS_QA_RELEASE), but no projection exists yet.
- Time-boxed or spaced retests: a retest is offered as soon as practice is counted.

## Migrations (two, in this order)
1. `recommendations`: Prisma's generated DDL plus `CONSTRUCTION-014_RECOMMENDATION_MIGRATION_EXTRA.sql`:
   - partial unique indexes (one ACTIVE policy; one active recommendation per subject);
   - CHECKs: 1–10 objectives and never NULL, a retest has a parent, a closed recommendation has a closing time;
   - the RECO_V1 seed.
2. `recommendation_blueprints`: only `CONSTRUCTION-014_RECOMMENDATION_BLUEPRINTS_MIGRATION.sql`, which seeds PRACTICE10 and RETEST10. This has to be a separate migration because Postgres refuses to use the new enum value OBJECTIVES in the transaction that added it. Checked on Postgres 16: in one transaction it fails with "unsafe use of new value"; split, both succeed.

## Checks done here
- **Unit tests: 58 suites, 961 tests** (Step 13 plus Fix 13A had 930). They cover:
  - the objective scope and its widening;
  - policy rules, plans and parsing, and the seeded SQL matching the code;
  - the service against an in-memory fake (refresh, retest after practice, practise-missed, start, resume, dismiss, the student view without numbers);
  - targeted creates in the exam service;
  - the Home order.
- **Browser tests: 18 of 18 pass** (9 × phone and desktop), including two new ones: practise what you missed then retest, and Not now.
- **Typecheck clean** (API: only the known Prisma-untyped warnings, 43 against a baseline of 44; web: clean).
- **The Prisma schema validates** with Prisma's own schema engine (wasm).
- **Both migrations' SQL** was run on a throwaway Postgres 16, including the enum failure and every constraint.
- Home and the result page were checked by eye at phone width. That check caught a recommendation shown twice, now fixed.
- **Not run here:** the migration generation and the 2 new real-database integration tests:
  - practise what you missed → retest → completed, with events and outbox;
  - mastery-driven practice → Not now respected.
