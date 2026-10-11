export class CurriculumNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'CurriculumNotFoundError';
  }
}

/** The request conflicts with current state (duplicate unit, open revision, unverified evidence...). */
export class CurriculumConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumConflictError';
  }
}

/** The actor's role does not permit this content operation. */
export class CurriculumForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumForbiddenError';
  }
}
