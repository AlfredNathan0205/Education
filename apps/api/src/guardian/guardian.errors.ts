export class GuardianNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'GuardianNotFoundError';
  }
}
export class GuardianNotPermittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianNotPermittedError';
  }
}
export class GuardianConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianConflictError';
  }
}
/** Too many requests. The message tells the person how long to wait without revealing other people's activity. */
export class GuardianRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianRateLimitedError';
  }
}
/** Approval cannot be completed right now for a reason outside the person's control (no policy, no wording, email down). */
export class GuardianUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianUnavailableError';
  }
}
export class GuardianInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianInputError';
  }
}
