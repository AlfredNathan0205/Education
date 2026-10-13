# CONSTRUCTION-007: email delivery of sign-in codes

## Why
Sign-in codes only appeared in the API log, so nobody but the operator could sign in. This block sends them by email.

## What changed
- `EmailOtpSender` sends through Resend's HTTP API (no new dependency). It sits behind the existing `OtpSender` port; `IdentityService` already called that port, so the sign-in logic is unchanged apart from failure handling.
- `createOtpSender()` chooses the sender from the environment and **fails at startup** when unsafe:
  - `EMAIL_PROVIDER=resend` requires `RESEND_API_KEY` and `EMAIL_FROM` (rejects line breaks and non-addresses).
  - `EMAIL_PROVIDER=console` is refused when `NODE_ENV=production`.
  - Unset means console outside production and resend in production, so forgetting to configure it is loud.
- Phone numbers: there is no SMS provider. In production a phone request answers 503 "Phone sign-in isn't available yet. Please use your email address." In development phone codes still go to the log.

## Decisions
1. **Failed send removes the stored code.** Otherwise the 60-second resend cooldown would block a retry for a code that never arrived. A cleanup failure is swallowed; the person still gets the delivery error.
2. **503 on delivery failure, not a silent 202.** The earlier rule (same answer whether or not an identity exists) still holds: delivery failure does not depend on whether the address is registered.
3. **The code is in the email body only**, not the subject, because subjects show in lock-screen previews.
4. **Logs hold only the masked address and an HTTP status.** Never the code, the full address, the API key, or the provider's response body (which can echo the address).
5. **8-second timeout** on the provider call, so a slow provider cannot hold a request open.

## Not done (deliberately)
- **No per-IP or per-address-set rate limit.** The existing control is one code per address per minute. Anyone can still trigger sign-in emails to many different addresses. This costs sending reputation and money, and is worth a limit before public launch.
- **No delivery tracking** (bounces, complaints). Resend webhooks would be a later block.
- **No SMS.**
- **Email content is English only** and unbranded.

## Verification
Unit tests cover the sender (payload, auth header, rejection, network failure, timeout, phone refusal), the factory (every unsafe configuration), the service (cleanup on failure) and the controller (503 mapping). A real send has not been done from the sandbox.
