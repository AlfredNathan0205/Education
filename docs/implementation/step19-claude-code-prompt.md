Apply Step 19 (analytics with a separate consent, and an experiments foundation). Patch: `<path>/analytics-step19.patch` (one commit). PR #24 is merged; start from main.

A hand test on the REAL stack in a real browser is a merge condition. Test coverage does not replace any part of it. If a step cannot be done, write NOT DONE with the exact error, the API log lines and the SQL state. Never substitute a test result for a hand-test step. No SQL inserts, updates or deletes of consents, analytics rows, experiments or assessments during the hand test: use the UI, or ask me.

1. Branch and apply
   - `git checkout main && git pull && git checkout -b analytics-step19`
   - `git am --3way <path>/analytics-step19.patch`. No conflicts are expected; if there are any, stop and show me.

2. Migration (the extra SQL is required)
   - `pnpm install`
   - `pnpm --filter @exam-app/database exec prisma migrate dev --create-only --name analytics`
   - Check that the generated SQL ONLY creates the tables analytics_event, analytics_cursor, experiment, experiment_variant and experiment_assignment, with their indexes and foreign keys. If it drops or alters anything existing, stop and show me.
   - Append the whole of `docs/implementation/CONSTRUCTION-019_ANALYTICS_MIGRATION_EXTRA.sql`.
   - Run `prisma migrate dev`, then `prisma generate`.
   - Show in SQL the PRODUCT_ANALYTICS consent purpose with version 1 and text_reference 'consent-text:PRODUCT_ANALYTICS:v1-draft'.

3. Checks
   - Typecheck the API and the web app.
   - Unit tests: expect 68 suites / 1064 tests.
   - Integration tests (CI if not local): expect 88, of which 2 are new.
   - Browser tests: `pnpm --filter @exam-app/web test:e2e`. Expect 42 passing (21 × phone and desktop).
   - If a test fails, decide whether the test or the code is wrong and tell me which. Never weaken an assertion just to make it pass.

4. Hand test: rebuilt Docker images, real API, real browser (one browser context per person, real sign-in). Keep any script in apps/web/e2e-real/ and do NOT commit it.
   - Allowed setup shortcuts: OTPs from the API log; accounts through the real sign-up and onboarding; one SQL statement granting SUPER_ADMIN to an admin X (show it).
   - Show `docker compose exec api printenv ANALYTICS_ENABLED ANALYTICS_PSEUDONYM_KEY`: the first is empty or true; the key may be unset in development (the code uses a development key and refuses to start without one in production).

   a. Nothing before consent. A fresh adult student A takes one Quick 10 test. Wait 60 seconds.
      - SQL: `SELECT count(*) FROM analytics_event;` is 0 (or unchanged from before A started).
      - A's Progress shows "Help improve Exam App" with "Anonymous usage statistics are off". Screenshot it.
   b. Consent and pseudonymous events.
      - A clicks "Read more", sees the DRAFT wording, and clicks "Allow anonymous statistics". Screenshot it.
      - A takes another Quick 10 test, opens the result, clicks "Practise what you missed", and opens Compete. Wait 60 seconds.
      - Show SQL, raw:
        - `SELECT name, source, cohort, props, occurred_at FROM analytics_event ORDER BY occurred_at;` → SIGNED_UP (dated at A's creation), ASSESSMENT_STARTED, ASSESSMENT_COMPLETED, MASTERY_UPDATED, QUALIFIED_TEST (if CP was awarded), RESULTS_OPENED, PRACTISE_MISSED_CLICKED, COMPETE_OPENED, and no events from A's first test.
        - `SELECT DISTINCT subject_key FROM analytics_event;` is one 32-hex value.
        - That A's student id and account id appear nowhere in analytics_event: `SELECT count(*) FROM analytics_event WHERE subject_key = '<A student id>' OR props::text LIKE '%<A student id>%';` is 0.
      - Show the database refusing `INSERT INTO analytics_event (id, subject_key, name, source, occurred_at) VALUES (gen_random_uuid(), '<32 hex>', 'PAGE_VIEW', 'CLIENT', now());`. This INSERT is expected to fail and is the only allowed SQL write.
   c. Metrics. X opens /admin/metrics and screenshots it: the coverage line, this week's column, and "<5" for small counts. A non-admin opening /admin/metrics sees "Only an administrator may see analytics". Show the audit_event analytics.metrics_viewed row.
   d. Withdrawal. A clicks "Turn off and delete".
      - SQL: `SELECT count(*) FROM analytics_event;` is 0.
      - `consent_withdrawal` has a row for A's PRODUCT_ANALYTICS consent.
      - A takes another test; after 60 seconds, still 0.
   e. A minor and their guardian. Use a minor M with a guardian G approved through the real flow (from earlier steps, or new).
      - M's Progress says "Your parent or guardian decides", with no Allow button. Screenshot it.
      - G opens /guardian: "Anonymous usage statistics", with M named and "off". "Allow" stays disabled until "What is collected" is opened. G allows. Screenshot it.
      - SQL: `consent_record` for M with purpose PRODUCT_ANALYTICS, capacity GUARDIAN, and granted_by G.
      - M takes a test; after 60 seconds, analytics_event has M's events under a different 32-hex key from A's.
      - G clicks "Turn off and delete": M's rows are gone.

   If any part cannot be done, write NOT DONE with exactly where it stopped. Do not substitute tests.

5. Commit and PR
   - Leave ANALYTICS_ENABLED and ANALYTICS_PSEUDONYM_KEY out of every committed config. Add both to the deployment notes, with ANALYTICS_PSEUDONYM_KEY marked "required in production, at least 32 characters, never rotate without a migration".
   - Commit the migration as "Add analytics migration (PRODUCT_ANALYTICS)".
   - Push the branch and open a PR titled "Step 19: analytics (consented, pseudonymous) and experiments foundation". For the body, use the summary in `docs/implementation/CONSTRUCTION-019_ANALYTICS_INTERPRETATION.md`.
   - Attach the screenshots. Wait for both CI jobs. Do not merge until I say.

Report back as a table:
- PR number
- migration name
- consent purpose check
- unit, integration and browser test counts (integration from CI if not run locally)
- typecheck result
- conflicts
- any fixes and why
- a to e: result, the SQL you ran with its RAW output, and screenshot file names
