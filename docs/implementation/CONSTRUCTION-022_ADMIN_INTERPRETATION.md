# Step 22: the admin pages, and adding content from them

Spec sources:
- `BUILD_SEQUENCE.md` 22. It is a launch stage (the alpha), not only code. This step builds the tools the alpha needs to fill the bank. The alpha itself depends on people (see "People, not code").
- `STATE_MACHINES.md`: the curriculum lifecycle (DRAFT → VALIDATION_PENDING → VALIDATED → ADMIN_REVIEW → APPROVED → ACTIVE, with SUSPENDED, CHANGES_REQUIRED, WITHDRAWN and correction revisions).
- `MASTER_SPEC.md`: "AI never approves"; a human approves every question, and never their own.
- Step 21's open item 6: "Curriculum activation has no admin page or API route."

**PM decisions (17 October):**
- **Content:** the curriculum end to end; writing questions in a form; starting AI question drafting; bulk question upload stays.
- **Activation:** by an approver who did not edit the revision.
- **Live changes:** suspending, and correcting with a new revision, are both on the page.
- **Navigation:** one admin home.

## Built
- **One admin home** at `/admin`. It reads the account's roles from the API (`GET admin/me`, from the database, never from the request) and shows the pages those roles open. The authenticator check (Step 20) applies as on every admin page. After it, people now land on `/admin` (it was `/admin/curriculum`). An account with no role sees "Your account has no staff role".
- **The curriculum workflow, end to end, on one page per subject** (`/admin/curriculum/<id>`):
  - **Create a subject** from the list page: curriculum, version, grade and subject codes (capitals, digits, - and _) and names. Editors only.
  - **Syllabus sources:** title, an http(s) link, where in it, and the date retrieved. Adding one after verification un-verifies the pack, as before.
  - **Content:** the existing CSV or JSON upload, check first and then save. It moved from the list page to the subject's page.
  - **Steps,** each a button: submit for the automated checks; verify the sources; start the review; send back for changes; approve; activate; suspend; resume; start a correction; withdraw.
    - Every step that changes the state, except submitting and starting the review, needs a note of 10 to 1,000 characters, kept in the history.
    - The API says, for this person, which steps they may take and why not (for example "You edited this revision: an approver who did not edit it must do this"). The page shows only the steps that apply in the current state. Every rule is checked again when a step is taken.
  - **The page also shows:** the latest automated check and its findings; every revision of the subject; who edited this revision; and the history (the last 100 events, with who and the note).
  - **The activation rule (new):** an *editor* of a revision is anyone who created it, uploaded content to it, added a source to it, or created it as a correction, and also its last editor. No editor may activate it, and no editor may resume it after a suspension (resuming is an activation), not even a super administrator. Activation and resumption are audited (`curriculum.activated`, `curriculum.resumed`), and so is suspension (`curriculum.suspended`).
  - **Activating does not release.** The page says so and links to the readiness page: students see a subject only once it is released (Step 21).
