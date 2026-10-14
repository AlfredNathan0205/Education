-- CreateEnum
CREATE TYPE "cp_event_kind" AS ENUM ('AWARD', 'ADJUSTMENT', 'REVERSAL');

-- CreateTable
CREATE TABLE "competitive_scoring_policy" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "params" JSONB NOT NULL,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitive_scoring_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitive_qualification" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "result_revision" INTEGER NOT NULL,
    "student_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "blueprint_code" VARCHAR(32) NOT NULL,
    "qualified" BOOLEAN NOT NULL,
    "reasons" TEXT[],
    "eligible_questions" INTEGER NOT NULL,
    "fresh_questions" INTEGER NOT NULL,
    "correct" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "weighted_accuracy" DOUBLE PRECISION NOT NULL,
    "difficulty_score" DOUBLE PRECISION NOT NULL,
    "cp" INTEGER NOT NULL,
    "parts" JSONB NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitive_qualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cp_event" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "qualification_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "kind" "cp_event_kind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "earned_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cp_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xp_event" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "earned_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_profile" (
    "student_id" UUID NOT NULL,
    "handle" VARCHAR(24) NOT NULL,
    "shown_to_others" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_profile_pkey" PRIMARY KEY ("student_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "competitive_scoring_policy_code_key" ON "competitive_scoring_policy"("code");

-- CreateIndex
CREATE INDEX "competitive_qualification_student_id_finished_at_idx" ON "competitive_qualification"("student_id", "finished_at");

-- CreateIndex
CREATE INDEX "competitive_qualification_curriculum_version_id_grade_id_fi_idx" ON "competitive_qualification"("curriculum_version_id", "grade_id", "finished_at");

-- CreateIndex
CREATE UNIQUE INDEX "competitive_qualification_session_id_result_revision_key" ON "competitive_qualification"("session_id", "result_revision");

-- CreateIndex
CREATE INDEX "cp_event_student_id_earned_at_idx" ON "cp_event"("student_id", "earned_at");

-- CreateIndex
CREATE INDEX "cp_event_curriculum_version_id_grade_id_earned_at_idx" ON "cp_event"("curriculum_version_id", "grade_id", "earned_at");

-- CreateIndex
CREATE UNIQUE INDEX "xp_event_session_id_key" ON "xp_event"("session_id");

-- CreateIndex
CREATE INDEX "xp_event_student_id_earned_at_idx" ON "xp_event"("student_id", "earned_at");

-- CreateIndex
CREATE UNIQUE INDEX "public_profile_handle_key" ON "public_profile"("handle");

-- AddForeignKey
ALTER TABLE "competitive_qualification" ADD CONSTRAINT "competitive_qualification_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "competitive_scoring_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cp_event" ADD CONSTRAINT "cp_event_qualification_id_fkey" FOREIGN KEY ("qualification_id") REFERENCES "competitive_qualification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cp_event" ADD CONSTRAINT "cp_event_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "competitive_scoring_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xp_event" ADD CONSTRAINT "xp_event_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "competitive_scoring_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Step 15: append to the migration made by `prisma migrate dev --create-only --name competition`.

-- Exactly one ACTIVE competition policy (Prisma cannot express a partial unique index).
CREATE UNIQUE INDEX "competitive_scoring_policy_one_active" ON "competitive_scoring_policy" ("status") WHERE "status" = 'ACTIVE';

-- The CP ledger is immutable (spec: corrections are compensating entries). Rows can be added, never changed or
-- deleted. TRUNCATE (test databases only) is not a row operation and is not blocked.
CREATE OR REPLACE FUNCTION "cp_event_is_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cp_event is append-only: add a compensating entry instead of changing or deleting one';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cp_event_no_update_or_delete" BEFORE UPDATE OR DELETE ON "cp_event"
  FOR EACH ROW EXECUTE FUNCTION "cp_event_is_append_only"();

-- An AWARD is positive, a REVERSAL negative, nothing is zero; XP is positive; a qualification's CP is never negative.
ALTER TABLE "cp_event" ADD CONSTRAINT "cp_event_amount_check" CHECK ("amount" <> 0 AND ("kind" <> 'AWARD' OR "amount" > 0) AND ("kind" <> 'REVERSAL' OR "amount" < 0));
ALTER TABLE "xp_event" ADD CONSTRAINT "xp_event_amount_check" CHECK ("amount" > 0);
ALTER TABLE "competitive_qualification" ADD CONSTRAINT "competitive_qualification_cp_check" CHECK ("cp" >= 0 AND ("qualified" OR "cp" = 0));

-- Policy CP_V1: PROVISIONAL weights (see CONSTRUCTION-015). Must match CP_V1 in
-- apps/api/src/competition/competition-domain.ts (a unit test checks).
INSERT INTO "competitive_scoring_policy" ("id", "code", "status", "params", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000150', 'CP_V1', 'ACTIVE',
   '{"base":{"QUICK10":100,"FOCUS10":100,"SUBJECT20":200,"SUBJECT25":250},"difficultyWeight":{"EASY":1,"MEDIUM":1.25,"HARD":1.5},"accuracyShare":0.9,"improvementShare":0.1,"minEligibleQuestions":5,"ranking":{"minQualified":2,"minEligibleQuestions":20,"boardSize":10},"xp":{"perAnswer":1,"perFinish":5},"week":{"utcOffsetMinutes":330}}'::jsonb,
   'Seeded by the Step 15 migration. Spec maxima (100/200/250), ranking minimums and tie order; weights provisional.');
