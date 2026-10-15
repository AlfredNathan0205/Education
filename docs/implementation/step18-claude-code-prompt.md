Apply Step 18 (entitlements and subscription foundation; no payment provider). Patch: `<path>/entitlements-step18.patch` (one commit). PR #23 is merged; start from main.

A hand test on the REAL stack in a real browser is a merge condition. Test coverage does not replace any part of it. If a step cannot be done, write NOT DONE with the exact error, the API log lines and the SQL state. Never substitute a test result for a hand-test step.

1. Branch and apply
   - `git checkout main && git pull && git checkout -b entitlements-step18`
   - `git am --3way <path>/entitlements-step18.patch`. No conflicts are expected; if there are any, stop and show me.

2. Migration (the extra SQL is required)
   - `pnpm install`
   - `pnpm --filter @exam-app/database exec prisma migrate dev --create-only --name entitlements`
   - Check that the generated SQL ONLY creates the tables entitlement, plan, subscription, subscription_event and entitlement_grant, with their indexes and foreign keys. If it drops or alters anything existing, stop and show me.
   - Append the whole of `docs/implementation/CONSTRUCTION-018_ENTITLEMENT_MIGRATION_EXTRA.sql`.
   - Run `prisma migrate dev`, then `prisma generate`.
   - Show in SQL: `SELECT code, is_default, values FROM plan ORDER BY code;` (BETA, FREE default, PLUS) and `SELECT key, kind FROM entitlement;` (3 rows).

3. Checks
   - Typecheck the API and the web app.
   - Unit tests: expect 66 suites / 1045 tests. One of them is the spec's regression "paid entitlement does not alter CP": it fails if mastery, competition, recommendations, social, privacy, guardian or the parent claim rules ever read plans.
   - Integration tests (CI runs them if they cannot run locally): expect 86, of which 2 are new:
     - FREE limits self-chosen starts, and the beta grant lifts them;
     - admin grants and ends a plan, and the holder rules.
   - Browser tests: `pnpm --filter @exam-app/web test:e2e`. Expect 38 passing (19 × phone and desktop).
   - If a test fails, decide whether the test or the code is wrong and tell me which. Never weaken an assertion just to make it pass.

4. Hand test: rebuilt Docker images, real API, real browser (Playwright against http://localhost:3000 is fine; one browser context per person, each signing in through the real sign-in page). Keep any script in apps/web/e2e-real/ and do NOT commit it.
   Allowed setup shortcuts: OTPs from `docker compose logs api`; accounts created through the real sign-up and onboarding; one SQL statement granting SUPER_ADMIN to an admin account X (show it). NOT allowed: SQL inserts or updates of plans, subscriptions, grants or assessments; calling services directly; curl in place of a UI step.

   a. FREE, before the beta. Make sure BETA_GRANT_UNTIL is NOT set for the api (show `docker compose exec api printenv BETA_GRANT_UNTIL` is empty). Use a fresh adult student F.
      - F opens /tests: "Your plan: Free · 3 tests or practice sets left to start today". Screenshot it.
      - If a Subject 20 or 25 test is offered for F's subject, it is greyed out with "Longer tests are not included in your plan". If none is offered on this stack, say so and show `SELECT code, enabled FROM assessment_blueprint;`.
      - F starts three self-chosen tests or practice sets (for example a Chemistry Quick 10 test, a Physics Quick 10 test, and a Chemistry Quick 10 practice). F finishes the first one, getting several answers wrong.
      - Back on /tests: "You've started all the tests your plan includes today", and the start buttons are greyed out. Screenshot it.
      - Through the web app, POST /exam/assessments for a fourth test returns 403 with that sentence. Show the response.
      - **The core loop is still open:** from the first test's result, "Practise what you missed" starts a practice set. Screenshot it. Show SQL: today's assessment_instance rows for F with recommendation_id and blueprint_code (3 self-chosen with NULL recommendation_id, 1 with a recommendation).
   b. The beta. Set BETA_GRANT_UNTIL to a date about 30 days ahead for the api service only, restart it, and show the env var. Wait for the log line "plans: N beta granted".
      - Show SQL: subscription rows source BETA, status ACTIVE, holder_account_id NULL, with ends_at at the end of that day India time, one per student; and subscription_event CREATED rows.
      - F's /tests now shows "Your plan: Beta (until …)", with no daily limit line, and F can start a new test. Screenshot it.
      - Show the database refusing a second active BETA for F (one INSERT, expected to fail, show the error), and refusing an UPDATE on subscription_event (the trigger).
   c. Administration. X opens /admin/plans, finds F by email, and grants Plus held by F's own email, with an end date and a reason. Screenshot it.
      - Then X tries to grant Plus to a minor M (any minor from earlier tests) held by M's own email: the page shows "A minor cannot hold a plan".
      - X ends F's Plus plan with a reason.
      - Show SQL: F's subscription rows and their subscription_event history (CREATED, ENDED), and audit_event rows entitlement.viewed_by_staff, entitlement.plan_granted and entitlement.plan_ended.
      - A non-admin student opening /admin/plans and searching gets "Only an administrator may manage plans" (403).
   d. Leave BETA_GRANT_UNTIL unset in every committed config.

   If any part cannot be done, write NOT DONE with exactly where it stopped. Do not substitute tests.

5. Commit and PR
   - Commit the migration as "Add entitlements migration (FREE, BETA, PLUS)".
   - Push the branch and open a PR titled "Step 18: entitlements and subscription foundation (no payments)". For the body, use the summary in `docs/implementation/CONSTRUCTION-018_ENTITLEMENT_INTERPRETATION.md`.
   - Attach the screenshots. Wait for both CI jobs. Do not merge until I say.

Report back as a table:
- PR number
- migration name
- plan check
- unit, integration and browser test counts (integration from CI if not run locally)
- typecheck result
- conflicts
- any fixes and why
- a to d: result, the SQL you ran with its RAW output, and screenshot file names
