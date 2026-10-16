# Step 20: Security, privacy and compliance hardening

Spec sources:
- `BUILD_SEQUENCE.md` 20: security, privacy and compliance hardening.
- `INVARIANTS_AND_POLICIES.md`:
  - children's data is minimised;
  - consent is purpose- and version-specific;
  - privileged access is audited;
  - no real child data outside production.
- `CANONICAL_DATA_MODEL.md`: `privacy_request`, `data_export_request`, `deletion_request`, `deletion_tombstone`. One `privacy_request` table holds both kinds, with a kind column.
- `DOMAIN_MAP.md`: privacy owns consent (D11).

**PM decisions (16 October):**
- **Erasure:** delete personal data and unlink the rest.
- **Requests:** self-serve, with a 14-day wait.
- **Admin MFA:** an authenticator app.
- **Retention:** the mechanism, with provisional periods.

## Built
- **A copy of your data** (`/privacy`, linked from Progress, the guardian page and the parent page).
  - **Who can download:**
    - a student downloads everything held about them, as stored, as one JSON file;
    - a guardian downloads each child they approve;
    - a parent or guardian downloads their own account.
  - **Left out:**
    - secret codes, hashes and internal keys;
    - other students' rows (friendships and challenges are counted, not listed);
    - reports made about the student by others.
  - Other people's emails in the student's own invitations are masked.
  - Each download is audited, at most 3 a day.
