-- CreateEnum
CREATE TYPE "assessment_item_exclusion" AS ENUM ('TECHNICAL_FAILURE', 'INVALIDATED');

-- AlterEnum
ALTER TYPE "assessment_session_status" ADD VALUE 'INVALIDATED';

-- AlterTable
ALTER TABLE "assessment_instance_question" ADD COLUMN     "excluded" "assessment_item_exclusion",
ADD COLUMN     "excluded_at" TIMESTAMP(3),
ADD COLUMN     "invalidation_id" UUID;

-- AlterTable
ALTER TABLE "assessment_result" ADD COLUMN     "corrected_at" TIMESTAMP(3),
ADD COLUMN     "correction_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "student_response" ADD COLUMN     "skip_idempotency_key" VARCHAR(64);

-- CreateTable
CREATE TABLE "assessment_item_invalidation" (
    "id" UUID NOT NULL,
    "question_revision_id" UUID NOT NULL,
    "reason_code" VARCHAR(40) NOT NULL,
    "note" VARCHAR(1000) NOT NULL,
    "invalidated_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "items_affected" INTEGER NOT NULL,
    "results_rescored" INTEGER NOT NULL,
    "sessions_invalidated" INTEGER NOT NULL,

    CONSTRAINT "assessment_item_invalidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_result_correction" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "invalidation_id" UUID,
    "reason" VARCHAR(32) NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_result_correction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assessment_item_invalidation_question_revision_id_key" ON "assessment_item_invalidation"("question_revision_id");

-- CreateIndex
CREATE INDEX "assessment_result_correction_session_id_created_at_idx" ON "assessment_result_correction"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "assessment_session_status_expires_at_idx" ON "assessment_session"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "assessment_instance_question" ADD CONSTRAINT "assessment_instance_question_invalidation_id_fkey" FOREIGN KEY ("invalidation_id") REFERENCES "assessment_item_invalidation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_result_correction" ADD CONSTRAINT "assessment_result_correction_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "assessment_result"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_result_correction" ADD CONSTRAINT "assessment_result_correction_invalidation_id_fkey" FOREIGN KEY ("invalidation_id") REFERENCES "assessment_item_invalidation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
