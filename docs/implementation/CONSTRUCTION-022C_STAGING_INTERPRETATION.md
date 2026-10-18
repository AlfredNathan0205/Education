# Step 22c: staging on Railway

**PM decisions (18 October):** staging is the way for the team (first, Alfred's partner) to test. It is hosted on Railway, which Verityx already uses.

## Built
- **Deployment config for Railway** in `deploy/railway/`:
  - one Dockerfile per service (Railway builds a Dockerfile's last stage, so the shared root Dockerfile could not be used as it is);
  - a `railway.json` per service, with the health checks, restart policy, and watch paths so that a web-only change doesn't rebuild the API.
  - **Migrations:** the API applies pending migrations at start. If one fails, the container stops, the health check fails, and Railway keeps the previous version.
- **Two small API changes, so it runs on a host:**
  - **Redis:** a `REDIS_URL` with a password is now accepted (Railway provides one), and the connection works over IPv4 or IPv6. Railway's private network can be IPv6 only, which ioredis's default can't reach. Locally nothing changes: `REDIS_HOST` and `REDIS_PORT` still work.
  - **The port:** the API takes `PORT` when `API_PORT` is unset.
- **A staging banner** on every page ("Staging: test data only. Do not enter a real child's details."), shown when the web server has `ENV_LABEL` set. It is read at request time, so the same build serves every environment; production sets nothing and shows nothing.
- **The runbook** `docs/deploy/STAGING_RAILWAY.md`: the services, every variable and why, the first run (test policy, roles, content), deploys, logs, wiping, cost, and what must never be on staging.

## Assumptions and open decisions (please confirm)
1. **Staging runs the API with `NODE_ENV=development`.** Production deliberately refuses what staging needs:
   - the test jurisdiction policy;
   - draft consent wording (counsel hasn't reviewed it yet);
   - the mock AI;
   - the development switches.

   **What still runs as in production:**
   - the web server (`next start` is always production), so cookies are Secure and the HTTPS headers are on;
   - real emailed codes;
   - the authenticator for admins.

   **The cost:** staging can't rehearse production's start-up refusals. That will need a separate pre-production setup later, with counsel-approved wording.
2. **Phase 1 uses two development switches:** testers can take tests before curricula are activated (`EXAM_ALLOW_UNACTIVATED_CURRICULUM`) and before release (`RELEASE_GATING_ENABLED=false`). **Phase 2** removes them, to rehearse the alpha exactly. You choose when to switch.
3. **Separate project:** a separate Railway project from Verityx, in the same account: nothing shared.
4. **Railway settings named in the runbook** (config file path, `RAILWAY_DOCKERFILE_PATH`, `RAILWAY_PRIVATE_DOMAIN` / `RAILWAY_PUBLIC_DOMAIN`, waiting for CI) are from Railway's documentation as I know it. I could not open Railway from here; Claude Code checks them while setting up and corrects the runbook if they differ.
5. **Cost** is Railway's usage pricing. The estimate in the runbook (roughly $15 to $35 a month) is from third-party write-ups and is not verified.
6. **Data:** staging holds test data only. The banner says so, but nothing technical stops a tester typing a real child's details. Tell testers.

## Needs you (not code)
- A domain (or subdomain) **verified in Resend**, and a Resend API key. Without it, sign-in codes reach only the Resend account owner.
- Optionally, your own subdomain for the site (otherwise `*.up.railway.app`).
- Who gets which role: your partner as `CURRICULUM_APPROVER`, so subjects can be activated by someone who didn't edit them.
- The content to load: the same curriculum and question files as your local copy.

## Not built
- A production environment.
- Automatic backups for staging (Railway's own snapshots, if your plan has them, are enough for test data).
- Monitoring and alerts.

## Migration
None.

## Checks done here
- **API:** 81 suites, 1210 unit tests (1207 on main, plus 3 new for the Redis connection). The typecheck (with tests) is clean.
- **Web:** typecheck clean.
- **Not done here:** building the two images (no Docker daemon in this sandbox), and anything on Railway. Claude Code builds both images locally, then sets up and checks staging.