- **Write one question in a form,** on the Questions page: code, learning objective (a list from the subject's curriculum), question, four options, the correct one, difficulty, cognitive level, and explanation.
  - **The same rules as a file:** the API turns the form into a one-question upload and uses exactly the same checks and save. Problems are reported field by field and nothing is written.
  - **After saving:** the question is a DRAFT, and it opens below so the editor can submit it. The same code again changes it, or makes a new version of an approved question.
  - **Duplicate objective codes:** an objective code used in more than one chapter is marked, and saving is refused until the curriculum gives it its own code. This is the existing upload rule; the form just shows it first.
- **AI drafting from the page,** on the Questions page:
  - **Status:** whether drafting can run here, in plain words when it cannot (switched off, no budget, no provider), the provider, and today's tokens against the daily budget.
  - **Where questions are short:** the objective × difficulty cells furthest below 8 approved questions, from the Step 6 coverage report. Clicking one fills the form.
  - **Running it:** a batch of 1 to 10 drafts. The page waits while it runs. Editors and super administrators only, and audited (`factory.batch_run`).
  - **Batches:** the recent batches, with a Stop button while one runs.
  - **Unchanged from Step 8:** the factory itself. Every draft is an AI_DRAFT question in DRAFT, which a person submits and a different person approves. The AI approves nothing.
- **Bulk question upload** is unchanged, under "Upload many questions from a file".
- **New API routes** (all behind the session, the authenticator and the role checks):

  | Route | What it does |
  |---|---|
  | `GET admin/me` | the account's roles |
  | `POST admin/curriculum/units` | create a subject |
  | `GET admin/curriculum/units/:id` | the subject's detail |
  | `POST admin/curriculum/units/:id/evidence` | add a source |
  | `POST admin/curriculum/units/:id/{verify-evidence, send-to-review, request-changes, approve, activate, suspend, resume, correction, withdraw}` | one step each |
  | `GET admin/questions/units/:id/objectives` | the objectives for the form |
  | `POST admin/questions/units/:id/question` | save one question |
  | `GET admin/factory/status` | whether drafting can run |
  | `GET admin/factory/units/:id/suggestions` | the short cells |
  | `GET admin/factory/batches` | recent batches |
  | `POST admin/factory/batches` | run a batch |
  | `POST admin/factory/batches/:id/stop` | stop a batch |

  The web server's allow-list matches each exactly.

## Assumptions and open decisions (please confirm)
1. **Separation of duties covers activation only.** As decided, an editor of a revision cannot activate or resume it.
   - **Not covered:** approving a revision you edited. The state machine already needs an APPROVER or SUPER_ADMIN role to approve, but a super administrator who uploaded the content can still approve it.
   - **Should approval exclude editors too?** It would be a one-line change, applied to the same "editor" definition.
2. **Where the rule lives:** in the admin page's service, not in the core curriculum service. The seed command and the CLI can still activate with one person, and the integration tests rely on that.
   - **Before real content:** decide whether the CLI should obey the rule too. I recommend yes before the beta. It changes the test setup, not the product.
3. **Resuming overwrites the activation time.** It reuses the core activation, which also writes a second activation record. The history shows both.
4. **AI drafting from the page is small and synchronous** (up to 10 drafts while the person waits). Larger runs stay with the factory CLI. If the alpha needs hundreds of drafts, a background job with progress is the next step.
5. **The AI provider:** only the mock provider exists (Step 8), and it is refused in production. So on a production-like stack the page says drafting is not available. **A real provider, its contract, its cost and its data terms are open.** The contract and data terms are counsel and PM items: what is sent, where it is processed, and how long it is kept.
6. **The coverage target on the page is fixed at 8.** That is READINESS_V1's "assessment-ready" level per objective. The web proxy does not pass query strings, so the page cannot ask for another target. The API accepts `?target=` for direct use.
7. **The role list on the admin home is a guide only:** the API decides. Safety, Plans and Analytics are shown to super administrators only, matching their API checks.

## People, not code
- **Content volume:** about 600 servable questions per subject for the beta and 1,200 for general release (Step 21's arithmetic). That is authoring, AI drafting, review and publication work for people.
- **Academic sign-off:** READINESS_V1 is still provisional. CONTROLLED and GENERAL releases need a named academic lead's sign-off.
- **Activation:** the four subjects need an approver who did not edit them. With one administrator, someone else must be given CURRICULUM_APPROVER, or the subjects cannot be activated from the page.
- **Counsel, from earlier steps:** consent wording, retention, erasure and the privacy notice (`SECURITY_PRIVACY_LAUNCH_REVIEW.md`), and now the AI provider's data terms (item 5).

## Not built
- A real AI provider.
- Background AI batches.
- Separation of duties on approval, and in the CLI (items 1 and 2).
- Editing a single chapter or objective in a form: the curriculum is still uploaded as a whole subject.
- Variant levels and objective tiers (Step 21, items 2 and 3).

## Migration
None. No schema change: the step uses existing tables (the curriculum tables, questions, `generation_batch`, `ai_call_log`, `audit_event`). Step 20's erasure-map test is unchanged and passes.

## Checks done here
- **Unit tests: 80 suites, 1205 tests** (Step 21 had 77 and 1185). New:
  - **The workflow rules (8):** which steps each role may take in each state; activation and resumption refused to an editor and needing verified sources; one correction at a time; the reasons given.
  - **The workflow service against an in-memory store (5):** the detail (sources numbered, who verified, counts, the latest check, revisions, editors, history); the activation rule and its audit; suspend and resume; codes checked on create; source links and notes checked.
  - **One question in a form (3):** it goes through the same checks and write as an upload, and returns the revision; problems are reported and nothing is written; editors only, while anyone with a role can list objectives, with duplicate codes marked.
  - **AI drafting (4):** switched off, with no budget, or with no provider, it says why and nothing runs; the short cells and the target bounds; editors only; batch size and inputs checked.
  - The in-memory store now returns nested selects (needed for the chapter counts).
- **Typecheck:** clean for the API (including the tests) and the web app.
- **Browser tests: 68 of 68 pass** (34 × phone and desktop). New:
  - the admin home lists each page, and a student has no staff role;
  - an editor creates a subject, adds a source, uploads and saves the content, and submits it: checked, with the history;
  - the editor cannot activate; a different approver activates with a note, suspends and resumes it, and the editor starts a correction (revision 2, with the revisions list);
  - an editor writes a question in the form, it opens with the right answer marked, and AI drafting from a short cell saves 3 drafts that appear in the list.
- **Not run here:** the 3 new real-database integration tests:
  - the workflow end to end: activation refused to the editor (a super administrator) and allowed to a different approver, with the audit row;
  - suspend, resume (refused to the editor) and a correction;
  - one question saved from the form through the real upload path, refused for a reviewer.
