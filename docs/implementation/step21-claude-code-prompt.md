Apply Step 21 (content readiness and release tiers). The patch is `<path>/readiness-step21.patch` (one commit). PR #26 is merged; start from main.

A hand test on the REAL stack in a real browser is a merge condition. Test coverage does not replace any part of it. If a step cannot be done, write NOT DONE with the exact error, the API log lines and the SQL state. Never substitute a test result for a hand-test step. Make no SQL inserts, updates or deletes of domain data during the hand test, except the single statement in g that is expected to FAIL. Use the UI or the CLIs named below, or ask me.

RAW OUTPUT means the text exactly as the terminal printed it, in a code block, for example:

```
exam_app=# SELECT code, status, signed_off_at FROM readiness_policy_version;
     code     | status | signed_off_at
--------------+--------+---------------
 READINESS_V1 | ACTIVE |
(1 row)
```

A sentence such as "1 row, ACTIVE, not signed off" is a summary, not raw output. Summaries will be sent back.

1. Branch and apply
   - `git checkout main && git pull && git checkout -b readiness-step21`
   - `git am --3way <path>/readiness-step21.patch`. No conflicts are expected; if there are any, stop and show me.

2. Migration (the extra SQL is required)
   - `pnpm install`
   - `pnpm --filter @exam-app/database exec prisma migrate dev --create-only --name readiness`
   - Check that the generated SQL ONLY creates the tables subject_release, subject_release_event, release_access, readiness_policy_version and readiness_report, with their indexes and the foreign keys release_event → release and report, and report → policy. If it drops or alters anything existing, stop and show me.
   - Append the whole of `docs/implementation/CONSTRUCTION-021_READINESS_MIGRATION_EXTRA.sql`.
   - Run `prisma migrate dev`, then `prisma generate`.
   - Show raw: `SELECT code, status, signed_off_at, params->'objective' AS objective FROM readiness_policy_version;`

3. Checks
   - Typecheck the API and the web app.
   - Unit tests: expect 77 suites / 1183 tests.
   - Integration tests (in CI if not run locally): expect 94, of which 2 are new.
   - Browser tests: `pnpm --filter @exam-app/web test:e2e`. Expect 58 passing (29 × phone and desktop).
   - If a test fails, decide whether the test or the code is wrong and tell me which. Never weaken an assertion just to make it pass.

