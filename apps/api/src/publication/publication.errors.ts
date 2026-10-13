export class PublicationForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationForbiddenError';
  }
}
export class PublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationConflictError';
  }
}
export class PublicationNotFoundError extends Error {
  constructor(what: string) {
    super(`No such ${what}`);
    this.name = 'PublicationNotFoundError';
  }
}
