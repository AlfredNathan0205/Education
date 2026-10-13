export class SchoolNotFoundError extends Error {
  constructor() {
    super('That school is not available');
    this.name = 'SchoolNotFoundError';
  }
}
export class CandidateNotPendingError extends Error {
  constructor() {
    super('That school suggestion does not exist or has already been resolved');
    this.name = 'CandidateNotPendingError';
  }
}
export class NotInLaunchCohortError extends Error {
  constructor() {
    super('That curriculum and grade are not available yet');
    this.name = 'NotInLaunchCohortError';
  }
}
