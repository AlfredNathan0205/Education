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
