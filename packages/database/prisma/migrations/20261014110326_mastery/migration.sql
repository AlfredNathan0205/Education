-- CreateTable
CREATE TABLE "mastery_policy_version" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "params" JSONB NOT NULL,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mastery_policy_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mastery_evidence_event" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "learning_objective_id" UUID,
    "subject_version_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "instance_question_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "question_revision_id" UUID NOT NULL,
    "mode" "assessment_mode" NOT NULL,
    "blueprint_code" VARCHAR(32) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "difficulty" "question_difficulty" NOT NULL,
    "cognitive" "question_cognitive",
    "w_independence" DOUBLE PRECISION NOT NULL,
    "w_context" DOUBLE PRECISION NOT NULL,
    "w_quality" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidated_at" TIMESTAMP(3),
    "invalidation_reason" VARCHAR(32),

    CONSTRAINT "mastery_evidence_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_mastery_state" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "alpha" DOUBLE PRECISION NOT NULL,
    "beta" DOUBLE PRECISION NOT NULL,
    "mastery" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "effective_evidence" DOUBLE PRECISION NOT NULL,
    "evidence_count" INTEGER NOT NULL,
    "families" INTEGER NOT NULL,
    "sessions" INTEGER NOT NULL,
    "controlled_evidence" INTEGER NOT NULL,
    "label" VARCHAR(24) NOT NULL,
    "reportable" BOOLEAN NOT NULL,
    "last_evidence_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_mastery_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mastery_update_run" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "result_revision" INTEGER NOT NULL,
    "student_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "evidence_added" INTEGER NOT NULL,
    "evidence_invalidated" INTEGER NOT NULL,
    "objectives_changed" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mastery_update_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mastery_state_change" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "subject_id" UUID NOT NULL,
    "before_label" VARCHAR(24),
    "after_label" VARCHAR(24) NOT NULL,
    "before_mastery" DOUBLE PRECISION,
    "after_mastery" DOUBLE PRECISION NOT NULL,
    "before_confidence" DOUBLE PRECISION,
    "after_confidence" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mastery_state_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_difficulty_state" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "difficulty" "question_difficulty" NOT NULL,
    "mastery" DOUBLE PRECISION NOT NULL,
    "effective_evidence" DOUBLE PRECISION NOT NULL,
    "evidence_count" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_difficulty_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_cognitive_state" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "cognitive" "question_cognitive" NOT NULL,
    "mastery" DOUBLE PRECISION NOT NULL,
    "effective_evidence" DOUBLE PRECISION NOT NULL,
    "evidence_count" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_cognitive_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mastery_policy_version_code_key" ON "mastery_policy_version"("code");

-- CreateIndex
CREATE INDEX "mastery_evidence_event_student_id_curriculum_version_id_gra_idx" ON "mastery_evidence_event"("student_id", "curriculum_version_id", "grade_id", "subject_id", "objective_path");

-- CreateIndex
CREATE INDEX "mastery_evidence_event_student_id_question_id_idx" ON "mastery_evidence_event"("student_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "mastery_evidence_event_session_id_instance_question_id_key" ON "mastery_evidence_event"("session_id", "instance_question_id");

-- CreateIndex
CREATE INDEX "student_mastery_state_student_id_subject_id_idx" ON "student_mastery_state"("student_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_mastery_state_student_id_curriculum_version_id_grad_key" ON "student_mastery_state"("student_id", "curriculum_version_id", "grade_id", "subject_id", "objective_path");

-- CreateIndex
CREATE INDEX "mastery_update_run_student_id_created_at_idx" ON "mastery_update_run"("student_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "mastery_update_run_session_id_result_revision_key" ON "mastery_update_run"("session_id", "result_revision");

-- CreateIndex
CREATE INDEX "mastery_state_change_student_id_objective_path_created_at_idx" ON "mastery_state_change"("student_id", "objective_path", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "student_difficulty_state_student_id_subject_id_difficulty_key" ON "student_difficulty_state"("student_id", "subject_id", "difficulty");

-- CreateIndex
CREATE UNIQUE INDEX "student_cognitive_state_student_id_subject_id_cognitive_key" ON "student_cognitive_state"("student_id", "subject_id", "cognitive");

-- AddForeignKey
ALTER TABLE "mastery_evidence_event" ADD CONSTRAINT "mastery_evidence_event_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "mastery_policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mastery_update_run" ADD CONSTRAINT "mastery_update_run_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "mastery_policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mastery_state_change" ADD CONSTRAINT "mastery_state_change_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mastery_update_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Step 13: append to the migration made by `prisma migrate dev --create-only --name mastery`.

-- Exactly one ACTIVE mastery policy (Prisma cannot express a partial unique index).
CREATE UNIQUE INDEX "mastery_policy_version_one_active" ON "mastery_policy_version" ("status") WHERE "status" = 'ACTIVE';

-- Weights and counts are never negative; a score is 0 or 1.
ALTER TABLE "mastery_evidence_event" ADD CONSTRAINT "mastery_evidence_event_weight_check" CHECK ("weight" >= 0 AND "weight" <= 1);
ALTER TABLE "mastery_evidence_event" ADD CONSTRAINT "mastery_evidence_event_score_check" CHECK ("score" IN (0, 1));

-- Policy MASTERY_V1: the spec's baseline weights, prior and gates, plus a provisional confidence formula (see
-- CONSTRUCTION-013). Must match MASTERY_V1 in apps/api/src/mastery/mastery-domain.ts.
INSERT INTO "mastery_policy_version" ("id", "code", "status", "params", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000130', 'MASTERY_V1', 'ACTIVE',
   '{"prior":{"alpha":1,"beta":1},"independence":{"distinct":1,"exactRepeat":0.05},"context":{"fullTest":1,"quickTest":0.9,"practice":0.6,"fullTestMinQuestions":20},"quality":{"HEALTHY":1,"NEW":0.9,"WATCH":0.7,"DEGRADED":0.3,"QUARANTINED":0},"weightCap":1,"confidence":{"volumeScale":2.5,"diversityBase":0.6,"diversityPerFamily":0.2,"singleSessionFactor":0.85,"recencyFullDays":30,"recencyFloorDays":180,"recencyFloor":0.8},"gates":{"ordinary":{"confidence":75,"effective":5,"families":2,"sessions":2,"controlled":1},"strong":{"mastery":85,"confidence":85,"effective":6,"families":3,"sessions":2},"weak":{"effective":6,"families":3,"sessions":2}},"bands":{"strong":85,"secure":70,"developing":55},"rollup":{"minReportableShare":0.6,"minReportable":2}}'::jsonb,
   'Seeded by the Step 13 migration. Spec baseline weights/prior/gates; confidence formula provisional; families = distinct questions until the bank has reasoning families.');
