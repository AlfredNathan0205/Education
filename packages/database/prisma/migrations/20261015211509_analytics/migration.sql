-- CreateTable
CREATE TABLE "analytics_event" (
    "id" UUID NOT NULL,
    "subject_key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "source" VARCHAR(8) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "cohort" VARCHAR(64),
    "props" JSONB,
    "source_ref" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_cursor" (
    "id" VARCHAR(32) NOT NULL,
    "last_created_at" TIMESTAMP(3) NOT NULL,
    "last_event_id" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "stopped_at" TIMESTAMP(3),

    CONSTRAINT "experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_variant" (
    "id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "key" VARCHAR(32) NOT NULL,
    "weight" INTEGER NOT NULL,
    "is_control" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "experiment_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_assignment" (
    "id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "subject_key" VARCHAR(64) NOT NULL,
    "variant_key" VARCHAR(32) NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analytics_event_source_ref_key" ON "analytics_event"("source_ref");

-- CreateIndex
CREATE INDEX "analytics_event_name_occurred_at_idx" ON "analytics_event"("name", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_event_subject_key_occurred_at_idx" ON "analytics_event"("subject_key", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_key_key" ON "experiment"("key");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_variant_experiment_id_key_key" ON "experiment_variant"("experiment_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_assignment_experiment_id_subject_key_key" ON "experiment_assignment"("experiment_id", "subject_key");

-- AddForeignKey
ALTER TABLE "experiment_variant" ADD CONSTRAINT "experiment_variant_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignment" ADD CONSTRAINT "experiment_assignment_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignment" ADD CONSTRAINT "experiment_assignment_variant_fkey" FOREIGN KEY ("experiment_id", "variant_key") REFERENCES "experiment_variant"("experiment_id", "key") ON DELETE CASCADE ON UPDATE CASCADE;
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
