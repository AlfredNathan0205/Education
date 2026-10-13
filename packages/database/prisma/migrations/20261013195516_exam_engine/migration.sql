-- CreateEnum
CREATE TYPE "assessment_mode" AS ENUM ('TEST', 'PRACTICE');

-- CreateEnum
CREATE TYPE "assessment_session_status" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'VOID');

-- CreateEnum
CREATE TYPE "student_response_state" AS ENUM ('SKIPPED', 'LOCKED');

-- CreateTable
CREATE TABLE "assessment_instance" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "mode" "assessment_mode" NOT NULL,
    "blueprint_code" VARCHAR(32) NOT NULL,
    "blueprint_version" INTEGER NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "seed" VARCHAR(64) NOT NULL,
    "assembly_report" JSONB NOT NULL,
    "assembled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_instance_question" (
    "id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "question_revision_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "difficulty" "question_difficulty" NOT NULL,
    "option_order" INTEGER[],

    CONSTRAINT "assessment_instance_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_session" (
    "id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "mode" "assessment_mode" NOT NULL,
    "status" "assessment_session_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisit_used" BOOLEAN NOT NULL DEFAULT false,
    "committed_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),

    CONSTRAINT "assessment_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_response" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "instance_question_id" UUID NOT NULL,
    "state" "student_response_state",
    "skip_count" INTEGER NOT NULL DEFAULT 0,
    "selected_slot" INTEGER,
    "selected_position" INTEGER,
    "is_correct" BOOLEAN,
    "presented_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "active_ms" INTEGER,
    "server_elapsed_ms" INTEGER,
    "idempotency_key" VARCHAR(64),

    CONSTRAINT "student_response_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_response_event" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "instance_question_id" UUID NOT NULL,
    "event_type" VARCHAR(24) NOT NULL,
    "active_ms" INTEGER,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_response_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_submission" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "reason" VARCHAR(16) NOT NULL,
    "answered_count" INTEGER NOT NULL,
    "unanswered_count" INTEGER NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_result" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "mode" "assessment_mode" NOT NULL,
    "scoring_policy" VARCHAR(32) NOT NULL,
    "total" INTEGER NOT NULL,
    "correct" INTEGER NOT NULL,
    "unanswered" INTEGER NOT NULL,
    "by_difficulty" JSONB NOT NULL,
    "competitive_eligible" BOOLEAN NOT NULL,
    "scored_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_question_exposure" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "times_seen" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "student_question_exposure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assessment_instance_student_id_assembled_at_idx" ON "assessment_instance"("student_id", "assembled_at");

-- CreateIndex
CREATE INDEX "assessment_instance_question_question_revision_id_idx" ON "assessment_instance_question"("question_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_instance_question_instance_id_position_key" ON "assessment_instance_question"("instance_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_instance_question_instance_id_question_revision__key" ON "assessment_instance_question"("instance_id", "question_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_session_instance_id_key" ON "assessment_session"("instance_id");

-- CreateIndex
CREATE INDEX "assessment_session_student_id_status_idx" ON "assessment_session"("student_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "student_response_instance_question_id_key" ON "student_response"("instance_question_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_response_session_id_idempotency_key_key" ON "student_response"("session_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "student_response_event_session_id_occurred_at_idx" ON "student_response_event"("session_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_submission_session_id_key" ON "assessment_submission"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_result_session_id_key" ON "assessment_result"("session_id");

-- CreateIndex
CREATE INDEX "assessment_result_student_id_scored_at_idx" ON "assessment_result"("student_id", "scored_at");

-- CreateIndex
CREATE UNIQUE INDEX "student_question_exposure_student_id_question_id_key" ON "student_question_exposure"("student_id", "question_id");

-- AddForeignKey
ALTER TABLE "assessment_instance" ADD CONSTRAINT "assessment_instance_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_instance_question" ADD CONSTRAINT "assessment_instance_question_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "assessment_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_instance_question" ADD CONSTRAINT "assessment_instance_question_question_revision_id_fkey" FOREIGN KEY ("question_revision_id") REFERENCES "question_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_session" ADD CONSTRAINT "assessment_session_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "assessment_instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_response" ADD CONSTRAINT "student_response_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "assessment_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_response" ADD CONSTRAINT "student_response_instance_question_id_fkey" FOREIGN KEY ("instance_question_id") REFERENCES "assessment_instance_question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_response_event" ADD CONSTRAINT "student_response_event_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "assessment_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_submission" ADD CONSTRAINT "assessment_submission_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "assessment_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_result" ADD CONSTRAINT "assessment_result_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "assessment_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_question_exposure" ADD CONSTRAINT "student_question_exposure_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
