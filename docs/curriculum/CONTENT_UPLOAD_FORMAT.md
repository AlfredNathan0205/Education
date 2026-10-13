# Curriculum content upload — format and rules

For teachers and administrators who hold the **editor** role. Page: `/admin/curriculum` (sign in first). Nothing uploaded here becomes live: it is saved as a **draft**, checked by the system, verified against its sources by a reviewer, and approved by an approver before anyone can activate it.

## The two file types

**CSV** (best for people; Excel: *Save As → CSV (Comma delimited)*). One row per learning objective. Download the template from the page (`/curriculum-upload-template.csv`).

| Column | Required | Meaning |
|---|---|---|
| `chapter_code`, `topic_code`, `concept_code`, `objective_code` | yes, every row | Short codes: letters, digits, `.` `_` `-`, up to 64 characters, starting with a letter or digit. Unique within their parent. |
| `chapter_title`, `topic_title`, `concept_title` | yes on the row that first uses the code | Text up to 255 characters. If the same code appears again with a different title, the file is rejected. |
| `objective` | yes | The learning objective, up to 1000 characters. |
| `evidence_ref` | for official nodes | A whole number: `1` is the first source listed for this subject, `2` the second, and so on. |
| `provenance` | no | `OFFICIAL_EXPLICIT`, `OFFICIAL_INFERRED` or `ADMIN_ADDED`. Blank means `ADMIN_ADDED`. |
| `rationale` | for anything not `OFFICIAL_EXPLICIT` | One sentence: why this is here and where it comes from. |

The provenance, evidence number and rationale on a row apply to every node **that row introduces** (a new chapter, topic, concept and the objective). Parents are created by their first row; later rows only repeat the codes. Column order is free; header names are not case-sensitive.

**JSON** (used for the AI draft; also fine for people): `{ "chapters": [ { code, title, provenance, evidenceRef, rationale, topics: [ { …, microConcepts: [ { …, learningObjectives: [ { code, statement, … } ] } ] } ] } ] }`. Order in each list is the display order.

## What the three provenance values mean

- `OFFICIAL_EXPLICIT` — the official source states this item in these words or very nearly. Only a person may claim this.
- `OFFICIAL_INFERRED` — a reasonable reading of the official source, not stated outright. Needs a rationale and a source number.
- `ADMIN_ADDED` — added by the uploader for the product (not claimed to be in the source). Needs a rationale. The system flags these for the reviewer.

## What happens to the file

1. **Check the file** reads it, reports problems by row, and shows what the automatic check would say. Nothing is saved.
2. **Save as draft** replaces the subject's draft content with the file (only if the file itself had no problems). If the subject had already passed validation, it goes back to needing validation.
3. **Submit for automated validation** runs the structural checks (codes, empty branches, evidence cited, rationale present). It does **not** judge whether the content is *correct*.
4. A **reviewer** verifies the evidence, then an **approver** approves; **activation** is a separate step. A subject that is `ACTIVE` cannot be changed: corrections are a new revision.

Limits: 2 MB, 20,000 rows. A file with any problem is rejected whole, so a half-read file is never saved.

## The AI draft path (operator only)

`ADMIN_OPERATOR=<name> node apps/api/dist/curriculum/cli/import-ai.js <draft.json>` imports an AI-drafted structure as the **AI actor**, never as a person. The AI may only mark nodes `OFFICIAL_INFERRED` or `SYSTEM_DERIVED` (so a person must confirm anything "explicit"), the subject moves `DRAFT → AI_STRUCTURED`, and the file's SHA-256 and the operator's name are written to the subject's history. The JSON needs a header naming the subject: `curriculumCode`, `versionLabel`, `gradeCode`, `subjectCode`. It refuses subjects past `AI_STRUCTURED`.