4. Hand test: rebuilt Docker images, the real API, a real browser, one browser context per person, real sign-in, and RELEASE_GATING_ENABLED unset. Keep any script in apps/web/e2e-real/ and do NOT commit it.
   - **Allowed setup:**
     - OTPs from the API log;
     - accounts through the real sign-up and onboarding;
     - roles only through the roles CLI: `ADMIN_OPERATOR=<you> node dist/authz/cli/roles.js grant email <x> SUPER_ADMIN`, then the same with CURRICULUM_APPROVER (show the output);
     - authenticator codes computed from the key shown on the page.
   - **People:** admin X (SUPER_ADMIN and CURRICULUM_APPROVER), and two adult students A and B in the cohort of a subject that is ACTIVE in your dev data with published questions. Name the subject you use.

   a. The gate is on.
      - Raw: `SELECT count(*) FROM subject_release;` is 0.
      - Student A's Home and Test pages show the "Coming soon" or "not available" state for that cohort. Screenshot both.
   b. The readiness page.
      - X opens /admin/readiness. If it sends X to /admin/mfa first, complete that. The policy line says PROVISIONAL.
      - On the subject, click "Check readiness now". Screenshot the report, with every tier opened.
      - Copy the check list into the report as text.
      - Raw: `SELECT highest_tier, subject_version_id, generated_at FROM readiness_report ORDER BY generated_at DESC LIMIT 1;`
      - "Release to Internal (alpha)" is disabled unless INTERNAL passes. Say which.
   c. The CLI gives the same verdict. Paste raw: `docker compose exec api node dist/release/cli/readiness.js report <curriculum> <grade> <subject>`.
   d. Release for internal testing. Your dev bank will almost certainly not pass READINESS_V1. Publish a test policy through the operator CLI, which is allowed here:
      - Write `/tmp/handtest-policy.json` in the API container:
        `{"objective":{"limited":1,"assessmentReady":2,"robust":3},"tiers":{"INTERNAL":{"objectivesLimitedShare":0,"objectivesReadyShare":0,"objectivesRobustShare":0,"chapterMin":1,"chapterMinPerDifficulty":0,"chapterMinCognitive":0,"maxQualityIssueShare":1,"designDepth":1},"CONTROLLED":{"objectivesLimitedShare":0,"objectivesReadyShare":0,"objectivesRobustShare":0,"chapterMin":1,"chapterMinPerDifficulty":0,"chapterMinCognitive":0,"maxQualityIssueShare":1,"designDepth":1},"GENERAL":{"objectivesLimitedShare":0,"objectivesReadyShare":0,"objectivesRobustShare":0,"chapterMin":1,"chapterMinPerDifficulty":0,"chapterMinCognitive":0,"maxQualityIssueShare":1,"designDepth":1}}}`
      - Run `ADMIN_OPERATOR=<you> node dist/release/cli/readiness.js policy publish DEV_HANDTEST /tmp/handtest-policy.json "hand test only"` and paste the output raw.
      - X reloads the page (policy DEV_HANDTEST, PROVISIONAL), checks readiness again (INTERNAL passes), writes a note, and clicks "Release to Internal (alpha)". Screenshot it.
      - Raw: `SELECT tier, changed_at FROM subject_release;` and `SELECT from_tier, to_tier, readiness_report_id IS NOT NULL AS cites_report, note FROM subject_release_event;` and the audit_event `release.promoted` row.
      - A still sees "Coming soon". X gives A INTERNAL access on the page (Early access) with a reason. A reloads Home: the subject is there, and A starts and submits a Quick 10 test. Screenshots.
      - B still sees "Coming soon". Screenshot it.
   e. The beta needs sign-off.
      - X checks again. "Release to Controlled (beta)" is disabled, with the hint about sign-off. Screenshot it.
      - Directly against the API with X's session: `curl -s -X POST http://localhost:3001/admin/readiness/units/<id>/release -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"to":"CONTROLLED","reportId":"<latest report id>","note":"Beta bank checked by the lead"}'` answers 409 with "needs a readiness policy signed off by an academic lead". Paste it raw.
      - Run `ADMIN_OPERATOR=<you> node dist/release/cli/readiness.js policy sign-off DEV_HANDTEST "Hand Test Lead" "hand test only"` (raw).
      - X reloads, checks again, and releases to Controlled (beta).
      - X gives B CONTROLLED access. B now sees the subject. Screenshot it.
   f. Bulk access. Make a file with B's email and `nobody-step21@example.com`, and run `ADMIN_OPERATOR=<you> node dist/release/cli/readiness.js access CONTROLLED <file> "Beta wave 1"`. Paste the output raw: B is "not given (They already have CONTROLLED access)", and nobody-step21 is "not given (… sign in once first)".
   g. Taking it back.
      - X writes a note and clicks "Move back to Not released". A and B both see "Coming soon" again. Screenshots.
      - The page's History shows three changes. Screenshot it.
      - Raw: `UPDATE subject_release_event SET note = 'rewritten note text';` must FAIL with "append-only". This is the only SQL write allowed, and it is expected to fail.
   h. Restore the real thresholds.
      - Copy READINESS_V1's params: `docker compose exec api node dist/release/cli/readiness.js policy` prints the active policy. If DEV_HANDTEST is active, take READINESS_V1's params from `SELECT params FROM readiness_policy_version WHERE code = 'READINESS_V1';`.
      - Write them to a file and publish them as READINESS_V1R (`policy publish READINESS_V1R <file> "restored after the hand test"`).
      - Paste `readiness.js policy` raw: READINESS_V1R, PROVISIONAL, with the V1 numbers.

   If any part cannot be done, write NOT DONE with exactly where it stopped. Do not substitute tests.

5. Commit and PR
   - Leave RELEASE_GATING_ENABLED out of every committed config. Add it to the deployment notes as "development only; refused in production".
   - Commit the migration as "Add readiness migration (release tiers, readiness policy and reports)".
   - Push the branch and open a PR titled "Step 21: content readiness and release tiers". For the body, use the summary in `docs/implementation/CONSTRUCTION-021_READINESS_INTERPRETATION.md`.
   - Attach the screenshots. Wait for both CI jobs. Do not merge until I say.

Report back as a table:
- PR number
- migration name
- the seeded policy (raw)
- unit, integration and browser test counts (integration from CI if not run locally)
- typecheck result
- conflicts
- any fixes, and why
- a to h: result, every SQL statement and CLI command with its RAW output in a code block, and the screenshot file names
