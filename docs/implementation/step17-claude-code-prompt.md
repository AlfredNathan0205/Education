Apply Step 17 (parent claim gate and parent web). Patch: `<path>/parent-step17.patch` (one commit). PR #22 is merged; start from main.

A hand test on the REAL stack in a real browser is a merge condition. Test coverage does not replace any part of it. If a step cannot be done, write NOT DONE with the exact error, the API log lines and the SQL state. Never substitute a test result for a hand-test step.

1. Branch and apply
   - `git checkout main && git pull && git checkout -b parent-step17`
   - `git am --3way <path>/parent-step17.patch`. No conflicts are expected; if there are any, stop and show me.

2. Migration (the extra SQL is required)
   - `pnpm install`
   - `pnpm --filter @exam-app/database exec prisma migrate dev --create-only --name parent`
   - Check that the generated SQL ONLY creates the tables claim_policy_version, student_report, student_report_version, report_claim, suppressed_claim, parent_share_invitation and parent_view_grant, with their indexes and foreign keys. If it drops or alters anything existing, stop and show me.
   - Append the whole of `docs/implementation/CONSTRUCTION-017_PARENT_MIGRATION_EXTRA.sql`.
   - Run `prisma migrate dev`, then `prisma generate`.
   - Show in SQL: `SELECT code, status FROM claim_policy_version;` (CLAIM_V1 ACTIVE), and the PARENT_REPORT_SHARING consent purpose with version 1 and text_reference 'consent-text:PARENT_REPORT_SHARING:v1-draft'.

3. Checks
   - Typecheck the API and the web app.
   - Unit tests: expect 64 suites / 1028 tests.
   - Integration tests: expect 84, of which 2 are new:
     - a guardian approved through the REAL flow sees the gated summary, the weekly report freezes, an invalidation adds version 2, and withdrawing ends access;
     - an adult shares under their own consent, and stopping ends access.

     The Step 16 social test now uses a really approved guardian (no spy).
   - Browser tests: `pnpm --filter @exam-app/web test:e2e`. Expect 34 passing (17 × phone and desktop).
   - If a test fails, decide whether the test or the code is wrong and tell me which. Never weaken an assertion just to make it pass.

4. Hand test: rebuilt Docker images, real API, real browser (Playwright against http://localhost:3000 is fine; one browser context per person, each signing in through the real sign-in page). Keep any script in apps/web/e2e-real/ and do NOT commit it.
   Allowed setup shortcuts: OTPs and links from `docker compose logs api`; accounts created through the real sign-up and onboarding. NOT allowed: SQL inserts or updates of consents, grants, invitations, reports or claims; calling services directly; curl in place of a UI step.
   Use fresh accounts: minor M (date of birth making them a minor), guardian G, adult student A, parent P, stranger S.

   a. Guardian path (the real guardian flow from Block 006).
      - M invites G from their profile; G accepts through the link.
      - M takes two Quick 10 tests, answering mostly right.
      - After "mastery updated" in the log, G opens /guardian:
        - M is named (display name, or a masked email), not "Your child";
        - there is a "See their progress summary" link.
      - G follows the link to /parent. Screenshot it.
      - Show:
        - the labels and sentences on the page, and that the page has no "%" and no score anywhere;
        - SQL: `audit_event` rows `parent.summary_viewed` for G;
        - M's `student_mastery_state` rows (label and reportable only), so the claims can be checked against them.
   b. Stranger. S signs in and calls GET /parent/children/<M's student id> through the web app.
      - Show a 404, not a 403.
      - S's /parent shows "You cannot see any student's progress yet."
   c. Student transparency.
      - M opens Progress: "Your parent or guardian … can see a summary", with no "Invite a parent".
      - "See what they see" shows the same summary G saw. Screenshot both side by side.
   d. Adult sharing.
      - A opens Progress → Share with a parent → Invite a parent. Screenshot the draft wording.
      - Show that Send stays disabled until "I agree" is ticked.
      - A invites P's email. Show SQL:
        - `consent_record` for A with purpose PARENT_REPORT_SHARING and capacity SELF;
        - `parent_share_invitation` PENDING with a 64-character token_hash, and the raw token appearing nowhere in the database.
      - P opens the link from the log while signed out, signs in with that email, is brought back, and accepts.
      - P sees A's summary at /parent ("Stop seeing this summary" is visible). Screenshot it.
      - A's Progress lists P's masked email.
      - A clicks "Stop sharing". Show SQL:
        - `parent_view_grant` ended_reason STUDENT_STOPPED;
        - a `consent_withdrawal` row for that consent;
        - an `audit_event` `parent.sharing_ended` row.
      - P reloads /parent: "You cannot see any student's progress yet."
   e. Weekly report.
      - This needs a week boundary. Do NOT change the system clock or insert reports.
      - Instead, with the API running, call the reconciler once through a one-off script that runs `ParentService.reconcile(new Date(Date.now() + 7*86400000))` inside the API container. That is the only allowed direct call, and it is the same code the 30-second sweeper runs.
      - Show SQL:
        - `student_report` and `student_report_version` v1 WEEK_ENDED for M;
        - `report_claim` and `suppressed_claim` rows;
        - an UPDATE on `student_report_version` refused by the trigger.
      - G opens the report under "Weekly reports" at /parent. Screenshot it.
   f. Withdrawal. G withdraws the approval on /guardian.
      - /parent now says G cannot see any student, and GET /parent/children/<M's id> returns 404.

   If any part cannot be done, write NOT DONE with exactly where it stopped. Do not substitute tests.

5. Commit and PR
   - Commit the migration as "Add parent migration (CLAIM_V1)".
   - Push the branch and open a PR titled "Step 17: parent claim gate and parent web". For the body, use the summary in `docs/implementation/CONSTRUCTION-017_PARENT_INTERPRETATION.md`.
   - Attach the screenshots. Wait for both CI jobs. Do not merge until I say.

Report back as a table:
- PR number
- migration name
- policy check
- unit, integration and browser test counts
- typecheck result
- conflicts
- any fixes and why
- a to f: result, the SQL you ran with its raw output, and screenshot file names
