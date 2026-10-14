-- CreateEnum
CREATE TYPE "blueprint_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "blueprint_scope_mode" AS ENUM ('WHOLE_SUBJECT', 'CHAPTERS', 'STUDENT_FOCUS');

-- CreateTable
CREATE TABLE "assessment_blueprint" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "curriculum_code" VARCHAR(32),
    "grade_code" VARCHAR(16),
    "subject_code" VARCHAR(64),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_blueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_blueprint_version" (
    "id" UUID NOT NULL,
    "blueprint_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "blueprint_version_status" NOT NULL DEFAULT 'DRAFT',
    "total_questions" INTEGER NOT NULL,
    "scope_mode" "blueprint_scope_mode" NOT NULL DEFAULT 'WHOLE_SUBJECT',
    "scope_strict" BOOLEAN NOT NULL DEFAULT false,
    "prefer_unseen" BOOLEAN NOT NULL DEFAULT true,
    "opening_difficulty" "question_difficulty",
    "notes" VARCHAR(1000),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "assessment_blueprint_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_scope" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "chapter_code" VARCHAR(64) NOT NULL,

    CONSTRAINT "blueprint_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_difficulty_requirement" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "difficulty" "question_difficulty" NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "blueprint_difficulty_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_type_requirement" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "question_type" "question_type" NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "blueprint_type_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_cell_requirement" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "chapter_code" VARCHAR(64),
    "difficulty" "question_difficulty",
    "cognitive" "question_cognitive",
    "min_count" INTEGER NOT NULL,

    CONSTRAINT "blueprint_cell_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_assembly_run" (
    "id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "blueprint_version_id" UUID NOT NULL,
    "engine_version" VARCHAR(32) NOT NULL,
    "seed" VARCHAR(64) NOT NULL,
    "mode" "assessment_mode" NOT NULL,
    "eligible_count" INTEGER NOT NULL,
    "requested" JSONB NOT NULL,
    "delivered" JSONB NOT NULL,
    "relaxations" JSONB NOT NULL,
    "relaxed" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_assembly_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_assembly_decision" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "question_revision_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "requirement" VARCHAR(16) NOT NULL,
    "cell_position" INTEGER,
    "wanted_difficulty" "question_difficulty" NOT NULL,
    "difficulty" "question_difficulty" NOT NULL,
    "reasons" TEXT[],
    "candidates" INTEGER NOT NULL,

    CONSTRAINT "assessment_assembly_decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assessment_blueprint_code_key" ON "assessment_blueprint"("code");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_blueprint_version_blueprint_id_version_key" ON "assessment_blueprint_version"("blueprint_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_scope_version_id_chapter_code_key" ON "blueprint_scope"("version_id", "chapter_code");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_difficulty_requirement_version_id_difficulty_key" ON "blueprint_difficulty_requirement"("version_id", "difficulty");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_type_requirement_version_id_question_type_key" ON "blueprint_type_requirement"("version_id", "question_type");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_cell_requirement_version_id_position_key" ON "blueprint_cell_requirement"("version_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_assembly_run_instance_id_key" ON "assessment_assembly_run"("instance_id");

-- CreateIndex
CREATE INDEX "assessment_assembly_run_blueprint_version_id_created_at_idx" ON "assessment_assembly_run"("blueprint_version_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_assembly_decision_run_id_position_key" ON "assessment_assembly_decision"("run_id", "position");

-- AddForeignKey
ALTER TABLE "assessment_blueprint_version" ADD CONSTRAINT "assessment_blueprint_version_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "assessment_blueprint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_scope" ADD CONSTRAINT "blueprint_scope_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "assessment_blueprint_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_difficulty_requirement" ADD CONSTRAINT "blueprint_difficulty_requirement_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "assessment_blueprint_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_type_requirement" ADD CONSTRAINT "blueprint_type_requirement_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "assessment_blueprint_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_cell_requirement" ADD CONSTRAINT "blueprint_cell_requirement_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "assessment_blueprint_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_assembly_run" ADD CONSTRAINT "assessment_assembly_run_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "assessment_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_assembly_run" ADD CONSTRAINT "assessment_assembly_run_blueprint_version_id_fkey" FOREIGN KEY ("blueprint_version_id") REFERENCES "assessment_blueprint_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_assembly_decision" ADD CONSTRAINT "assessment_assembly_decision_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "assessment_assembly_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Step 10: append to the migration made by `prisma migrate dev --create-only --name blueprint_assembly`.

-- At most one PUBLISHED and one DRAFT version per blueprint (Prisma cannot express partial unique indexes).
CREATE UNIQUE INDEX "assessment_blueprint_version_one_published" ON "assessment_blueprint_version" ("blueprint_id") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "assessment_blueprint_version_one_draft" ON "assessment_blueprint_version" ("blueprint_id") WHERE "status" = 'DRAFT';

-- Counts are never negative; a cell asks for at least one question; a version has at least one question.
ALTER TABLE "assessment_blueprint_version" ADD CONSTRAINT "assessment_blueprint_version_total_check" CHECK ("total_questions" BETWEEN 1 AND 50);
ALTER TABLE "blueprint_difficulty_requirement" ADD CONSTRAINT "blueprint_difficulty_requirement_count_check" CHECK ("count" >= 0);
ALTER TABLE "blueprint_type_requirement" ADD CONSTRAINT "blueprint_type_requirement_count_check" CHECK ("count" >= 0);
ALTER TABLE "blueprint_cell_requirement" ADD CONSTRAINT "blueprint_cell_requirement_min_count_check" CHECK ("min_count" >= 1);

-- Seed designs. QUICK10 v1 is the Quick 10 that was built in code before Step 10 (5/3/2, whole subject, open with EASY),
-- published and switched on so students see no change. SUBJECT20 v1 is a DRAFT, switched off: its 8/7/5 split is a guess
-- (spec D1-D5 = 3/5/6/4/2 grouped as D1+D2, D3, D4+D5 = 8/6/6, one moved to MEDIUM) to be confirmed. SUBJECT25 has no
-- version and is off: the spec allows it only when content readiness permits.
INSERT INTO "assessment_blueprint" ("id", "code", "name", "description", "enabled", "updated_at") VALUES
  ('5e3d1000-0000-4000-8000-000000000010', 'QUICK10', 'Quick 10', 'Ten questions from the whole subject: 5 easy, 3 medium, 2 hard.', true, CURRENT_TIMESTAMP),
  ('5e3d1000-0000-4000-8000-000000000020', 'SUBJECT20', 'Subject test (20)', 'Twenty questions from the whole subject. The difficulty split is a guess to confirm before publishing.', false, CURRENT_TIMESTAMP),
  ('5e3d1000-0000-4000-8000-000000000025', 'SUBJECT25', 'Subject test (25)', 'Off until content readiness permits (spec). No version yet.', false, CURRENT_TIMESTAMP);

INSERT INTO "assessment_blueprint_version"
  ("id", "blueprint_id", "version", "status", "total_questions", "scope_mode", "scope_strict", "prefer_unseen", "opening_difficulty", "notes", "published_at") VALUES
  ('5e3d1000-0000-4000-8000-000000000110', '5e3d1000-0000-4000-8000-000000000010', 1, 'PUBLISHED', 10, 'WHOLE_SUBJECT', false, true, 'EASY',
   'Seeded by the Step 10 migration: the Quick 10 previously built in code.', CURRENT_TIMESTAMP),
  ('5e3d1000-0000-4000-8000-000000000120', '5e3d1000-0000-4000-8000-000000000020', 1, 'DRAFT', 20, 'WHOLE_SUBJECT', false, true, 'EASY',
   'GUESS to confirm: spec D1-D5 3/5/6/4/2 mapped to three levels as 8/7/5.', NULL);

INSERT INTO "blueprint_difficulty_requirement" ("id", "version_id", "difficulty", "count") VALUES
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000110', 'EASY', 5),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000110', 'MEDIUM', 3),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000110', 'HARD', 2),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000120', 'EASY', 8),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000120', 'MEDIUM', 7),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000120', 'HARD', 5);

INSERT INTO "blueprint_type_requirement" ("id", "version_id", "question_type", "count") VALUES
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000110', 'MCQ', 10),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000120', 'MCQ', 20);
