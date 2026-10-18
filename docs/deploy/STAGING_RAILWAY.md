# Staging on Railway

Staging is a hosted copy of Exam App for the team to test with: a real web address, real sign-in emails, and **test data only**. Every page shows a "Staging: test data only" banner. It is not production and never holds a real child's details.

Railway account: the one Verityx already uses. Use a **separate Railway project** for Exam App, so the two never share a database, variables or access.

Railway's screens and settings names change from time to time. Where this guide names a setting and Railway shows something different, follow Railway's current docs, and note the difference here.

## What runs

| Service | Built from | Public? | Notes |
|---|---|---|---|
| `Postgres` | Railway's PostgreSQL | No | Postgres 16 or later. |
| `Redis` | Railway's Redis | No | The job queue. |
| `api` | this repo, `deploy/railway/api.railway.json` | **No** | It applies migrations, then starts. The web server is the only way in (no CORS, the token never reaches the browser). |
| `web` | this repo, `deploy/railway/web.railway.json` | **Yes** | It has a Railway domain (`*.up.railway.app`), or your own subdomain. |

Name the services exactly `api` and `web`: the variables below refer to them by name.

## Set up (once)

1. **The project:** in Railway, choose New Project, then Empty project, and name it `exam-app-staging`. The project starts in US West by default.
2. **Databases:** add PostgreSQL, then add Redis.
3. **Region:** move all four services to EU West (Amsterdam) — closest to both the UK and the UAE. For each service: open Settings → Region and select EU West, or use the CLI: `railway service scale --service <name> eu-west=1 us-west=0`. Postgres and Redis volumes migrate automatically with brief downtime.
4. **The `api` service:** choose New, then GitHub Repo, then `AlfredNathan0205/Education`, branch `main`.
   - Rename the service to `api`.
   - Railway does not currently have a "config file path" setting in the UI. Add the variable `RAILWAY_DOCKERFILE_PATH=deploy/railway/api.Dockerfile` instead. The health check path `/health` must be set by hand in the service settings.
   - Do **not** generate a public domain for it.
5. **The `web` service:** the same repo and branch, renamed to `web`.
   - Add the variable `RAILWAY_DOCKERFILE_PATH=deploy/railway/web.Dockerfile`. Set the health check path `/api/health` by hand.
   - Generate a public domain, or attach your own subdomain (for example `staging.<your-domain>`) with the DNS record Railway shows.
6. **Variables:** add them as in the next section.
7. **Deploys:** both services deploy from `main` on every merge. Turn on Railway's option to wait for GitHub checks (CI) before deploying, if your plan offers it, so a red build never reaches staging.

## Variables

Generate each secret with `openssl rand -hex 32`. Keep the secrets in Railway only: never in the repo, a chat or a document.

### `api`

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `development` | **Deliberate.** Production refuses the test-only features staging needs: the test jurisdiction policy, draft consent wording, the mock AI, and the development switches. Never copy this to production. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway's private address for the database. |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | Read since this step (includes the password, over IPv4 or IPv6). |
| `API_PORT` | `3001` | |
| `OTP_HMAC_SECRET` | a new secret | Sign-in codes. |
| `MFA_ENCRYPTION_KEY` | a new secret | The admins' authenticator. Changing it later means every admin sets up again. |
| `ANALYTICS_PSEUDONYM_KEY` | a new secret | Never change it once set. |
| `BFF_SHARED_SECRET` | a new secret | It must be **the same** on `web`. |
| `EMAIL_PROVIDER` | `resend` | Codes are emailed, not logged. |
| `RESEND_API_KEY` | from Resend | |
| `EMAIL_FROM` | `Exam App Staging <signin@<verified domain>>` | It must be on a domain verified in Resend. A Resend test sender can only email the account owner. |
| `WEB_BASE_URL` | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}`, or your subdomain | Links in emails (guardian approval, parent sharing). |
| `DEFAULT_JURISDICTION` | `XX` | The test policy. |
| `ALLOW_DEV_TEST_POLICY` | `true` | So the test policy can be loaded. |
| `EXAM_ALLOW_UNACTIVATED_CURRICULUM` | `true` | **Phase 1 only:** testers can take tests before a curriculum is activated. |
| `RELEASE_GATING_ENABLED` | `false` | **Phase 1 only:** every served subject is shown, before readiness release. |
| `FACTORY_ENABLED`, `FACTORY_DAILY_TOKEN_BUDGET`, `AI_PROVIDER` | `true`, `200000`, `mock` | Optional: AI drafting with the placeholder mock. |

**Phase 2** (rehearsing the alpha for real): remove `EXAM_ALLOW_UNACTIVATED_CURRICULUM` and `RELEASE_GATING_ENABLED`. Then subjects reach testers only through activation and readiness release, as they will in production.

### `web`

| Variable | Value |
|---|---|
| `API_URL` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3001` |
| `BFF_SHARED_SECRET` | `${{api.BFF_SHARED_SECRET}}` |
| `ENV_LABEL` | `Staging` (shows the banner) |

