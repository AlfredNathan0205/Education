# CONSTRUCTION-008: question bank (multiple choice)

## Why
Exams need vetted questions tied to the curriculum. This block stores them, imports them (upload and AI draft), and puts a human review gate in front of every question.

## Scope (answered by the PM)
- Multiple choice only: four options, one correct.
- Authoring: teacher/admin upload (CSV/JSON) plus AI draft import, same pattern as curriculum content.

## What changed
- Prisma: `question`, `question_revision`, `question_option`, `question_event` and three enums. Needs a migration plus two manual partial unique indexes (see the Claude Code prompt).
- `question-domain.ts`: pure validation and the state machine.
- `QuestionService`: plan/apply for imports, transitions, listing. `QuestionBankService`: the unit list.
- Admin API under `admin/questions`, web page `/admin/questions`, CLI `import-ai-questions.js`.

## Decisions
1. **Roles reuse the curriculum roles.** EDITOR submits; REVIEWER, APPROVER or SUPER_ADMIN decides. A separate question-role set can come later.
2. **Four-eyes rule.** Anyone who authored, edited or submitted a revision cannot approve it. The approver must confirm they verified the answer key.
3. **AI can only create DRAFT questions**, marked `origin = AI_DRAFT`. It cannot submit or approve.
4. **Questions point at an objective by path** (`objective_path`), because curriculum content rows are recreated on each save and their ids are unstable. Approval re-checks that the objective still exists in the newest revision of the unit (any state).
5. **Corrections never edit an approved question.** A change makes a new revision; approving it supersedes the old one.
6. **History is append-only** in `question_event`.

## Not done (deliberately)
- Nothing serves questions to students. Serving only from an ACTIVE curriculum is the exam block's job.
- No images, formulae rendering, other question types, or tagging beyond difficulty.
- Imports are not rate limited beyond the 2000-question and 2 MB caps.
- `docs/question/sample-chemistry-ai-draft.json` holds 12 AI-drafted sample questions for pipeline testing only. A person has not checked their answer keys.

## Verification
70 unit tests (domain, parsers, service, bank service, AI import, controller) pass in the sandbox. DB-backed integration tests are not runnable here (Prisma engines); they run on the Claude Code machine.
