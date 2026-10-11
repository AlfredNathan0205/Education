/** Queue name constant. Defined in its own file to avoid a circular import
 *  between jobs.module.ts (which registers the queue) and jobs.service.ts
 *  (which injects it). */
export const PLACEHOLDER_QUEUE = 'placeholder';