## First run

Migrations run by themselves when `api` starts. Then, once:

1. **Run commands against staging.** Use SSH into the running container:
   - First time: generate an SSH key (`ssh-keygen -t ed25519`), register it (`railway ssh keys add`), and install the SSH config (`railway ssh config --service api`). Then run commands with `ssh railway-api -- ENV=val node apps/api/dist/...`.
   - The local Prisma engine may not work on all architectures (e.g. Windows ARM64). SSH into the container avoids this.
   - To upload files: `scp myfile.json railway-api:/tmp/`.
2. **The test jurisdiction policy:**
   `ssh railway-api -- ALLOW_DEV_TEST_POLICY=true POLICY_OPERATOR=<you> node apps/api/dist/privacy/cli/policy.js seed-dev-policy`
3. **Accounts:** each person signs up on the staging site with their own email. Then grant roles:
   `ssh railway-api -- ADMIN_OPERATOR=<you> node apps/api/dist/authz/cli/roles.js grant email <them> SUPER_ADMIN` (or `CURRICULUM_EDITOR`, `CURRICULUM_REVIEWER`, `CURRICULUM_APPROVER`).
   - Each admin sets up an authenticator app at first sign-in to `/admin`.
   - Activating a curriculum needs an approver who did not edit it, so give your partner `CURRICULUM_APPROVER`.
4. **Content:** first seed the curriculum structure, then import the AI drafts:
   - Upload the evidence and draft files: `scp docs/curriculum/icse-g8-2026-27-evidence.json railway-api:/tmp/` and each `.cisce-sources/icse-g8-*-ai-draft.json`.
   - Seed the structure: `ssh railway-api -- ADMIN_OPERATOR=<you> node apps/api/dist/curriculum/cli/curriculum.js seed email <admin-email> /tmp/icse-g8-2026-27-evidence.json`
   - Import each subject: `ssh railway-api -- ADMIN_OPERATOR=<you> node apps/api/dist/curriculum/cli/import-ai.js /tmp/icse-g8-<subject>-ai-draft.json`
   - Import questions: `ssh railway-api -- ADMIN_OPERATOR=<you> node apps/api/dist/question/cli/import-ai-questions.js /tmp/<questions>.json`
   - Then review, approve and publish them on the admin pages, with two different people, as the app requires.

## Day to day

- **Deploying:** merge to `main`. Railway rebuilds both services, and a failed health check keeps the previous version running.
- **Logs:** each service's Deployments tab in Railway. Sign-in codes are emailed and never logged.
- **Wiping test data:** remove and re-add the Postgres service (or its volume). Then do the first run again.
- **Cost:** Railway bills by usage. Check the project's usage page after the first week; four small services were estimated at roughly $15 to $35 a month in 2026 write-ups (unverified).
- **Who can get in:** anyone with the link can sign up as a student. The admin pages need a role and the authenticator. Don't publish the link.

## Never on staging

- A real child's details. The banner says so, and testers should use adult test accounts. A test "minor" uses a made-up date of birth and a guardian email you control.
- Production secrets, or a production database.
- `NODE_ENV=development` anywhere that real students will use.
