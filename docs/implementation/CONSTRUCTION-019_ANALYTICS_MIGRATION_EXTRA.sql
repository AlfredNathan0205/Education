-- Step 19: append to the migration made by `prisma migrate dev --create-only --name analytics`.

-- Analytics rows are pseudonymous: a 32-character hex pseudonym, a name from the fixed lists (server or client), never
-- free text. The lists must match SERVER_EVENTS and CLIENT_EVENTS in apps/api/src/analytics/analytics-domain.ts
-- (a unit test checks). Props are a JSON object or NULL.
ALTER TABLE "analytics_event" ADD CONSTRAINT "analytics_event_check" CHECK (
  "subject_key" ~ '^[0-9a-f]{32}$'
  AND (("source" = 'SERVER' AND "name" IN ('SIGNED_UP', 'ASSESSMENT_STARTED', 'ASSESSMENT_COMPLETED', 'QUALIFIED_TEST', 'RECOMMENDATION_STARTED', 'RECOMMENDATION_COMPLETED', 'MASTERY_UPDATED', 'PARENT_VIEWED', 'PARENT_SHARING_STARTED'))
    OR ("source" = 'CLIENT' AND "name" IN ('RESULTS_OPENED', 'PRACTISE_MISSED_CLICKED', 'PROGRESS_OPENED', 'PARENT_PREVIEW_OPENED', 'COMPETE_OPENED')))
  AND ("props" IS NULL OR jsonb_typeof("props") = 'object')
  AND ("cohort" IS NULL OR "cohort" ~ '^[A-Z0-9_]+/[A-Z0-9_]+$'));

-- Experiments: statuses, keys, weights; exactly one control per experiment (a partial unique index).
ALTER TABLE "experiment" ADD CONSTRAINT "experiment_check" CHECK (
  "status" IN ('DRAFT', 'RUNNING', 'STOPPED') AND "key" ~ '^[a-z][a-z0-9_]{2,63}$'
  AND (("status" = 'DRAFT') = ("started_at" IS NULL)) AND (("status" = 'STOPPED') = ("stopped_at" IS NOT NULL)));
ALTER TABLE "experiment_variant" ADD CONSTRAINT "experiment_variant_check" CHECK ("weight" BETWEEN 1 AND 100 AND "key" ~ '^[a-z][a-z0-9_]{0,31}$');
CREATE UNIQUE INDEX "experiment_variant_one_control" ON "experiment_variant" ("experiment_id") WHERE "is_control";
ALTER TABLE "experiment_assignment" ADD CONSTRAINT "experiment_assignment_check" CHECK ("subject_key" ~ '^[0-9a-f]{32}$');
-- (That an assignment names a variant of its own experiment is a foreign key in the Prisma schema itself:
-- experiment_assignment_variant_fkey. Foreign keys belong in the schema, or a later migration drops them as unknown.)

-- The projector keeps one cursor.
ALTER TABLE "analytics_cursor" ADD CONSTRAINT "analytics_cursor_check" CHECK ("id" = 'outbox');

-- Consent purpose for analytics, with DRAFT wording v1 (served outside production only, until counsel-reviewed
-- wording is published as a new version).
INSERT INTO "consent_purpose" ("id", "code", "description") VALUES
  ('5e3d1000-0000-4000-8000-000000000190', 'PRODUCT_ANALYTICS', 'Pseudonymous product statistics, seen only as totals by the Exam App team.')
  ON CONFLICT ("code") DO NOTHING;
INSERT INTO "consent_policy_version" ("id", "consent_purpose_id", "version", "text_reference", "effective_from")
  SELECT '5e3d1000-0000-4000-8000-000000000191', p."id", 1, 'consent-text:PRODUCT_ANALYTICS:v1-draft', NOW()
  FROM "consent_purpose" p WHERE p."code" = 'PRODUCT_ANALYTICS'
  AND NOT EXISTS (SELECT 1 FROM "consent_policy_version" v WHERE v."consent_purpose_id" = p."id");
