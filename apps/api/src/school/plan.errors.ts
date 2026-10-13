export class PlanNotFoundError extends Error {
  constructor() {
    super('That school plan does not exist');
    this.name = 'PlanNotFoundError';
  }
}
export class PlanNotEditableError extends Error {
  constructor() {
    super('A published plan cannot be changed; reopen it first');
    this.name = 'PlanNotEditableError';
  }
}
export class PlanEmptyError extends Error {
  constructor() {
    super('A plan needs at least one chapter before it can be published');
    this.name = 'PlanEmptyError';
  }
}
export class ChapterNotFoundError extends Error {
  constructor(subjectCode: string, chapterCode: string) {
    super(`No chapter ${chapterCode} in ${subjectCode} for this curriculum and grade`);
    this.name = 'ChapterNotFoundError';
  }
}
export class GradeNotSetError extends Error {
  constructor() {
    super('Choose your curriculum and grade first');
    this.name = 'GradeNotSetError';
  }
}
