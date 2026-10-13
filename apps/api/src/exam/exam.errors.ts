export class ExamNotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'ExamNotFoundError';
  }
}
/** The student may not take tests yet (no profile, age not classified, or guardian consent needed). */
export class ExamNotPermittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExamNotPermittedError';
  }
}
/** The request does not fit the assessment's current state. */
export class ExamConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExamConflictError';
  }
}
/** No test can be built right now (subject not open, or not enough approved questions). */
export class ExamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExamUnavailableError';
  }
}
export class ExamInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExamInputError';
  }
}
