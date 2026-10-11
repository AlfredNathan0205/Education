export class PrivacyNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'PrivacyNotFoundError';
  }
}

/** The acting account is not allowed to perform this privacy action. */
export class PrivacyForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyForbiddenError';
  }
}

/** A DOB-evidence or guardian-verification method that the active policy does not accept. */
export class MethodNotAcceptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MethodNotAcceptedError';
  }
}

/** Consent cannot be recorded because the purpose has no live, versioned consent text. */
export class ConsentTextUnavailableError extends Error {
  constructor(purposeCode: string) {
    super(`No active consent text for purpose ${purposeCode}`);
    this.name = 'ConsentTextUnavailableError';
  }
}
