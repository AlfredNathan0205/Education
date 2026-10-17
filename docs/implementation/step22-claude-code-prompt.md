Apply Step 22 (the admin home, and adding content from the admin pages: the curriculum workflow end to end, one question in a form, and AI drafting). The patch is `<path>/admin-step22.patch` (one commit). PR #27 is merged; start from main.

A hand test on the REAL stack in a real browser is a merge condition. Test coverage does not replace any part of it. If a step cannot be done, write NOT DONE with the exact error, the API log lines and the SQL state. Never substitute a test result for a hand-test step. Make no SQL inserts, updates or deletes of domain data during the hand test: every change goes through the pages, or through the roles CLI where named below. SQL is for reading only.

RAW OUTPUT means the text exactly as the terminal printed it, in a code block, for example:

```
exam_app=# SELECT state, revision FROM curriculum_subject_version WHERE id = '<id>';
 state  | revision
--------+----------
 ACTIVE |        1
(1 row)
```

A sentence such as "1 row, ACTIVE" is a summary, not raw output. Summaries will be sent back. The same goes for screenshots: name each file, and say what it shows only after the file name.

1. Branch and apply
   - `git checkout main && git pull && git checkout -b admin-step22`
   - `git am --3way <path>/admin-step22.patch`. No conflicts are expected; if there are any, stop and show me.

2. Migration: none. This step changes no schema. Run `pnpm --filter @exam-app/database exec prisma migrate dev --create-only --name step22_check`. It must say there is nothing to migrate (no new migration folder). If it creates one, stop and show me its SQL.

3. Checks
   - Typecheck the API and the web app.
   - Unit tests: expect 80 suites / 1205 tests.
   - Integration tests (in CI if not run locally): expect 97, of which 3 are new.
   - Browser tests: `pnpm --filter @exam-app/web test:e2e`. Expect 68 passing (34 × phone and desktop).
   - If a test fails, decide whether the test or the code is wrong and tell me which. Never weaken an assertion just to make it pass.

