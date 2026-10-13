export class BlueprintForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlueprintForbiddenError';
  }
}
export class BlueprintConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlueprintConflictError';
  }
}
export class BlueprintNotFoundError extends Error {
  constructor(what: string) {
    super(`No such ${what}`);
    this.name = 'BlueprintNotFoundError';
  }
}
