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

1. **The project:** in Railway, choose New Project, then Empty project, and name it `exam-app-staging`. Pick a European region if Railway offers one, as it is closest to both the UK and the UAE.
2. **Databases:** add PostgreSQL, then add Redis.
3. **The `api` service:** choose New, then GitHub Repo, then `AlfredNathan0205/Education`, branch `main`.
   - Rename the service to `api`.
   - In its settings, set the config file path to `deploy/railway/api.railway.json`. If Railway has no such setting, add the variable `RAILWAY_DOCKERFILE_PATH=deploy/railway/api.Dockerfile` instead, and set the health check path to `/health` by hand.
   - Do **not** generate a public domain for it.
4. **The `web` service:** the same repo and branch, renamed to `web`.
   - Set the config file path to `deploy/railway/web.railway.json` (or `RAILWAY_DOCKERFILE_PATH=deploy/railway/web.Dockerfile`, with the health check path `/api/health`).
   - Generate a public domain, or attach your own subdomain (for example `staging.<your-domain>`) with the DNS record Railway shows.
5. **Variables:** add them as in the next section.
6. **Deploys:** both services deploy from `main` on every merge. Turn on Railway's option to wait for GitHub checks (CI) before deploying, if your plan offers it, so a red build never reaches staging.

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

1. **Run commands against staging.** Use either of these:
   - `railway ssh --service api` (Railway CLI), then run `node apps/api/dist/...` inside the container.
   - From your own checkout, after `pnpm install && pnpm build`, run `DATABASE_URL=<Postgres public URL from Railway> node apps/api/dist/...`. Prisma needs the database's **public** URL from outside Railway, and you may need to add `?sslmode=require` to it.
2. **The test jurisdiction policy:**
   `ALLOW_DEV_TEST_POLICY=true node apps/api/dist/privacy/cli/policy.js seed-dev-policy`
3. **Accounts:** each person signs up on the staging site with their own email. Then grant roles:
   `ADMIN_OPERATOR=<you> node apps/api/dist/authz/cli/roles.js grant email <them> SUPER_ADMIN` (or `CURRICULUM_EDITOR`, `CURRICULUM_REVIEWER`, `CURRICULUM_APPROVER`).
   - Each admin sets up an authenticator app at first sign-in to `/admin`.
   - Activating a curriculum needs an approver who did not edit it, so give your partner `CURRICULUM_APPROVER`.
4. **Content:** load the same curriculum and question files you use locally, through the operator commands in the README (`curriculum/cli/import-ai.js`, `question/cli/import-ai-questions.js`). Then review, approve and publish them on the admin pages, with two different people, as the app requires.

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