4. Hand test: rebuilt Docker images, the real API, a real browser, one browser context per person, real sign-in.
   - **Environment:** in your local `.env` (never committed) set `FACTORY_ENABLED=true`, `FACTORY_DAILY_TOKEN_BUDGET=200000` and `AI_PROVIDER=mock`. Show raw: `docker compose exec api printenv FACTORY_ENABLED FACTORY_DAILY_TOKEN_BUDGET AI_PROVIDER NODE_ENV`.
   - **Allowed setup:**
     - OTPs from the API log;
     - accounts through the real sign-up;
     - roles only through the roles CLI (show each output);
     - authenticator codes computed from the key shown on the page.
     Keep any script in apps/web/e2e-real/ and do NOT commit it.
   - **People:**
     - **X**, the admin from Step 21 (SUPER_ADMIN), acting as the editor;
     - **Y**, a new account: `ADMIN_OPERATOR=<you> node dist/authz/cli/roles.js grant email <y> CURRICULUM_APPROVER`;
     - **R**, a new account: `... grant email <r> CURRICULUM_REVIEWER`;
     - **S**, a student with no role.
   - **Selectors** (use them; ask me before improvising others):
     - the state line: `getByRole('status', { name: 'Curriculum state' })`;
     - the step buttons: `getByRole('list', { name: 'Steps' }).getByRole('button', { name: '<label>' })`;
     - the note: `getByLabel(/^Note/)`;
     - the history: `getByRole('list', { name: 'Curriculum history' })`.

   a. The admin home.
      - X signs in and opens `/admin`. After the authenticator, X lands on `/admin` (not `/admin/curriculum`). It shows Curriculum, Questions, Readiness and release, Test designs, Safety reports, Plans and Analytics. Screenshot it.
      - Y's `/admin` (after Y sets up an authenticator) shows the first four only. Screenshot it.
      - S's `/admin` says "Your account has no staff role". Screenshot it.
   b. A new subject, by the editor (X). Use codes that cannot be confused with real content.
      - On `/admin/curriculum`, X clicks "Create a subject" and enters:
        - curriculum code `HT22`, curriculum name `Hand test 22`;
        - version `2026-27`, grade `GRADE_8`;
        - subject code `HT22_SCIENCE`, subject name `Hand test science`.
        X then lands on the subject's page, state Draft. Screenshot it.
      - "Submit for automated checks" is disabled, with "Upload the chapters first". Screenshot it.
      - X adds a source: "Hand test syllabus", `https://example.org/ht22.pdf`, "pages 1 to 2".
      - X uploads `apps/web/e2e-real/ht22.csv`, containing exactly:
        ```
        chapter_code,chapter_title,topic_code,topic_title,concept_code,concept_title,objective_code,objective,evidence_ref,provenance,rationale
        CH01,Matter,CH01-T1,States of matter,CH01-T1-C1,Particles,CH01-T1-C1-O1,Describe the three states of matter,1,OFFICIAL_EXPLICIT,From the hand test syllabus page 1
        CH01,Matter,CH01-T1,States of matter,CH01-T1-C1,Particles,CH01-T1-C1-O2,Explain melting using particles,1,OFFICIAL_EXPLICIT,From the hand test syllabus page 2
        ```
        X checks it, then saves it.
      - X clicks "Submit for automated checks". Paste the message on the page as text.
        - If it reports problems, paste them, fix the CSV only as they say, and upload again.
        - If you cannot make the checks pass, write NOT DONE with the findings.
      - Raw: `SELECT state, revision, last_edited_by IS NOT NULL AS edited FROM curriculum_subject_version WHERE id = '<id>';`
   c. Review and approval.
      - R opens the subject (from `/admin/curriculum`), writes a note, and clicks "Verify the sources". R then clicks "Start the review".
      - Y writes a note and clicks "Approve".
      - X reloads the page. "Activate" is disabled with "You edited this revision: an approver who did not edit it must do this". Screenshot it.
      - Directly against the API with X's session (after X's authenticator):
        ```
        curl -s -X POST http://localhost:3001/admin/curriculum/units/<id>/activate -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"note":"Activating my own work"}'
        ```
        It answers 403 (forbidden), saying an approver who did not edit it must activate it. Paste it raw.
   d. Activation.
      - Y writes "Checked against the hand test syllabus" and clicks "Activate". The page says students still see nothing until release, and links to Readiness and release. Screenshot it.
      - Raw:
        - `SELECT state, activated_at IS NOT NULL FROM curriculum_subject_version WHERE id = '<id>';`
        - `SELECT action, actor_account_id, metadata FROM audit_event WHERE subject_id = '<id>' ORDER BY occurred_at;`
      - S's Home does not list "Hand test science". Screenshot it.
   e. Suspend, resume and correct.
      - Y suspends with the note "Hand test: pausing to check".
      - X reloads: "Resume" is disabled with the same editor sentence. Screenshot it.
      - Y resumes with "Hand test: resuming after the check".
      - X clicks "Start a correction (new revision)". X lands on revision 2, Draft, and its Revisions list shows "Revision 1: Active". Screenshot it.
      - Revision 2 offers "Withdraw this revision" (a correction that is not yet live can be withdrawn by an editor, with a note). Do not withdraw it; leave it as a draft.
      - Screenshot revision 1's History.
      - Raw: `SELECT revision, state FROM curriculum_subject_version WHERE subject_id = (SELECT subject_id FROM curriculum_subject_version WHERE id = '<id>') ORDER BY revision;`
   f. One question in a form (X, on `/admin/questions`, subject "Hand test science").
      - X fills in "Write a question":
        - code `ht22-q1`;
        - objective CH01-T1-C1-O1;
        - question "Which state of matter has a fixed shape?";
        - options Solid, Liquid, Gas, Plasma, correct A;
        - Easy, C1.
        X clicks "Save as draft". The question opens below with "Solid ✔ correct". Screenshot it.
      - X saves again with option B empty: the page lists the problem and nothing is saved. Paste the message.
      - Raw: `SELECT q.code, r.state, r.origin, r.difficulty, r.cognitive FROM question q JOIN question_revision r ON r.question_id = q.id WHERE q.code LIKE 'HT22-%';`
      - R opens `/admin/questions`. Saving a question in the form is refused ("only an editor…"). Paste the message.
   g. AI drafting (X, same page).
      - The AI drafting section shows "Provider mock" and today's tokens. Screenshot it.
      - X clicks a short cell (or types CH01-T1-C1-O2), chooses Hard and C3, asks for 3, and clicks "Draft questions". Paste the result line.
      - The list shows the new drafts marked "AI draft". Screenshot it.
      - Raw:
        - `SELECT status, requested_count, drafts_stored, rejected FROM generation_batch ORDER BY started_at DESC LIMIT 1;`
        - `SELECT r.state, r.origin, count(*) FROM question_revision r JOIN question q ON q.id = r.question_id WHERE q.objective_path LIKE '%CH01-T1-C1-O2' GROUP BY 1, 2;` Every row must be DRAFT and AI_DRAFT.
        - the audit_event `factory.batch_run` row.
      - Asking for 11 drafts is refused with "1 to 10". Paste it.
   h. Leave the hand-test subject as it is. Do not delete it by SQL. Tell me its id.

   If any part cannot be done, write NOT DONE with exactly where it stopped. Do not substitute tests.

5. Commit and PR
   - Leave FACTORY_ENABLED, FACTORY_DAILY_TOKEN_BUDGET and AI_PROVIDER out of every committed config.
   - Push the branch and open a PR titled "Step 22: admin home, curriculum workflow, questions in a form, AI drafting". For the body, use the summary in `docs/implementation/CONSTRUCTION-022_ADMIN_INTERPRETATION.md`.
   - Attach the screenshots. Wait for both CI jobs. Do not merge until I say.

Report back as a table:
- PR number
- the migration check (raw)
- unit, integration and browser test counts (integration from CI if not run locally)
- typecheck result
- conflicts
- any fixes, and why
- a to h: result, every SQL statement, curl and CLI command with its RAW output in a code block, and the screenshot file names
