export class QuestionNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} was not found`);
    this.name = 'QuestionNotFoundError';
  }
}
export class QuestionForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionForbiddenError';
  }
}
export class QuestionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionConflictError';
  }
}
