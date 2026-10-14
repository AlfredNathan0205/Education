# Step 13: Mastery and diagnostics

Spec sources:
- `MASTERY_DIAGNOSTICS.md` and `CLAIM_GATING_PARENT.md`
- `INVARIANTS_AND_POLICIES.md`: the mastery and claim baselines, and invariants 13–18
- `CANONICAL_DATA_MODEL.md`: the Mastery tables
- `DOMAIN_MAP.md`: Result → Mastery Evidence → Diagnostics

The PM asked for the step to be built with decisions flagged rather than asked first. **Every number below that is not in the spec is marked "provisional" and lives in the versioned policy row, not in code constants.**

## Built
- **Tables**:
  - `mastery_policy_version`: exactly one ACTIVE, enforced by a partial unique index.
  - `mastery_evidence_event`: immutable.
  - `student_mastery_state`.
  - `mastery_update_run`: unique per test and result revision.
  - `mastery_state_change`: before and after for each objective; this is the trajectory and the audit trail.
  - `student_difficulty_state` and `student_cognitive_state`.

  The extra SQL (index, CHECKs and the MASTERY_V1 seed) is in `CONSTRUCTION-013_MASTERY_MIGRATION_EXTRA.sql`. A unit test fails if the seeded policy drifts from the code.
- **Evidence.** Each locked, counted answer in a finished test becomes one piece of evidence on its learning objective.
  - Skipped, unanswered and excluded items give no evidence: unknown is not zero, and a technical failure is not the learner's error.
  - Weight = independence × context × item quality, capped at 1:
    - context: chapter or subject test (20+ questions) 1, Quick test 0.9, Practice 0.6;
    - item quality: Healthy 1, New 0.9, Watch 0.7, Degraded 0.3, Quarantined 0;
    - an exact repeat of a question already in the student's evidence counts 0.05.
  - Each piece of evidence keeps its factors, the policy id, and the learning objective id of the exact curriculum revision.
- **Mastery.** A weighted Bayesian accumulator with a mild neutral prior (α = β = 1), as the spec sets out. State is recomputed from all valid evidence every time it changes.
- **Confidence (provisional formula, 0–100).** volume × diversity × sessions × item quality × recency:
  - volume = 1 − e^(−effective/2.5);
  - diversity = min(1, 0.6 + 0.2 × families);
  - one session only = × 0.85;
  - recency: full for 30 days, sliding to × 0.8 at 180 days.

  The numbers are tuned so the spec's ordinary gate is reachable at about the spec's evidence levels. **Recency lowers confidence, never mastery.**
- **Labels (claim gates).**
  - No evidence: NOT_STARTED.
  - Below the ordinary gate: BUILDING_EVIDENCE. The ordinary gate is confidence ≥ 75, effective evidence ≥ 5, families ≥ 2, sessions ≥ 2, and **at least one test answer, so Practice alone cannot pass**.
  - Above the gate, the band comes from mastery: STRONG ≥ 85, SECURE 70–84, DEVELOPING 55–69, NEEDS_ATTENTION < 55.
  - STRONG needs the spec's strong gate (mastery ≥ 85, confidence ≥ 85, effective ≥ 6, families ≥ 3, sessions ≥ 2); otherwise the label is SECURE.
  - NEEDS_ATTENTION needs a stricter weak gate (effective ≥ 6, families ≥ 3, sessions ≥ 2); otherwise the label stays BUILDING_EVIDENCE, because one bad test is not a weakness.
