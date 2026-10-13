# Question upload format (multiple choice)

Questions are uploaded per subject at `/admin/questions`. Every question has one stem, exactly four options (A to D), exactly one correct option, a difficulty, and an explanation. Each question points at one learning objective by its code, so the objective must already exist in that subject's curriculum content.

Nothing uploaded here is live. It is saved as a draft, then submitted, then checked by a different person.

## CSV (one row per question)

Header row, in any order:

`question_code, objective_code, stem, option_a, option_b, option_c, option_d, correct, difficulty, cognitive, explanation`

- `question_code`: your own unique code, letters/digits/dashes, e.g. `CHE8-Q001`. Re-uploading the same code updates that question.
- `objective_code`: the code of an existing learning objective, e.g. `CHE8-C6-T2-M2-O2`.
- `correct`: `A`, `B`, `C` or `D`.
- `difficulty`: `EASY`, `MEDIUM` or `HARD`.
- `cognitive`: `C1`, `C2`, `C3` or `C4`. The column may be left out or blank so older files still load, but a question without a cognitive level cannot be submitted for review. What each level means is a curriculum decision that is not written down in this repository yet; agree it before tagging real questions.
- Quote any cell that contains a comma. In Excel use Save As, CSV (Comma delimited).

Template: `/question-upload-template.csv`.

## JSON

```json
{
  "curriculumCode": "ICSE",
  "versionLabel": "2026-27",
  "gradeCode": "GRADE_8",
  "subjectCode": "CHEMISTRY",
  "questions": [
    {
      "code": "CHE8-Q001",
      "objectiveCode": "CHE8-C6-T2-M2-O2",
      "stem": "Which gas turns lime water milky?",
      "options": ["Oxygen", "Carbon dioxide", "Nitrogen", "Hydrogen"],
      "correct": "B",
      "difficulty": "EASY",
      "cognitive": "C1",
      "explanation": "Carbon dioxide reacts with calcium hydroxide to give insoluble calcium carbonate."
    }
  ]
}
```

The header must match the subject you chose. A mismatch is refused.

## What the check reports

- Unknown or ambiguous objective code.
- Missing or duplicate options, an invalid `correct`, text over the limits.
- The same code or the same wording twice in one file, or the same wording under another code in the bank.
- A question that is currently in review or retired (it cannot be overwritten).

Limit: 2000 questions per file, about 2 MB.

## What happens on save

| Existing question | Result |
| --- | --- |
| none | created as a DRAFT |
| DRAFT or CHANGES_REQUIRED | updated in place |
| APPROVED, content changed | a new revision is created as DRAFT; the approved one stays in force until the new one is approved |
| APPROVED, content identical | unchanged |
| IN_REVIEW or RETIRED | refused |

## Review

DRAFT → submit (editor) → IN_REVIEW → approve or request changes (reviewer, approver or super admin). The approver must tick that they checked the answer key themselves. Nobody who wrote, edited or submitted a question can approve it. Approving a new revision supersedes the earlier approved one. An approved question can be retired with a note.
