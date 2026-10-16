/**
 * Step 20: every switch an operator can use to turn a feature off without a deploy, in one place. Each is read from
 * the environment at start-up; change it and restart the API. docs/implementation/SECURITY_PRIVACY_LAUNCH_REVIEW.md
 * lists the same switches with when to use them. A unit test checks each one is read somewhere in the code.
 */
export interface KillSwitch {
  name: string;
  /** What "off" means. */
  offValue: string;
  default: string;
  stops: string;
}

export const KILL_SWITCHES: KillSwitch[] = [
  { name: 'SOCIAL_FEATURES_ENABLED', offValue: 'unset or not "true"', default: 'off', stops: 'Friends and challenges (API answers 404).' },
  { name: 'REPORTS_ENABLED', offValue: 'false', default: 'on', stops: 'The weekly parent summary sweeper.' },
  { name: 'ANALYTICS_ENABLED', offValue: 'false', default: 'on', stops: 'All analytics recording (server and client events).' },
  { name: 'ERASURE_ENABLED', offValue: 'false', default: 'on', stops: 'Running due erasures (requests are still taken and wait).' },
  { name: 'RETENTION_ENABLED', offValue: 'false', default: 'on', stops: 'The daily retention sweeper.' },
  { name: 'RATE_LIMIT_ENABLED', offValue: 'false', default: 'on', stops: 'HTTP rate limits (use only to recover from a mistaken limit).' },
  { name: 'MFA_ENFORCED', offValue: 'false', default: 'on', stops: 'The authenticator check on /admin. Refused in production.' },
  { name: 'BETA_GRANT_UNTIL', offValue: 'unset', default: 'unset', stops: 'Granting the Beta plan to new students.' },
];
