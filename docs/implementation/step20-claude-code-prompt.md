Apply Step 20 (security, privacy and compliance hardening: data export and erasure, an authenticator for administrators, retention, rate limits and security headers). The patch is `<path>/security-step20.patch` (one commit). PR #25 is merged; start from main.

A hand test on the REAL stack in a real browser is a merge condition. Test coverage does not replace any part of it. If a step cannot be done, write NOT DONE with the exact error, the API log lines and the SQL state. Never substitute a test result for a hand-test step. Make no SQL inserts, updates or deletes of accounts, students, consents, requests or authenticators during the hand test, except the statements explicitly allowed below. Use the UI, or ask me.

1. Branch and apply
   - `git checkout main && git pull && git checkout -b security-step20`
   - `git am --3way <path>/security-step20.patch`. No conflicts are expected; if there are any, stop and show me.

2. Migration (the extra SQL is required)
   - `pnpm install`
   - `pnpm --filter @exam-app/database exec prisma migrate dev --create-only --name security`
   - Check that the generated SQL ONLY does these things, and stop and show me if it drops or alters anything else:
     - creates the tables privacy_request, deletion_tombstone, admin_mfa_factor, admin_mfa_recovery_code and retention_run, with their indexes;
     - adds the one foreign key, admin_mfa_recovery_code → admin_mfa_factor;
     - adds the columns account.erased_at, last_sign_in_at and inactive_flagged_at, student.erased_at, and auth_session.mfa_verified_at.
   - Append the whole of `docs/implementation/CONSTRUCTION-020_SECURITY_MIGRATION_EXTRA.sql`.
   - Run `prisma migrate dev`, then `prisma generate`.
   - Show in SQL that every account that has sessions now has a last_sign_in_at: `SELECT count(*) FILTER (WHERE last_sign_in_at IS NULL) AS missing FROM account a WHERE EXISTS (SELECT 1 FROM auth_session s WHERE s.account_id = a.id);` returns 0.

3. Checks
   - Typecheck the API and the web app.
   - Unit tests: expect 74 suites / 1145 tests.
   - Integration tests (in CI if not run locally): expect 92, of which 4 are new.
   - Browser tests: `pnpm --filter @exam-app/web test:e2e`. Expect 52 passing (26 × phone and desktop).
   - If a test fails, decide whether the test or the code is wrong and tell me which. Never weaken an assertion just to make it pass.

