# Security and privacy launch review

A checklist to work through before real students, especially children, use Exam App. It was written with Step 20 (16 October 2026). Each line says who owns it:

- **ENG:** engineering, built and verified in code.
- **OPS:** whoever runs production.
- **COUNSEL:** a lawyer for each launch jurisdiction.
- **PM:** a product decision.

Status is one of:

- **Built:** in the code, with tests.
- **Partly:** built, with a stated gap.
- **Not built:** nothing yet.
- **Decision:** someone has to choose.

Nothing here is legal advice. Every **COUNSEL** line is a question for a lawyer, not an answer.

## 1. Sign-in and privileged access

| Item | Owner | Status | Notes |
|---|---|---|---|
| Passwordless sign-in by one-time code; codes hashed with `OTP_HMAC_SECRET`; attempt and resend caps | ENG | Built | Steps 2 and 7. |
| Sessions stored as token hashes only; 14-day lifetime; httpOnly, SameSite=Lax cookie; Secure in production | ENG | Built | Step 7. |
| Authenticator app (TOTP) for every account holding a role, once per session (`MFA_SESSION_HOURS`, default 12), before any `/admin` API route answers | ENG | Built | Step 20. The secret is encrypted with `MFA_ENCRYPTION_KEY` (AES-256-GCM). A code works once. Five wrong codes lock the check for 15 minutes. There are 10 one-time recovery codes. |
| Lost phone: an operator resets the authenticator (`node dist/mfa/cli/mfa.js reset email <address>`, with `ADMIN_OPERATOR` set) | OPS | Built | Audited. Decide who may run it, and how they confirm the person's identity first. |
| QR code on the set-up page | ENG | Not built | The key is shown for typing, plus an `otpauth://` link. |
| Phishing-resistant keys (passkeys or WebAuthn) for SUPER_ADMIN | PM | Decision | Recommended before the team grows. |
| Role grants only by an operator CLI or an existing SUPER_ADMIN; audited | ENG | Built | Step 3. |
| Who holds SUPER_ADMIN at launch, and a review every quarter | OPS | Decision | Keep it to two people. |
| Curriculum activation (and resuming a suspended one) only by an approver who did not edit that revision; audited | ENG | Partly | Step 22, on the admin pages. The seed command and CLI still let one person do everything, and a super administrator who edited a revision can still approve it. Decide whether both should follow the rule before the beta. |
| AI drafting provider: what is sent, where it is processed, how long it is kept | COUNSEL + PM | Decision | Step 22. Only the mock provider exists, and it is refused in production. |

## 2. Data rights (Step 20)

