-- CreateEnum
CREATE TYPE "school_registry_status" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "school_candidate_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "school_association_state" AS ENUM ('UNVERIFIED', 'STUDENT_SELECTED', 'VERIFIED', 'SCHOOL_CONFIRMED');

-- CreateTable
CREATE TABLE "school" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "city" VARCHAR(100),
    "status" "school_registry_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_alias" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "alias" VARCHAR(200) NOT NULL,

    CONSTRAINT "school_alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_branch" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "city" VARCHAR(100),
    "status" "school_registry_status" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "school_branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_candidate" (
    "id" UUID NOT NULL,
    "name_as_entered" VARCHAR(200) NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "status" "school_candidate_status" NOT NULL DEFAULT 'PENDING',
    "resolved_school_id" UUID,
    "resolved_by" VARCHAR(255),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_school_association" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID,
    "branch_id" UUID,
    "candidate_id" UUID,
    "state" "school_association_state" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "end_reason" VARCHAR(32),

    CONSTRAINT "student_school_association_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_academic_context" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "curriculum_code" VARCHAR(32) NOT NULL,
    "grade_code" VARCHAR(16) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_academic_context_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "school_country_code_name_key" ON "school"("country_code", "name");

-- CreateIndex
CREATE UNIQUE INDEX "school_alias_school_id_alias_key" ON "school_alias"("school_id", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "school_branch_school_id_name_key" ON "school_branch"("school_id", "name");

-- CreateIndex
CREATE INDEX "school_candidate_status_idx" ON "school_candidate"("status");

-- CreateIndex
CREATE INDEX "student_school_association_student_id_ended_at_idx" ON "student_school_association"("student_id", "ended_at");

-- CreateIndex
CREATE UNIQUE INDEX "student_academic_context_student_id_key" ON "student_academic_context"("student_id");

-- AddForeignKey
ALTER TABLE "school_alias" ADD CONSTRAINT "school_alias_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_branch" ADD CONSTRAINT "school_branch_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_candidate" ADD CONSTRAINT "school_candidate_resolved_school_id_fkey" FOREIGN KEY ("resolved_school_id") REFERENCES "school"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_school_association" ADD CONSTRAINT "student_school_association_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_school_association" ADD CONSTRAINT "student_school_association_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "school"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_school_association" ADD CONSTRAINT "student_school_association_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "school_branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_school_association" ADD CONSTRAINT "student_school_association_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "school_candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_academic_context" ADD CONSTRAINT "student_academic_context_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most ONE open association per student
CREATE UNIQUE INDEX student_school_association_one_open_per_student
  ON student_school_association (student_id) WHERE ended_at IS NULL;

-- Exactly one of school_id / candidate_id is set
ALTER TABLE student_school_association
  ADD CONSTRAINT student_school_association_school_xor_candidate
  CHECK ((school_id IS NOT NULL) <> (candidate_id IS NOT NULL));
