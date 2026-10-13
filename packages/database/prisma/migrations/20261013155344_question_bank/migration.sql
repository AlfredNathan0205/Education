-- CreateEnum
CREATE TYPE "question_state" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUIRED', 'APPROVED', 'RETIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "question_difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "question_origin" AS ENUM ('HUMAN', 'AI_DRAFT');

-- CreateTable
CREATE TABLE "question" (
    "id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_revision" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" "question_state" NOT NULL DEFAULT 'DRAFT',
    "origin" "question_origin" NOT NULL,
    "stem" VARCHAR(2000) NOT NULL,
    "explanation" VARCHAR(2000),
    "difficulty" "question_difficulty" NOT NULL,
    "stem_hash" VARCHAR(64) NOT NULL,
    "authored_by" UUID,
    "contributor_ids" UUID[],
    "submitted_by" UUID,
    "reviewed_by" UUID,
    "review_note" VARCHAR(1000),
    "answer_verified" BOOLEAN NOT NULL DEFAULT false,
    "ai_source" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "question_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_option" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "is_correct" BOOLEAN NOT NULL,

    CONSTRAINT "question_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_event" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "from_state" "question_state",
    "to_state" "question_state" NOT NULL,
    "actor_kind" VARCHAR(16) NOT NULL,
    "actor_account_id" UUID,
    "note" VARCHAR(1000),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "question_curriculum_version_id_grade_id_subject_id_idx" ON "question"("curriculum_version_id", "grade_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "question_curriculum_version_id_grade_id_subject_id_code_key" ON "question"("curriculum_version_id", "grade_id", "subject_id", "code");

-- CreateIndex
CREATE INDEX "question_revision_state_idx" ON "question_revision"("state");

-- CreateIndex
CREATE INDEX "question_revision_stem_hash_idx" ON "question_revision"("stem_hash");

-- CreateIndex
CREATE UNIQUE INDEX "question_revision_question_id_revision_key" ON "question_revision"("question_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "question_option_revision_id_position_key" ON "question_option"("revision_id", "position");

-- CreateIndex
CREATE INDEX "question_event_revision_id_idx" ON "question_event"("revision_id");

-- At most one APPROVED revision per question (a new approval supersedes the old one first)
CREATE UNIQUE INDEX question_revision_one_approved_per_question
  ON question_revision (question_id) WHERE state = 'APPROVED';

-- No two live revisions with the same stem wording in the same unit
CREATE UNIQUE INDEX question_revision_stem_unique_per_unit
  ON question_revision (stem_hash)
  WHERE state NOT IN ('SUPERSEDED', 'RETIRED');

-- AddForeignKey
ALTER TABLE "question_revision" ADD CONSTRAINT "question_revision_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_option" ADD CONSTRAINT "question_option_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "question_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_event" ADD CONSTRAINT "question_event_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "question_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
