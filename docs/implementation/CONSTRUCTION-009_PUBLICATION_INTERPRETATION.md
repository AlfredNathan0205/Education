# Step 9: Question bank and publication

Spec rule: **Approved is not published** (invariants 7; STATE_MACHINES; DOMAIN_MAP "Approval does not publish a question").
Approval says the wording and key are right. Publication is a separate, named act that puts one exact version into the bank
that tests are built from. Reviewers do not publish. The AI never does.

## Built
- **Publication** (`question_publication`, one row per version, plus an append-only `question_publication_event` history).
  Only an **approver** (or super admin) publishes. A version can be published only if it is APPROVED, a person confirmed the
  answer key, the latest automatic check passed, its objective still exists, and the unit's newest curriculum is **ACTIVE**
  (the dev switch `EXAM_ALLOW_UNACTIVATED_CURRICULUM` waives only the ACTIVE test, never in production).
- **Withdraw.** Any reviewer may pull a published question (the safe direction, like quarantine), with a listed reason and a note.
  An approver publishes it again.
- **Automatic withdrawal.** Quarantine and retire withdraw the publication in the same step. A newer approved version replaces and
  withdraws the old one. **Restoring a quarantined question does not publish it again**; an approver must publish it (spec:
  "restore/revision requires ... new publication state").
- **Serving rule.** Tests are built only from questions that are APPROVED **and** PUBLISHED **and** not marked DEGRADED. This changes
  the exam engine's query. **Existing approved questions are not published automatically**: nothing was published before this
  step, so a person (an approver) must publish them, one by one or with "Publish all approved" for a unit.
- **Bank health** (`question_bank_state`): NEW (default on publish), HEALTHY, WATCH, DEGRADED set by a reviewer or approver with a reason
  and note. QUARANTINED and RETIRED are read from the question's review state. Shown in the question bank screen.
- **Screen:** bank summary per subject, "Publish all approved" (lists what it could not publish and why), publish / withdraw / set
  health on an approved question, bank status on each row.
- **Operator tool (read-only):** `bank status <curriculum> <grade> <subject>`. Publishing is not done from the command line, so every
  publication is tied to a signed-in person's role.

## Assumptions and open decisions
1. **DEGRADED stops serving; WATCH does not.** The spec lists the lifecycle but not what each state does to serving. This is my
   conservative reading.
2. **Health is manual for now.** NEW to HEALTHY to WATCH to DEGRADED should be driven by live signals (exposure, correct-rate, issue
   reports), which arrive with assessment execution and mastery (Steps 11 and 13). Until then people set it.
3. **Publisher = approver or super admin; withdrawer = reviewer and above.** The spec says reviewers do not publish, not who does. A
   separate publisher role is easy to add if you want one.
4. **The question's author may publish** if they hold the approver role. Approval already enforced separation of duties; I did not add a
   second rule on publication. Say if you want one.
5. **Replacing a version leaves a gap.** When revision 2 is approved, revision 1 stops being served at once, and revision 2 is not
   served until published. That follows "any material edit creates a new version and revalidation" but means a corrected question
   disappears from tests until an approver publishes it.
6. **Active / Reserve / Historical pools** are described as conceptual serving states. Not built: all published questions are one pool.
7. **Not built (later steps or live data):** quality snapshots, live-quality events, issue reports (`question_quality_snapshot`,
   `live_quality_event`, `issue_report`), the diversity stack (reasoning families R01-R16, scenario families, variant levels V0-V5),
   and audit pass/fail states between approval and bank-ready (the spec lifecycle has AUDIT_PENDING/AUDIT_PASSED; there is no audit
   process yet because nothing is auto-approved).
8. The **coverage report** (Step 6) still counts approved questions, not published ones. A cell may look covered while its questions
   wait to be published; the bank status line in the screen and `bank status` show the difference.
