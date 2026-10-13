-- CreateEnum
CREATE TYPE "guardian_invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "school_registry_status" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "school_candidate_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "school_association_state" AS ENUM ('UNVERIFIED', 'STUDENT_SELECTED', 'VERIFIED', 'SCHOOL_CONFIRMED');

-- CreateEnum
CREATE TYPE "school_plan_status" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "guardian_invitation" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "invited_by_account_id" UUID NOT NULL,
    "guardian_email_normalized" VARCHAR(320) NOT NULL,
    "relationship_type" VARCHAR(50) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "status" "guardian_invitation_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "accepted_by_account_id" UUID,

    CONSTRAINT "guardian_invitation_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "school_academic_plan" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "curriculum_code" VARCHAR(32) NOT NULL,
    "grade_code" VARCHAR(16) NOT NULL,
    "academic_year" VARCHAR(9) NOT NULL,
    "status" "school_plan_status" NOT NULL DEFAULT 'DRAFT',
    "created_by" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "school_academic_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_plan_entry" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "term_label" VARCHAR(40) NOT NULL,
    "assessment_label" VARCHAR(60) NOT NULL DEFAULT '',
    "subject_code" VARCHAR(64) NOT NULL,
    "chapter_code" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "school_plan_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_chapter_selection" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "subject_code" VARCHAR(64) NOT NULL,
    "chapter_code" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_chapter_selection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guardian_invitation_token_hash_key" ON "guardian_invitation"("token_hash");

-- CreateIndex
CREATE INDEX "guardian_invitation_student_id_created_at_idx" ON "guardian_invitation"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "guardian_invitation_guardian_email_normalized_created_at_idx" ON "guardian_invitation"("guardian_email_normalized", "created_at");

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

-- CreateIndex
CREATE UNIQUE INDEX "school_academic_plan_school_id_curriculum_code_grade_code_a_key" ON "school_academic_plan"("school_id", "curriculum_code", "grade_code", "academic_year");

-- CreateIndex
CREATE UNIQUE INDEX "school_plan_entry_plan_id_term_label_assessment_label_subje_key" ON "school_plan_entry"("plan_id", "term_label", "assessment_label", "subject_code", "chapter_code");

-- CreateIndex
CREATE UNIQUE INDEX "student_chapter_selection_student_id_subject_code_chapter_c_key" ON "student_chapter_selection"("student_id", "subject_code", "chapter_code");

-- AddForeignKey
ALTER TABLE "guardian_invitation" ADD CONSTRAINT "guardian_invitation_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "school_academic_plan" ADD CONSTRAINT "school_academic_plan_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_plan_entry" ADD CONSTRAINT "school_plan_entry_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "school_academic_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_chapter_selection" ADD CONSTRAINT "student_chapter_selection_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one pending guardian invitation per student
CREATE UNIQUE INDEX guardian_invitation_one_pending_per_student
  ON guardian_invitation(student_id) WHERE status = 'PENDING';

-- At most one open school association per student
CREATE UNIQUE INDEX student_school_association_one_open_per_student
  ON student_school_association(student_id) WHERE ended_at IS NULL;

-- Exactly one of school_id / candidate_id is set
ALTER TABLE student_school_association
  ADD CONSTRAINT student_school_association_school_xor_candidate
  CHECK ((school_id IS NOT NULL) <> (candidate_id IS NOT NULL));