4. Hand test: rebuilt Docker images, the real API, a real browser, one browser context per person, real sign-in. Keep any script in apps/web/e2e-real/ and do NOT commit it.
   - **Allowed setup shortcuts:**
     - OTPs from the API log;
     - accounts through the real sign-up and onboarding;
     - one SQL statement granting SUPER_ADMIN to an admin X (show it);
     - authenticator codes from a real authenticator app, or computed from the key shown on screen with a small script in e2e-real (for example `oathtool --totp -b <key>`). The key must come from the page, never from the database.
     - Only to skip the 14-day wait: one `UPDATE privacy_request SET due_at = now() WHERE id = '<id>' AND status = 'PENDING';` per erasure in e and f (show each, and its row count).
   - **Environment:** in your local `.env` (never committed), set `BFF_SHARED_SECRET` to 40 random characters. docker-compose passes the same variable to the web container. Show `docker compose exec api printenv BFF_SHARED_SECRET MFA_ENFORCED RATE_LIMIT_ENABLED`. Only the first should be set.

   a. Headers.
      - `curl -sI http://localhost:3000/sign-in` shows Content-Security-Policy (with `frame-ancestors 'none'`), X-Frame-Options DENY, X-Content-Type-Options nosniff and Referrer-Policy, and no X-Powered-By.
      - `curl -sI http://localhost:3001/health` shows the API's Content-Security-Policy `default-src 'none'; frame-ancestors 'none'`, Cache-Control no-store, and no X-Powered-By.
      - Paste both raw.
   b. Rate limit. Make 11 POSTs to `http://localhost:3001/identity/otp/request` within a minute with `{"kind":"EMAIL","identifier":"ratelimit@example.com"}`. Show that the first 10 are accepted and the 11th is a 429 with Retry-After. Paste the raw status lines and headers.
   c. Authenticator (admin X).
      - X signs in and opens /admin/metrics. The browser lands on /admin/mfa?next=%2Fadmin%2Fmetrics. Screenshot it.
      - X clicks "Start set-up" and enters a wrong code: "That code did not work". Then X enters the right code. The 10 recovery codes are shown; screenshot them, and note the first one. "I have saved them, continue" opens Metrics. Screenshot it.
      - SQL:
        - `SELECT status, left(secret_ciphertext, 3) AS fmt, activated_at IS NOT NULL AS confirmed, last_used_step IS NOT NULL AS used FROM admin_mfa_factor;` returns ACTIVE, v1:, true, true.
        - `SELECT count(*) FROM admin_mfa_factor WHERE secret_ciphertext LIKE '%<the key from the page, no spaces>%';` returns 0.
        - `SELECT count(*), count(used_at) FROM admin_mfa_recovery_code;` returns 10, 0.
      - In a new browser context, X signs in again. /admin/metrics sends them to "Confirm it is you". X clicks "Use a recovery code" and enters the first one, and Metrics opens. In a third context, the same recovery code is refused.
      - Directly against the API, with that third context's session (take the token from its cookie), `curl -s http://localhost:3001/admin/analytics/metrics -H "Authorization: Bearer <token>"` answers 403 with `"code":"MFA_REQUIRED"`. Paste it raw.
      - A non-admin student opening /admin/metrics sees "Only an administrator may see analytics", not the authenticator page.
      - Show the audit_event rows for X with actions starting with `mfa.` (action and occurred_at).
   d. A copy (adult A, with at least one test taken, and a public handle: open Compete once).
      - A opens Progress, then "Your data", then "Download my data". Screenshot it.
      - Show the file's top-level keys and the list of `tables` keys.
      - `grep -c -E 'token_hash|code_hash|idempotency_key|secret_ciphertext' <file>` returns 0.
      - Show the audit_event `privacy.export.downloaded` row and the privacy_request row (kind EXPORT, status COMPLETED).
      - Download 3 more times: the 4th in 24 hours says "3 times a day".
   e. Erasure (adult A).
      - A clicks "Delete your account", then "Keep it", then "Delete your account" again, then "Yes, delete in 14 days". The date shown is 14 days from now. Screenshot it.
      - A cancels ("Deletion cancelled."), then asks again.
      - SQL: one privacy_request with kind ERASURE, status PENDING, and a due_at 14 days out; and one with status CANCELLED and cancelled_by_account_id = A.
      - Note A's handle from Compete first. Run the allowed due_at UPDATE, then `docker compose exec api node dist/rights/cli/erasure.js run-due` (expect `{"completed":1,"failed":0}`).
      - SQL, raw:
        - `SELECT count(*) FROM authentication_identity WHERE account_id = '<A account>';` returns 0. The same for auth_session, age_classification (by student), public_profile (by student) and account_student_access (by student).
        - `SELECT status, erased_at IS NOT NULL FROM account WHERE id = '<A account>';` returns CLOSED, true.
        - `SELECT display_name, erased_at IS NOT NULL FROM student WHERE id = '<A student>';` returns null, true.
        - `SELECT count(*) FROM assessment_result WHERE student_id = '<A student>';` is unchanged (kept).
        - `SELECT p.code, w.reason_code FROM consent_record r JOIN consent_purpose p ON p.id = r.consent_purpose_id LEFT JOIN consent_withdrawal w ON w.consent_record_id = r.id WHERE r.student_id = '<A student>';`: every row is withdrawn; those still live at erasure show ERASURE.
        - `SELECT subject_type, subject_id, account_ids FROM deletion_tombstone;` holds ids only.
      - In A's open browser, opening Home goes to sign-in (the session is gone).
      - A signs in again with the same email and lands on a new profile (onboarding).
      - Another student B opens Compete: A's old handle is not on any board.
   f. Erasure by a guardian (a minor M with a guardian G approved through the real flow).
      - M opens /privacy: "Ask your parent or guardian", with no delete button. Screenshot it.
      - G opens /guardian, then "Your data". G's own deletion says "You approve a child…". G downloads M's copy, then deletes M's account (14 days). Screenshot it.
      - Run the allowed due_at UPDATE for M's request, then `run-due`.
      - SQL:
        - M's account is CLOSED and G's is ACTIVE;
        - `SELECT status FROM guardian_relationship WHERE student_id = '<M student>';` returns REVOKED;
        - guardian_authority for it has revoked_at set;
        - guardian_invitation for M has count 0.
      - G's "Your data" page no longer lists M, and now offers "Delete your account" (do not run it).
   g. Tombstones.
      - Show the output of `docker compose exec api node dist/rights/cli/erasure.js tombstones` (2 lines, ids only).
      - Write it to a file inside the container, and run `... erasure.js reapply <file>`: "Reapplied 2; 0 no longer present."
      - Then show that the SQL from e and f still holds.
   h. Retention. Run `docker compose exec api node dist/rights/cli/erasure.js retention` and paste its JSON. Then show `SELECT ok, counts FROM retention_run ORDER BY started_at DESC LIMIT 1;` and the audit_event `retention.run` row.

   If any part cannot be done, write NOT DONE with exactly where it stopped. Do not substitute tests.

5. Commit and PR
   - Leave MFA_ENCRYPTION_KEY, BFF_SHARED_SECRET, MFA_ENFORCED, MFA_SESSION_HOURS, ERASURE_ENABLED, RETENTION_ENABLED, RATE_LIMIT_ENABLED and every RETENTION_* value out of committed config. The docker-compose `${BFF_SHARED_SECRET:-}` pass-through in the patch is fine.
   - Add them to the deployment notes:
     - MFA_ENCRYPTION_KEY and BFF_SHARED_SECRET are "required in production, at least 32 characters". BFF_SHARED_SECRET must be the same on the API and web servers. Rotating MFA_ENCRYPTION_KEY means every admin's authenticator must be reset.
     - Point to `docs/implementation/SECURITY_PRIVACY_LAUNCH_REVIEW.md` for the kill switches, the tombstone export schedule, and "one API instance until rate limits use a shared store".
   - Commit the migration as "Add security migration (data rights, admin MFA, retention)".
   - Push the branch and open a PR titled "Step 20: data export and erasure, admin authenticator, retention, rate limits and headers". For the body, use the summary in `docs/implementation/CONSTRUCTION-020_SECURITY_INTERPRETATION.md`.
   - Attach the screenshots. Wait for both CI jobs. Do not merge until I say.

Report back as a table:
- PR number
- migration name
- backfill check
- unit, integration and browser test counts (integration from CI if not run locally)
- typecheck result
- conflicts
- any fixes, and why
- a to h: result, the SQL and commands you ran with their RAW output, and the screenshot file names
