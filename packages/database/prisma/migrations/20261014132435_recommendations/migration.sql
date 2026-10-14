-- CreateEnum
CREATE TYPE "recommendation_kind" AS ENUM ('PRACTICE', 'RETEST');

-- CreateEnum
CREATE TYPE "recommendation_status" AS ENUM ('OPEN', 'STARTED', 'COMPLETED', 'DISMISSED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "recommendation_source" AS ENUM ('MASTERY', 'RESULT', 'PRACTICE_DONE');

-- AlterEnum
ALTER TYPE "blueprint_scope_mode" ADD VALUE 'OBJECTIVES';

-- AlterTable
ALTER TABLE "assessment_instance" ADD COLUMN     "recommendation_id" UUID,
ADD COLUMN     "target_objectives" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "recommendation_policy_version" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "params" JSONB NOT NULL,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_policy_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "kind" "recommendation_kind" NOT NULL,
    "status" "recommendation_status" NOT NULL DEFAULT 'OPEN',
    "source" "recommendation_source" NOT NULL,
    "objective_paths" TEXT[],
    "policy_version_id" UUID NOT NULL,
    "source_run_id" UUID,
    "source_assessment_id" UUID,
    "parent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_reason" (
    "id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "facts" JSONB NOT NULL,

    CONSTRAINT "recommendation_reason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_event" (
    "id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "assessment_id" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_refresh" (
    "id" UUID NOT NULL,
    "mastery_run_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "outcome" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_refresh_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_policy_version_code_key" ON "recommendation_policy_version"("code");

-- CreateIndex
CREATE INDEX "recommendation_student_id_status_idx" ON "recommendation"("student_id", "status");

-- CreateIndex
CREATE INDEX "recommendation_student_id_subject_id_created_at_idx" ON "recommendation"("student_id", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_reason_recommendation_id_idx" ON "recommendation_reason"("recommendation_id");

-- CreateIndex
CREATE INDEX "recommendation_event_recommendation_id_at_idx" ON "recommendation_event"("recommendation_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_refresh_mastery_run_id_key" ON "recommendation_refresh"("mastery_run_id");

-- CreateIndex
CREATE INDEX "recommendation_refresh_student_id_created_at_idx" ON "recommendation_refresh"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "assessment_instance_recommendation_id_idx" ON "assessment_instance"("recommendation_id");

-- AddForeignKey
ALTER TABLE "assessment_instance" ADD CONSTRAINT "assessment_instance_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "recommendation_policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_reason" ADD CONSTRAINT "recommendation_reason_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_event" ADD CONSTRAINT "recommendation_event_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_refresh" ADD CONSTRAINT "recommendation_refresh_mastery_run_id_fkey" FOREIGN KEY ("mastery_run_id") REFERENCES "mastery_update_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_refresh" ADD CONSTRAINT "recommendation_refresh_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "recommendation_policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Step 14, migration 1 of 2: append to the migration made by
-- `prisma migrate dev --create-only --name recommendations`.

-- Exactly one ACTIVE recommendation policy (Prisma cannot express a partial unique index).
CREATE UNIQUE INDEX "recommendation_policy_version_one_active" ON "recommendation_policy_version" ("status") WHERE "status" = 'ACTIVE';

-- At most one OPEN or STARTED recommendation per student and subject.
CREATE UNIQUE INDEX "recommendation_one_active_per_subject" ON "recommendation" ("student_id", "curriculum_version_id", "grade_id", "subject_id")
  WHERE "status" IN ('OPEN', 'STARTED');

-- A recommendation targets 1 to 10 objectives; a retest always follows a practice; a closed one has a closing time.
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_objectives_check" CHECK ("objective_paths" IS NOT NULL AND cardinality("objective_paths") BETWEEN 1 AND 10);
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_retest_parent_check" CHECK ("kind" <> 'RETEST' OR "parent_id" IS NOT NULL);
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_closed_check" CHECK (("status" IN ('OPEN', 'STARTED')) = ("closed_at" IS NULL));

-- Policy RECO_V1: PROVISIONAL selection rules (see CONSTRUCTION-014). Must match RECO_V1 in
-- apps/api/src/recommendation/recommendation-domain.ts (a unit test checks).
INSERT INTO "recommendation_policy_version" ("id", "code", "status", "params", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000140', 'RECO_V1', 'ACTIVE',
   '{"practice":{"maxObjectives":3,"minEvidence":2,"lowMastery":0.5},"fromResult":{"maxObjectives":3},"retest":{"minPracticeAnswers":5},"dismissDays":7,"blueprints":{"practice":"PRACTICE10","retest":"RETEST10"}}'::jsonb,
   'Seeded by the Step 14 migration. Provisional rules: the spec names the kinds of next action but no selection rules.');
