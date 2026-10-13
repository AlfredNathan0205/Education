-- CreateEnum
CREATE TYPE "generation_batch_status" AS ENUM ('RUNNING', 'STOP_REQUESTED', 'COMPLETED', 'STOPPED');

-- CreateEnum
CREATE TYPE "generation_attempt_outcome" AS ENUM ('DRAFT_STORED', 'REJECTED_STRUCTURE', 'REJECTED_DUPLICATE', 'REJECTED_QUALITY', 'FAILED_VALIDATION', 'FAILED_GENERATION');

-- CreateEnum
CREATE TYPE "ai_call_status" AS ENUM ('OK', 'INVALID_OUTPUT', 'ERROR');

-- CreateTable
CREATE TABLE "generation_batch" (
    "id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "difficulty" "question_difficulty" NOT NULL,
    "cognitive" "question_cognitive" NOT NULL,
    "requested_count" INTEGER NOT NULL,
    "status" "generation_batch_status" NOT NULL DEFAULT 'RUNNING',
    "stop_reason" VARCHAR(255),
    "requested_by" VARCHAR(255) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "config_version" VARCHAR(32) NOT NULL,
    "drafts_stored" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "generation_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_attempt" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "outcome" "generation_attempt_outcome" NOT NULL,
    "route" VARCHAR(8),
    "confidence" DOUBLE PRECISION,
    "repairs" INTEGER NOT NULL DEFAULT 0,
    "candidate" JSONB,
    "evidence" JSONB,
    "question_revision_id" UUID,
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_call_log" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "attempt_seq" INTEGER,
    "role" VARCHAR(40) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "prompt_version" VARCHAR(16) NOT NULL,
    "schema_version" VARCHAR(16) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "output_hash" VARCHAR(64),
    "latency_ms" INTEGER NOT NULL,
    "status" "ai_call_status" NOT NULL,
    "detail" VARCHAR(300),
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_call_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_batch_curriculum_version_id_grade_id_subject_id__idx" ON "generation_batch"("curriculum_version_id", "grade_id", "subject_id", "objective_path", "started_at");

-- CreateIndex
CREATE INDEX "generation_attempt_question_revision_id_idx" ON "generation_attempt"("question_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_attempt_batch_id_sequence_key" ON "generation_attempt"("batch_id", "sequence");

-- CreateIndex
CREATE INDEX "ai_call_log_batch_id_idx" ON "ai_call_log"("batch_id");

-- CreateIndex
CREATE INDEX "ai_call_log_created_at_idx" ON "ai_call_log"("created_at");

-- AddForeignKey
ALTER TABLE "generation_attempt" ADD CONSTRAINT "generation_attempt_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "generation_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_call_log" ADD CONSTRAINT "ai_call_log_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "generation_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
