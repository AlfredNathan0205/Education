# CONSTRUCTION-006 — Curriculum content intake (extension of Build Sequence step 4)

**Status:** code complete on branch `construction-006-content-intake`; not a completed block. Requested by the PM on 2026-10-13: "use the AI option, but also build the option for teachers/admin to upload."

## What exists

- **Pure parser** (`apps/api/src/curriculum/import/content-import.ts`): CSV and JSON into a `CurriculumTree`, with size limits, control-character rejection, per-row error locations, evidence referenced by number (never database ids), and a provenance rule per uploader.
- **Teacher/admin upload** (`ContentImportService`, `AdminCurriculumController`): `GET /admin/curriculum/units`, `POST …/units/:id/content/preview`, `PUT …/units/:id/content`, `POST …/units/:id/submit`. Session-guarded; the role is read from `role_assignment` on every call; previews and uploads need EDITOR or SUPER_ADMIN, listing needs any curriculum role. Writes go through the existing `CurriculumAdminService.replaceContent`, so the state machine, history log and reopen-on-edit rules all still apply.
- **Admin web page** `/admin/curriculum`: choose a subject, choose a file, *Check* (writes nothing), *Save as draft*, *Submit for automated validation*; CSV template download.
- **AI import** (`import/ai-import.ts`, CLI `import-ai.js`): operator-run, acts as the AI actor, drafts only.
- Format guide: `docs/curriculum/CONTENT_UPLOAD_FORMAT.md`.

## Builder decisions (please confirm or change)

1. **The AI can never claim `OFFICIAL_EXPLICIT`.** It may mark nodes `OFFICIAL_INFERRED` or `SYSTEM_DERIVED`; a person who checks the source decides what is "explicit". People may claim `OFFICIAL_EXPLICIT`, `OFFICIAL_INFERRED` or `ADMIN_ADDED`, never `SYSTEM_DERIVED`.
2. **Upload replaces, never merges.** A saved upload replaces the subject's whole draft tree (existing `replaceContent` behaviour). Partial updates would make provenance and positions ambiguous.
3. **A file with any problem is rejected whole.** Structural-validator findings (for example, no evidence yet) do not block saving a draft: teachers iterate. They are shown, and they do block *validation*.
4. **The AI import is operator-run, not an HTTP endpoint,** so there is no way to reach the AI actor from a web request. It records the file hash and operator in the history note.
5. **Evidence numbers follow creation order** of the unit's references (oldest first). Adding references later appends numbers; it does not renumber.
6. **Editable states from the page:** DRAFT, AI_STRUCTURED, CHANGES_REQUIRED (the page shows the others as read-only; the server enforces it regardless).
7. **Upload body limit raised to 3 MB** for the API's JSON parser (default was 100 KB).
8. **No review or approval screens yet.** Verification, approval and activation remain operator/CLI-level; only intake has a screen.
9. **XLSX is not accepted** (CSV only), to avoid a spreadsheet-parsing dependency and its attack surface.

## Not done / risks

- Real-database tests of the three new `CurriculumService` read methods and an end-to-end upload → submit → validation run are for CI/Docker (see the Claude Code prompt delivered with this block).
- The AI draft content itself is **not in this block**: the CISCE source text could not be read from the authoring environment, so no structure is drafted until the exact source pages are available (see `docs/curriculum/ICSE_G8_2026-27_EVIDENCE.md`).
- Moderation of uploaded text beyond control characters and length; CSV formula-injection matters only if content is ever exported back to CSV (it is not today).