- **Chapter rollup.** Labelled only when at least 60% of the chapter's objectives (and at least 2) are themselves reportable. A chapter with any objective needing attention is never above DEVELOPING, so a rollup never hides a gap.
- **Difficulty and cognitive slices** per subject: the same accumulator, with no gate. These feed later diagnostics and are not shown to students.
- **When mastery updates.**
  - A reconciler runs every 30 seconds (`MASTERY_UPDATES_ENABLED`). It finds every scored, rescored or invalidated test with no run for its current result revision, and processes each in one transaction under the student's row lock.
  - A test's result never waits for mastery, and a mastery failure never undoes a result (the spec's async rule).
  - Retries and a second worker cannot add evidence twice.
  - **Invalidation propagates:**
    - a rescored result (Step 11) withdraws the evidence of the removed item and recomputes;
    - an invalidated test withdraws all of its evidence.
- **API.**
  - `GET /mastery` (the student's own). Subjects of their cohort → chapters → objectives, with **labels only** and the number of answers counted, plus "pending" while a just-finished test is waiting to be counted.
  - `GET /admin/mastery/students/:id` (reviewer and above). The numbers behind a student's states and their recent runs, for academic support. **Every view is written to the audit log.**
- **Web.** Progress now shows each subject ("x of y objectives with enough evidence"), chapters with their label, and objectives when a chapter is opened. Recent results stay under each subject. No percentage anywhere. A note appears while a test is still being counted.

## Assumptions and open decisions (please confirm)
1. **Families = distinct questions.** The bank has no reasoning or scenario families yet, so each question counts as its own family. **This overstates diversity**: ten variants of one question would look like ten families. Once families exist in the bank, the policy should count them instead. This is the most important caveat on what labels mean today.
2. **The confidence formula is provisional.** The spec names its inputs but not the formula. Change it by publishing a new policy version, not by editing code.
3. **Prior α = β = 1** is my reading of "mild neutral prior".
4. **Weak and strong gates.** The spec says weak claims need stricter gates without giving numbers. I used the strong-gate volume (effective ≥ 6, families ≥ 3, sessions ≥ 2).
5. **Chapter rollup thresholds** (60% and at least 2 reportable objectives, capped at DEVELOPING if any objective needs attention) are mine. The spec only says chapter and subject claims use stricter gates. Subjects show counts, not a label.
6. **Item quality is read when the test is counted** (about 30 seconds after it finishes), not when each answer was locked. A question quarantined in between counts 0.
7. **Mastery is keyed by objective path within a curriculum version, grade and subject.** A corrected revision of the same curriculum version keeps the history. A new curriculum version starts fresh, so historical evidence is never rewritten.
8. **Students see labels and answer counts only**, never confidence or raw mastery. The spec says parents must not see raw confidence; I applied the same rule to students.
9. **Exposure and scope-attribution factors are 1.** Repeats are handled by independence, and each question maps to one objective. Multi-objective questions would need `question_mastery_scope_mapping`.

## Not built
- Misconceptions (`misconception_*`): there are no distractor-to-misconception mappings in the bank yet.
- Reasoning states (no families).
- `student_mastery_snapshot` (the state-change log serves as the trajectory).
- Candidate, approved and suppressed claims, and reports. These belong with the parent surface (Step 17); the gate already decides what a label may say.
- IRT/Rasch (the spec allows it later via an approved change).

## Checks done here
- **Unit tests**: 54 suites, 926 tests (Step 12 had 891). They cover:
  - weights, the accumulator, confidence, every gate and band, rollup, and policy validation;
  - the seeded SQL matching the code;
  - the service: evidence, repeats, practice, exclusions, invalidation and recompute, idempotency, a missing or broken policy;
  - the views: labels only, staff access audited.
- **Typecheck** is clean (API, apart from the known Prisma-untyped codes; and web). `next build` passes.
- **Browser tests: 14 of 14 pass here** (7 × phone and desktop). The new ones check that Progress shows labels and no percentage, and that after a test the chapter shows "Building evidence", not a low label.
- **Migration extras** (index, CHECKs, seed) were run on a throwaway Postgres.
- **Not run here:** the migration and the 2 new real-database integration tests:
  - a test becomes evidence once; two tests pass the gate (STRONG); the view;
  - invalidation withdraws evidence and recomputes.
