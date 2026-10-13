# Step 7: Question Governance core

The question bank (Block 008) already had: revisions that are never edited once approved, a human-only approval,
separation of duties, and the answer-key confirmation. This step adds what the spec still asked for and that can be
built without AI.

## Built
- **Cognitive level (C1 to C4) and question type** on every question revision. Type is MCQ only. Cognitive is optional in a file
  (older files still load) but required before submitting for review. Existing approved questions are untouched and stay untagged.
- **Deterministic checks, saved.** On submit the checks run; a CRITICAL finding (malformed, or no cognitive level) refuses the
  submission. A passing run is stored against the exact revision (`question_validation_run`, append-only, with a checker
  version). MAJOR (no explanation) and MINOR (all/none of the above, answer much longer than the rest) are shown to the reviewer
  and do not block. Approval needs a passing run; a question submitted before this existed gets one at approval time.
  Failed runs are reported to the editor but not stored (the failed submit rolls back).
- **Structured reason codes** are required, with a note, to send back, retire, quarantine or restore. Stored on the history row.
- **Quarantine** (new state QUARANTINED). Any reviewer or approver can pull an approved question at once; it is no longer served
  (the exam pool serves only APPROVED). Only an approver can restore it, with a reason and note, and not if a newer version is
  already approved. A whole AI import batch can be quarantined by its file hash (`POST admin/questions/batches/quarantine`).
- **Confidence and routing calculation** (`assessConfidence`): the spec's weights and GREEN/YELLOW/AMBER/RED thresholds; a critical
  gate or unresolved conflict is RED whatever the score; incomplete evidence is never routed.
- Admin screen: reason picker, quarantine and restore, automatic-check results, cognitive level.

## Decisions and assumptions to confirm
1. The reason-code list is my starting set, built from the validator dimensions in the spec. The spec says reason codes are
   versioned policy data; edit `reason-codes.ts` (and the labels in the web client) to your list.
2. The spec's YELLOW (>= .950, repairable) and AMBER (.900-.984) overlap in print. I read YELLOW as "repairable and at least .950"
   and AMBER as the rest from .900.
3. Difficulty: the spec says D1-D5; the bank, the exam blueprint (5/3/2) and the CSV use EASY/MEDIUM/HARD. Not changed.
4. What C1, C2, C3 and C4 mean is not defined in this repository. Define them before tagging real questions.

## Not built, on purpose
- The independent validators (answer solver, curriculum, ambiguity, explanation, distractors, difficulty/cognitive,
  readability, adversarial) and the model/prompt registry: AI Question Factory (Step 8). The confidence calculation has no producer yet.
- Auto-approval, repair and second-opinion routing, and the stratified audit sampling (the audit rates in the spec apply to
  auto-approved items, which cannot exist yet).
- H1 / H2 reviewer tiers: today REVIEWER and APPROVER are the roles. Which of them is H1 and which is H2 is your call,
  and so is which items need H2 (the spec ties it to risk, which is not stored).
- Question types other than MCQ; reasoning families; near-duplicate detection (Question Bank step).
- Coverage by cognitive level: the Step 6 report still uses objective x difficulty. Once questions are tagged it can add the dimension.
- Pulling a question from a test that is already in progress; quarantine affects new tests only.

## Operator steps (Claude Code)
1. Migration `question_governance` (new enum values question_cognitive, question_type, QUARANTINED; two columns on
   question_revision; reason_code on question_event; new table question_validation_run).
2. Unit tests: 733 pass in the sandbox. Integration tests were not run here.
3. Hand test: upload the new template, check a question without a cognitive level cannot be submitted, submit and approve one with
   a different account, quarantine it and confirm it no longer appears in a Quick 10, restore it as an approver.