- **Deleting an account.**
  - **Who can ask:**
    - an adult, for themselves;
    - an approving guardian, for a minor;
    - a parent or guardian, for their own account, once they approve no child.

    A minor is told to ask their guardian. An administrator must lose their role first.
  - **The wait:** 14 days, shown with its date. The person who asked, an approving guardian, or the adult student can cancel. The database allows one open request per person.
  - **The run:** hourly. Each request is checked again (a guardian must still approve the child). The work is one transaction: on a failure it is all undone and retried, up to 5 times.
  - **Deleted:**
    - sign-in emails and numbers, sessions and codes;
    - the date of birth, the display name and the school;
    - guardian and parent invitations (they hold emails), parent access and weekly summaries;
    - the public handle, so the student is never on a leaderboard again;
    - friend codes and blocks;
    - analytics;
    - the authenticator.
  - **Ended:** friendships, open challenges, plans and grants (an administrator's reason text is overwritten), and guardian links.
  - **Kept, under the student id, which then leads to no one:** tests, answers, mastery, recommendations and points.
  - **Kept as evidence:** consent records, now withdrawn with the reason ERASURE.
  - The account stays as an empty, CLOSED row so the history around it holds together. The same email can sign up again as a new person.
  - **Completeness check:** `rights-domain.ts` lists what happens to every table that points at a student or account. A test reads the Prisma schema and fails if a table is missing, so a future table cannot be forgotten.
  - **The weekly parent-summary sweeper** now skips erased students. The integration test caught that it would otherwise have rebuilt their reports.
- **After a backup restore.** Each erasure leaves a tombstone of ids only (no email, number or name, hashed or not). `erasure tombstones` exports them to a file kept outside the backups. `erasure reapply <file>` erases the restored rows again.
- **An authenticator app for administrators.**
  - **Who needs it:** every account holding any role. They must pass the check on each session (for 12 hours) before any `/admin` API route answers.
  - **The guard** is global. It leaves requests with no session, or with no role, to the route's own 401 or 403, so nothing changes for students.
  - **Set-up:** at `/admin/mfa`. The key is shown to type (or as an `otpauth://` link), the person confirms with a first code, and gets 10 one-time recovery codes.
  - **Codes:** standard TOTP (RFC 6238; the official test vectors pass). A code works once, even under concurrent requests. Five wrong codes lock the check for 15 minutes.
  - **The secret** is encrypted (AES-256-GCM, `MFA_ENCRYPTION_KEY`).
  - **Lost phone:** an operator resets it with `mfa reset`.
  - **In the web app:** an admin page whose API call answers MFA_REQUIRED sends the person to `/admin/mfa` and back afterwards.
- **Retention:** a daily sweep at 03:00 India time, recorded in `retention_run` and audited.
  - **Deletes:**
    - expired sign-in codes and old sessions (90 days);
    - friend codes and attempts (30 days);
    - analytics (13 months);
    - published outbox events (90 days, and only once analytics has read them).
  - **Flags** accounts not signed in for 24 months (flag only). The account now records its last sign-in, backfilled from sessions by the migration.
  - Each period can be overridden by a `RETENTION_*` variable. Learning records and evidence are not touched.
- **Hardening.**
  - **API:** security headers (nosniff, no framing, no referrer, `default-src 'none'`, no-store, HSTS in production, no framework banner).
  - **Web:** a Content-Security-Policy (self only, no framing, no plugins) and the usual headers.
  - **Rate limits** per client address and per session. They are tight on sign-in, the authenticator, invitations and data rights; anything over the limit gets 429 with Retry-After.
  - **The client address:** the web server passes the browser's address to the API with a shared secret (`BFF_SHARED_SECRET`), so limits are per person, not per web server.
- **Kill switches** in one list: `ERASURE_ENABLED`, `RETENTION_ENABLED` and `RATE_LIMIT_ENABLED` are new. `MFA_ENFORCED=false` is refused in production.
- **`SECURITY_PRIVACY_LAUNCH_REVIEW.md`:** the launch checklist, by owner (engineering, operations, counsel, PM), with what is built, partly built, not built, or a decision.

## Assumptions and open decisions (please confirm)
1. **Counsel: is unlinking enough?** Kept learning records are pseudonymous, not anonymous, in the strict sense: one person's history under one id. The alternative, deleting them, changes leaderboards and question statistics.
2. **Counsel: what is kept as evidence.**
   - Consent records still name the guardian's account.
   - Safety reports about the student are kept and not exported.
   - Plan history is append-only, so an administrator's reason text there cannot be cleaned.
3. **Counsel: minors' own rights.** A minor cannot ask for erasure themselves.
4. **Counsel: every retention period,** and what to do with flagged inactive accounts.
5. **My choice:** an erasure stops if the guardian who asked no longer approves the child when it runs. The other choice is to erase anyway.
6. **My choice:** a student with no age classification yet may delete their own account. Deletion only protects, so failing closed here would trap them.
7. **Rate limits** live in one API process's memory. Before running two or more API instances, they need a shared store (Redis is already there).
8. **The web CSP** still allows inline scripts (Next.js needs them). A per-request nonce would remove that.

## Not built
- Emails confirming a request or its completion.
- A QR code on the authenticator page.
- Passkeys.
- An admin view of requests and FAILED erasures. They are logged, stored and audited, but there are no alerts.
- Rectification beyond the editable profile.
- Requests by post or email.
- A shared rate-limit store.
- A nonce CSP.
- Dependency scanning.
- **For people, not code:** the privacy notice, the impact assessment, the breach plan, and a penetration test.

## Migration
One migration, `security`: Prisma's DDL plus `CONSTRUCTION-020_SECURITY_MIGRATION_EXTRA.sql`.
- **New tables:** `privacy_request`, `deletion_tombstone`, `admin_mfa_factor`, `admin_mfa_recovery_code` and `retention_run`.
- **New columns:**
  - `account.erased_at`, `last_sign_in_at` and `inactive_flagged_at`;
  - `student.erased_at`;
  - `auth_session.mfa_verified_at`.
- **The one foreign key** (recovery code → authenticator) is declared in the schema.

The extra SQL adds:
- the request checks: fixed lists, each status with what it needs, an export always complete, and guardian requests only for students;
- one open erasure per subject (a partial unique index);
- the tombstone subject check;
- erased ⇒ CLOSED;
- an active authenticator says when it was confirmed;
- Step 18's subscription check, recreated with the ended reason ERASED added;
- the last-sign-in backfill.

## Checks done here
- **Unit tests: 74 suites, 1145 tests** (Step 19 had 68 and 1066). They cover:
  - **TOTP:** the RFC 6238 test vectors, the window, replay, recovery codes, encryption and tampering, and the production rules.
  - **The authenticator service, against an in-memory store:**
    - only roles need it;
    - set-up and confirmation;
    - per-session checks and their expiry;
    - one use per code and per recovery code;
    - the lock after five failures;
    - the operator reset.
  - **The guard:** /admin only; no session or no role passes through; MFA_REQUIRED otherwise.
  - **Rate limits:**
    - the rules, the window and the bound;
    - the trusted address only with the secret;
    - session hashing;
    - 429 with Retry-After, per address and per session;
    - the health check exempt, and the switch.
  - **Headers.**
  - **Kill switches:** every switch is read by the code and listed in the review.
  - **Data rights:**
    - who may ask (each block);
    - the export: contents, no secrets, masking, the daily limit, a guardian's copy, strangers refused;
    - requests, waits, cancelling, duplicates;
    - the saga: everything deleted, kept and ended; a guardian's erasure of a minor; a parent's own; the re-check; rollback and retries; the lease after a crash; the switch;
    - reapplying tombstones; tombstones holding ids only.
  - **The erasure map:** it covers every table in the schema, and the saga touches every table it says it deletes or ends.
  - **Export tables:** each exists.
  - **The migration:** the new ERASED reason, and no foreign keys in the extra SQL.
  - **Retention:** deletes, flags, the outbox waiting for analytics, the switch, and the period rules.
  - **The privacy domain's erasure withdrawal.**
- **Browser tests: 52 of 52 pass** (26 × phone and desktop). The new ones:
  - an adult downloads a copy, asks to delete, and cancels;
  - a minor is sent to their guardian, and the guardian downloads, deletes and cancels for the child;
  - an administrator is sent to set up an authenticator before Metrics opens, and a second session passes with a recovery code;
  - a student sees neither;
  - every page carries the security headers.
- **The schema validates.** The extra SQL ran on a throwaway Postgres 16: every check, the one-open-erasure index, the erased ⇒ CLOSED rule, the authenticator check, the new and old subscription reasons, and the backfill.
- **Not run here:** the migration and the 4 new real-database integration tests:
  - an adult's copy and erasure end to end, including the second sign-up as a new person, no rebuilt weekly summary, not on the boards, and reapply after a restore;
  - a guardian erasing a minor;
  - the authenticator on the real database;
  - a retention run.
