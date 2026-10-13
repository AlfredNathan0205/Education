-- CreateEnum
CREATE TYPE "question_cognitive" AS ENUM ('C1', 'C2', 'C3', 'C4');

-- CreateEnum
CREATE TYPE "question_type" AS ENUM ('MCQ');

-- AlterEnum
ALTER TYPE "question_state" ADD VALUE 'QUARANTINED';

-- AlterTable
ALTER TABLE "question_event" ADD COLUMN     "reason_code" VARCHAR(32);

-- AlterTable
ALTER TABLE "question_revision" ADD COLUMN     "cognitive" "question_cognitive",
ADD COLUMN     "question_type" "question_type" NOT NULL DEFAULT 'MCQ';

-- CreateTable
CREATE TABLE "question_validation_run" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "validator_version" VARCHAR(32) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "critical_count" INTEGER NOT NULL,
    "major_count" INTEGER NOT NULL,
    "minor_count" INTEGER NOT NULL,
    "findings" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_validation_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "question_validation_run_revision_id_created_at_idx" ON "question_validation_run"("revision_id", "created_at");

-- AddForeignKey
ALTER TABLE "question_validation_run" ADD CONSTRAINT "question_validation_run_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "question_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