| Item | Owner | Status | Notes |
|---|---|---|---|
| Self-serve copy of one's data (JSON), at once, audited, 3 a day | ENG | Built | Adults download their own. Guardians download each child they approve. A parent or guardian downloads their own account. Secrets and internal keys are left out. Other people's addresses are masked. |
| Erasure request with a 14-day cancellable wait, then an automatic erasure | ENG | Built | Hourly. Each request is checked again when it runs, and the work is one transaction, retried up to 5 times, then marked FAILED. |
| Erasure deletes personal data and unlinks the rest | ENG | Built | Deleted: sign-in identities, sessions, codes, date of birth, name, school, invitations (they hold emails), public handle, friend codes, blocks, parent summaries and analytics. Kept, under an id that no longer leads to a person: tests, answers, mastery, recommendations and points. `rights-domain.ts` has the full map, and a test fails if a new table is not classified. |
| Is "unlinked" enough to count as erased in each jurisdiction? (The kept learning records are pseudonymous, not anonymous, in the strict sense: they are still one person's history under one id.) | COUNSEL | Decision | The alternative is deleting learning records too, which changes leaderboards and question statistics. |
| Kept as evidence: consent records and withdrawals (who agreed to what, when), safety reports and restrictions, the audit trail, plan history | COUNSEL | Decision | Consent records still name the guardian's account. Plan history is append-only, so an administrator's reason text cannot be cleaned (tell admins never to put personal details there). |
| A minor cannot ask for erasure themselves; their approving guardian can | COUNSEL | Decision | The minor sees "Ask your parent or guardian". Some laws give minors their own rights. |
| A guardian cannot delete their own account while they approve a child; an administrator cannot while they hold a role | PM | Built | This stops a child's consent being left without a guardian. |
| A guardian who withdraws approval during the 14 days: the erasure stops (FAILED, `GUARDIAN_NO_LONGER_APPROVES`) | PM / COUNSEL | Decision | The data then stays until someone asks again. Consider erasing anyway. |
| No email confirming a request, or telling the person it is done | ENG | Not built | Recommended (with the sender already used for sign-in codes). |
| Rectification (correcting data): the name and date of birth are editable in the profile; nothing else is | COUNSEL | Partly | |
| Requests by post or email (people who cannot use the app) | OPS | Decision | They need a process; operators can use the same service. |
| After restoring a backup, apply erasures again | OPS | Built | `node dist/rights/cli/erasure.js tombstones > tombstones.jsonl`, then `... reapply tombstones.jsonl`. **The tombstones file must be kept outside the database backups** (a restored backup's own tombstone table is as old as the backup). Export it after every erasure run, for example daily. Tombstones hold ids only. |

## 3. Retention (Step 20; periods PROVISIONAL)

| Rule | Default | Variable | Owner |
|---|---|---|---|
| Expired sign-in codes | 90 days | `RETENTION_OTP_DAYS` | COUNSEL to confirm |
| Expired or revoked sessions | 90 days | `RETENTION_SESSION_DAYS` | COUNSEL |
| Friend codes and friend-code attempts | 30 days | `RETENTION_FRIEND_CODE_ATTEMPT_DAYS` | COUNSEL |
| Pseudonymous analytics | 13 months | `RETENTION_ANALYTICS_MONTHS` | COUNSEL |
| Published outbox events (only once analytics has read them) | 90 days | `RETENTION_OUTBOX_DAYS` | ENG/COUNSEL |
| Accounts not signed in: **flagged only** | 24 months | `RETENTION_INACTIVE_MONTHS` | COUNSEL: what happens to a flagged account (a notice, then erasure?) |
| Learning records, consent records, the audit trail, safety reports | none (kept) | | COUNSEL |
| Database backups | not set here | | OPS + COUNSEL |
| Application logs (they hold sign-in codes only with the console sender, which is refused in production) | not set here | | OPS |

The sweep runs daily at 03:00 India time. Each run is recorded in `retention_run` and audited. `node dist/rights/cli/erasure.js retention` runs it now.

## 4. Children and consent

| Item | Owner | Status |
|---|---|---|
| Age from the date of birth; under the jurisdiction's threshold, a guardian must approve before any processing (fail closed) | ENG | Built (Steps 2, 10) |
| Guardian verification method per jurisdiction (email-link attestation today) | COUNSEL | Decision |
| Every consent wording (core service, parent sharing, analytics) is a DRAFT; production refuses draft wording, so these flows stay closed until counsel signs off | COUNSEL | Decision |
| Analytics for minors decided by the guardian | COUNSEL | Decision |
| No public profile for minors, no free text between students, friends only by an in-person code with guardian approval | ENG | Built (Steps 15, 16) |
| Payments for minors (who holds the plan) | COUNSEL | Decision (Step 18) |
| A privacy notice in plain language, for children and for parents | COUNSEL + PM | Not built |
| A data protection impact assessment (or the local equivalent) | COUNSEL | Not built |
| Who is the controller, and the contact point for requests | COUNSEL | Not built (the wording placeholders say "to be confirmed") |

## 5. Web and API hardening (Step 20)

| Item | Owner | Status | Notes |
|---|---|---|---|
| API security headers: nosniff, DENY framing, no referrer, `default-src 'none'`, no-store, HSTS in production, no X-Powered-By | ENG | Built | |
| Web security headers: Content-Security-Policy (`'self'`, `frame-ancestors 'none'`, `object-src 'none'`), nosniff, DENY, Referrer-Policy, Permissions-Policy, COOP, HSTS in production | ENG | Partly | Scripts still need `'unsafe-inline'` for Next.js's inline scripts. A per-request nonce would remove it. |
| The browser reaches the API only through the web server's allow-list (no CORS, token never visible to scripts) | ENG | Built (Step 7) | |
| Rate limits per client address and per session: sign-in requests 10/min, code checks 20/min, authenticator 10/min, invitations, data rights, and 600/300 per minute otherwise | ENG | Partly | Kept in one API process's memory. **A shared store is needed before running more than one API instance.** |
| The browser's address reaches the API only with `BFF_SHARED_SECRET` (on both the web and API servers; required in production) | OPS | Built | The load balancer must set X-Forwarded-For, and the web server must not be reachable around it. |
| Dependency and container scanning in CI | ENG | Not built | |
| An external penetration test before launch | OPS | Decision | |
| TLS on every hop; the database not reachable from the internet | OPS | Not checked here | |

## 6. Secrets and keys

| Variable | Used for | Rules |
|---|---|---|
| `OTP_HMAC_SECRET` | sign-in codes | at least 32 characters |
| `ANALYTICS_PSEUDONYM_KEY` | analytics pseudonyms | required in production; never rotate without a migration (Step 19) |
| `MFA_ENCRYPTION_KEY` | authenticator secrets | required in production; at least 32 characters; rotating it makes every authenticator unreadable (all admins re-enrol after an operator reset) |
| `BFF_SHARED_SECRET` | trusted client address | required in production on both servers; at least 32 characters |
| `RESEND_API_KEY` | email | Step 7 |

Keep them in the host's secret store, never in the repository. Note who can read them.

## 7. Logging, audit and incidents

| Item | Owner | Status |
|---|---|---|
| Audit trail of privileged and privacy actions (roles, consent, exports, erasure requests and runs, authenticator use, metrics views, safety decisions, retention runs) | ENG | Built |
| Who reviews the audit trail, and how often | OPS | Decision |
| A breach response plan: who decides, notification deadlines per jurisdiction, contacts | COUNSEL + OPS | Not built |
| Alerts on FAILED erasures and failed retention runs (both are logged and stored) | OPS | Not built |
| Processors (email provider, hosting): agreements and where data is stored | COUNSEL + OPS | Decision |

## 8. Kill switches

Set the variable and restart the API. Each is listed in `apps/api/src/security/kill-switches.ts`, and a test checks that each is read by the code and listed here.

| Switch | Off means | Default | Use when |
|---|---|---|---|
| `SOCIAL_FEATURES_ENABLED` | Friends and challenges answer 404 | off | a safety problem between students |
| `REPORTS_ENABLED` | Weekly parent summaries are not frozen | on | a wrong claim in parent reports |
| `ANALYTICS_ENABLED` | No analytics recorded | on | doubt about the analytics consent or data |
| `ERASURE_ENABLED` | Due erasures wait (requests are still taken) | on | an erasure bug, or during a restore |
| `RETENTION_ENABLED` | No retention sweep | on | before a backup restore, or a retention bug |
| `RATE_LIMIT_ENABLED` | No HTTP rate limits | on | only to recover from a mistaken limit |
| `MFA_ENFORCED` | No authenticator check on /admin; **refused in production** | on | local development only |
| `RELEASE_GATING_ENABLED` | Release tiers ignored: every served subject shown to every student; **refused in production** | on | local development with data from before Step 21 only |
| `BETA_GRANT_UNTIL` | Unset: no new Beta plans | unset | ending the beta |

## 9. Before launch: sign-off

- [ ] COUNSEL: every consent wording reviewed and published (the flows stay closed until then).
- [ ] COUNSEL: the erasure model (unlink versus delete), the evidence kept, and minors' own rights.
- [ ] COUNSEL: every retention period, and what happens to inactive accounts.
- [ ] COUNSEL + PM: the privacy notice, the controller's identity and contact, and the impact assessment.
- [ ] OPS: production secrets set (section 6); `MFA_ENFORCED` unset; every SUPER_ADMIN enrolled in an authenticator.
- [ ] OPS: backups, restore drill including `erasure reapply`, and the tombstone export schedule.
- [ ] OPS: alerts on FAILED erasures and failed retention runs.
- [ ] OPS: one API instance, or a shared rate-limit store first.
- [ ] OPS: a penetration test, and the breach plan.
