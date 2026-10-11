-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "auth_identity_kind" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "student_access_kind" AS ENUM ('SELF', 'GUARDIAN', 'SCHOOL_ASSISTED');

-- CreateEnum
CREATE TYPE "guardian_relationship_status" AS ENUM ('CLAIMED', 'VERIFIED', 'REVOKED');

-- CreateEnum
CREATE TYPE "guardian_verification_status" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "jurisdiction_policy_status" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "legal_review_status" AS ENUM ('UNREVIEWED', 'COUNSEL_REVIEWED');

-- CreateEnum
CREATE TYPE "consent_capacity" AS ENUM ('SELF', 'GUARDIAN');

-- CreateEnum
CREATE TYPE "curriculum_state" AS ENUM ('DISCOVERED', 'EVIDENCE_COLLECTION', 'DRAFT', 'AI_STRUCTURED', 'VALIDATION_PENDING', 'VALIDATED', 'ADMIN_REVIEW', 'CHANGES_REQUIRED', 'APPROVED', 'ACTIVE', 'ACTIVE_WITH_REVIEW', 'SUSPENDED', 'BLOCKED', 'REJECTED', 'SUPERSEDED', 'ARCHIVED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "curriculum_provenance" AS ENUM ('OFFICIAL_EXPLICIT', 'OFFICIAL_INFERRED', 'SYSTEM_DERIVED', 'ADMIN_ADDED');

-- CreateEnum
CREATE TYPE "evidence_pack_status" AS ENUM ('DRAFT', 'VERIFIED');

-- CreateEnum
CREATE TYPE "validation_severity" AS ENUM ('ERROR', 'WARNING');

-- CreateEnum
CREATE TYPE "validation_run_status" AS ENUM ('PASSED', 'FAILED');

-- CreateTable
CREATE TABLE "health_check" (
    "id" SERIAL NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "aggregate_type" VARCHAR(255) NOT NULL,
    "aggregate_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(255) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(255) NOT NULL,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "status" "account_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authentication_identity" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" "auth_identity_kind" NOT NULL,
    "identifier_normalized" VARCHAR(320) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authentication_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenge" (
    "id" UUID NOT NULL,
    "kind" "auth_identity_kind" NOT NULL,
    "identifier_normalized" VARCHAR(320) NOT NULL,
    "code_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student" (
    "id" UUID NOT NULL,
    "display_name" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_student_access" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "access_kind" "student_access_kind" NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "account_student_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jurisdiction_policy" (
    "id" UUID NOT NULL,
    "jurisdiction_code" VARCHAR(8) NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "jurisdiction_policy_status" NOT NULL DEFAULT 'DRAFT',
    "legal_review" "legal_review_status" NOT NULL DEFAULT 'UNREVIEWED',
    "legal_review_reference" VARCHAR(255),
    "effective_from" TIMESTAMP(3),
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jurisdiction_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "age_classification" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "jurisdiction_policy_id" UUID,
    "date_of_birth" DATE NOT NULL,
    "is_minor" BOOLEAN NOT NULL,
    "requires_guardian_consent" BOOLEAN NOT NULL,
    "basis" VARCHAR(64) NOT NULL,
    "dob_evidence_method" VARCHAR(64) NOT NULL,
    "classified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "age_classification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian_relationship" (
    "id" UUID NOT NULL,
    "guardian_account_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "relationship_type" VARCHAR(50) NOT NULL,
    "status" "guardian_relationship_status" NOT NULL DEFAULT 'CLAIMED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guardian_relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian_verification" (
    "id" UUID NOT NULL,
    "guardian_relationship_id" UUID NOT NULL,
    "method" VARCHAR(64) NOT NULL,
    "status" "guardian_verification_status" NOT NULL DEFAULT 'PENDING',
    "evidence_reference" VARCHAR(255),
    "jurisdiction_policy_id" UUID,
    "verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardian_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian_authority" (
    "id" UUID NOT NULL,
    "guardian_relationship_id" UUID NOT NULL,
    "guardian_verification_id" UUID NOT NULL,
    "authority_type" VARCHAR(64) NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "guardian_authority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_purpose" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_purpose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_policy_version" (
    "id" UUID NOT NULL,
    "consent_purpose_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "jurisdiction_policy_id" UUID,
    "text_reference" VARCHAR(255) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "consent_policy_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "consent_purpose_id" UUID NOT NULL,
    "consent_policy_version_id" UUID NOT NULL,
    "granted_by_account_id" UUID NOT NULL,
    "capacity" "consent_capacity" NOT NULL,
    "guardian_authority_id" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_withdrawal" (
    "id" UUID NOT NULL,
    "consent_record_id" UUID NOT NULL,
    "withdrawn_by_account_id" UUID NOT NULL,
    "withdrawn_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason_code" VARCHAR(64),

    CONSTRAINT "consent_withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500) NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "resource_scope" (
    "id" UUID NOT NULL,
    "scope_type" VARCHAR(64) NOT NULL,
    "scope_ref" VARCHAR(255) NOT NULL,

    CONSTRAINT "resource_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignment" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "resource_scope_id" UUID,
    "granted_by_account_id" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "actor_account_id" UUID,
    "action" VARCHAR(128) NOT NULL,
    "subject_type" VARCHAR(64) NOT NULL,
    "subject_id" VARCHAR(255) NOT NULL,
    "reason_code" VARCHAR(64),
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_version" (
    "id" UUID NOT NULL,
    "curriculum_id" UUID NOT NULL,
    "label" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,

    CONSTRAINT "subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_subject_version" (
    "id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" "curriculum_state" NOT NULL DEFAULT 'DRAFT',
    "supersedes_id" UUID,
    "last_edited_by" UUID,
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curriculum_subject_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_evidence_pack" (
    "id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "status" "evidence_pack_status" NOT NULL DEFAULT 'DRAFT',
    "verified_by" UUID,
    "verification_note" VARCHAR(1000),
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_evidence_pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_evidence_reference" (
    "id" UUID NOT NULL,
    "pack_id" UUID NOT NULL,
    "source_title" VARCHAR(500) NOT NULL,
    "source_url" VARCHAR(2000),
    "locator" VARCHAR(255),
    "retrieved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_evidence_reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapter" (
    "id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "position" INTEGER NOT NULL,
    "provenance" "curriculum_provenance" NOT NULL,
    "evidence_reference_id" UUID,
    "rationale" VARCHAR(1000),

    CONSTRAINT "chapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic" (
    "id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "position" INTEGER NOT NULL,
    "provenance" "curriculum_provenance" NOT NULL,
    "evidence_reference_id" UUID,
    "rationale" VARCHAR(1000),

    CONSTRAINT "topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "micro_concept" (
    "id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "position" INTEGER NOT NULL,
    "provenance" "curriculum_provenance" NOT NULL,
    "evidence_reference_id" UUID,
    "rationale" VARCHAR(1000),

    CONSTRAINT "micro_concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_objective" (
    "id" UUID NOT NULL,
    "micro_concept_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "statement" VARCHAR(1000) NOT NULL,
    "position" INTEGER NOT NULL,
    "provenance" "curriculum_provenance" NOT NULL,
    "evidence_reference_id" UUID,
    "rationale" VARCHAR(1000),

    CONSTRAINT "learning_objective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_validation_run" (
    "id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "status" "validation_run_status" NOT NULL,
    "error_count" INTEGER NOT NULL,
    "warning_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_validation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_validation_result" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "severity" "validation_severity" NOT NULL,
    "rule" VARCHAR(64) NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "message" VARCHAR(1000) NOT NULL,

    CONSTRAINT "curriculum_validation_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_approval_record" (
    "id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "decision" VARCHAR(16) NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "note" VARCHAR(1000),
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_approval_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_activation_record" (
    "id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_activation_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_event_log" (
    "id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "from_state" "curriculum_state",
    "to_state" "curriculum_state",
    "actor_kind" VARCHAR(16) NOT NULL,
    "actor_account_id" UUID,
    "note" VARCHAR(1000),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_event_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_idempotency_key_key" ON "outbox_event"("idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_event_published_at_idx" ON "outbox_event"("published_at");

-- CreateIndex
CREATE INDEX "outbox_event_created_at_idx" ON "outbox_event"("created_at");

-- CreateIndex
CREATE INDEX "authentication_identity_account_id_idx" ON "authentication_identity"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "authentication_identity_kind_identifier_normalized_key" ON "authentication_identity"("kind", "identifier_normalized");

-- CreateIndex
CREATE INDEX "otp_challenge_kind_identifier_normalized_created_at_idx" ON "otp_challenge"("kind", "identifier_normalized", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_hash_key" ON "auth_session"("token_hash");

-- CreateIndex
CREATE INDEX "auth_session_account_id_idx" ON "auth_session"("account_id");

-- CreateIndex
CREATE INDEX "account_student_access_student_id_idx" ON "account_student_access"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_student_access_account_id_student_id_access_kind_key" ON "account_student_access"("account_id", "student_id", "access_kind");

-- CreateIndex
CREATE UNIQUE INDEX "jurisdiction_policy_jurisdiction_code_version_key" ON "jurisdiction_policy"("jurisdiction_code", "version");

-- CreateIndex
CREATE INDEX "age_classification_student_id_superseded_at_idx" ON "age_classification"("student_id", "superseded_at");

-- CreateIndex
CREATE INDEX "guardian_relationship_student_id_idx" ON "guardian_relationship"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "guardian_relationship_guardian_account_id_student_id_key" ON "guardian_relationship"("guardian_account_id", "student_id");

-- CreateIndex
CREATE INDEX "guardian_verification_guardian_relationship_id_idx" ON "guardian_verification"("guardian_relationship_id");

-- CreateIndex
CREATE INDEX "guardian_authority_guardian_relationship_id_idx" ON "guardian_authority"("guardian_relationship_id");

-- CreateIndex
CREATE UNIQUE INDEX "consent_purpose_code_key" ON "consent_purpose"("code");

-- CreateIndex
CREATE UNIQUE INDEX "consent_policy_version_consent_purpose_id_version_key" ON "consent_policy_version"("consent_purpose_id", "version");

-- CreateIndex
CREATE INDEX "consent_record_student_id_consent_purpose_id_idx" ON "consent_record"("student_id", "consent_purpose_id");

-- CreateIndex
CREATE UNIQUE INDEX "consent_withdrawal_consent_record_id_key" ON "consent_withdrawal"("consent_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_code_key" ON "role"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permission_code_key" ON "permission"("code");

-- CreateIndex
CREATE UNIQUE INDEX "resource_scope_scope_type_scope_ref_key" ON "resource_scope"("scope_type", "scope_ref");

-- CreateIndex
CREATE INDEX "role_assignment_account_id_idx" ON "role_assignment"("account_id");

-- CreateIndex
CREATE INDEX "audit_event_subject_type_subject_id_idx" ON "audit_event"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_code_key" ON "curriculum"("code");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_version_curriculum_id_label_key" ON "curriculum_version"("curriculum_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "grade_code_key" ON "grade"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subject_code_key" ON "subject"("code");

-- CreateIndex
CREATE INDEX "curriculum_subject_version_state_idx" ON "curriculum_subject_version"("state");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_subject_version_curriculum_version_id_grade_id_s_key" ON "curriculum_subject_version"("curriculum_version_id", "grade_id", "subject_id", "revision");

-- CreateIndex
CREATE INDEX "curriculum_evidence_pack_subject_version_id_idx" ON "curriculum_evidence_pack"("subject_version_id");

-- CreateIndex
CREATE INDEX "curriculum_evidence_reference_pack_id_idx" ON "curriculum_evidence_reference"("pack_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapter_subject_version_id_code_key" ON "chapter"("subject_version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "topic_chapter_id_code_key" ON "topic"("chapter_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "micro_concept_topic_id_code_key" ON "micro_concept"("topic_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "learning_objective_micro_concept_id_code_key" ON "learning_objective"("micro_concept_id", "code");

-- CreateIndex
CREATE INDEX "curriculum_validation_run_subject_version_id_idx" ON "curriculum_validation_run"("subject_version_id");

-- CreateIndex
CREATE INDEX "curriculum_validation_result_run_id_idx" ON "curriculum_validation_result"("run_id");

-- CreateIndex
CREATE INDEX "curriculum_approval_record_subject_version_id_idx" ON "curriculum_approval_record"("subject_version_id");

-- CreateIndex
CREATE INDEX "curriculum_activation_record_subject_version_id_idx" ON "curriculum_activation_record"("subject_version_id");

-- CreateIndex
CREATE INDEX "curriculum_event_log_subject_version_id_occurred_at_idx" ON "curriculum_event_log"("subject_version_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "authentication_identity" ADD CONSTRAINT "authentication_identity_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_student_access" ADD CONSTRAINT "account_student_access_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_student_access" ADD CONSTRAINT "account_student_access_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "age_classification" ADD CONSTRAINT "age_classification_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "age_classification" ADD CONSTRAINT "age_classification_jurisdiction_policy_id_fkey" FOREIGN KEY ("jurisdiction_policy_id") REFERENCES "jurisdiction_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_relationship" ADD CONSTRAINT "guardian_relationship_guardian_account_id_fkey" FOREIGN KEY ("guardian_account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_relationship" ADD CONSTRAINT "guardian_relationship_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_verification" ADD CONSTRAINT "guardian_verification_guardian_relationship_id_fkey" FOREIGN KEY ("guardian_relationship_id") REFERENCES "guardian_relationship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_verification" ADD CONSTRAINT "guardian_verification_jurisdiction_policy_id_fkey" FOREIGN KEY ("jurisdiction_policy_id") REFERENCES "jurisdiction_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_authority" ADD CONSTRAINT "guardian_authority_guardian_relationship_id_fkey" FOREIGN KEY ("guardian_relationship_id") REFERENCES "guardian_relationship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_authority" ADD CONSTRAINT "guardian_authority_guardian_verification_id_fkey" FOREIGN KEY ("guardian_verification_id") REFERENCES "guardian_verification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_policy_version" ADD CONSTRAINT "consent_policy_version_consent_purpose_id_fkey" FOREIGN KEY ("consent_purpose_id") REFERENCES "consent_purpose"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_policy_version" ADD CONSTRAINT "consent_policy_version_jurisdiction_policy_id_fkey" FOREIGN KEY ("jurisdiction_policy_id") REFERENCES "jurisdiction_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_consent_purpose_id_fkey" FOREIGN KEY ("consent_purpose_id") REFERENCES "consent_purpose"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_consent_policy_version_id_fkey" FOREIGN KEY ("consent_policy_version_id") REFERENCES "consent_policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_granted_by_account_id_fkey" FOREIGN KEY ("granted_by_account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_guardian_authority_id_fkey" FOREIGN KEY ("guardian_authority_id") REFERENCES "guardian_authority"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_withdrawal" ADD CONSTRAINT "consent_withdrawal_consent_record_id_fkey" FOREIGN KEY ("consent_record_id") REFERENCES "consent_record"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_withdrawal" ADD CONSTRAINT "consent_withdrawal_withdrawn_by_account_id_fkey" FOREIGN KEY ("withdrawn_by_account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_resource_scope_id_fkey" FOREIGN KEY ("resource_scope_id") REFERENCES "resource_scope"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_granted_by_account_id_fkey" FOREIGN KEY ("granted_by_account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_version" ADD CONSTRAINT "curriculum_version_curriculum_id_fkey" FOREIGN KEY ("curriculum_id") REFERENCES "curriculum"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_subject_version" ADD CONSTRAINT "curriculum_subject_version_curriculum_version_id_fkey" FOREIGN KEY ("curriculum_version_id") REFERENCES "curriculum_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_subject_version" ADD CONSTRAINT "curriculum_subject_version_grade_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "grade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_subject_version" ADD CONSTRAINT "curriculum_subject_version_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_subject_version" ADD CONSTRAINT "curriculum_subject_version_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "curriculum_subject_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_evidence_pack" ADD CONSTRAINT "curriculum_evidence_pack_subject_version_id_fkey" FOREIGN KEY ("subject_version_id") REFERENCES "curriculum_subject_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_evidence_reference" ADD CONSTRAINT "curriculum_evidence_reference_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "curriculum_evidence_pack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter" ADD CONSTRAINT "chapter_subject_version_id_fkey" FOREIGN KEY ("subject_version_id") REFERENCES "curriculum_subject_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic" ADD CONSTRAINT "topic_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "micro_concept" ADD CONSTRAINT "micro_concept_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_objective" ADD CONSTRAINT "learning_objective_micro_concept_id_fkey" FOREIGN KEY ("micro_concept_id") REFERENCES "micro_concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_validation_run" ADD CONSTRAINT "curriculum_validation_run_subject_version_id_fkey" FOREIGN KEY ("subject_version_id") REFERENCES "curriculum_subject_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_validation_result" ADD CONSTRAINT "curriculum_validation_result_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "curriculum_validation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_approval_record" ADD CONSTRAINT "curriculum_approval_record_subject_version_id_fkey" FOREIGN KEY ("subject_version_id") REFERENCES "curriculum_subject_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_activation_record" ADD CONSTRAINT "curriculum_activation_record_subject_version_id_fkey" FOREIGN KEY ("subject_version_id") REFERENCES "curriculum_subject_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_event_log" ADD CONSTRAINT "curriculum_event_log_subject_version_id_fkey" FOREIGN KEY ("subject_version_id") REFERENCES "curriculum_subject_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique index: at most one ACTIVE jurisdiction policy per jurisdiction (CONSTRUCTION-002)
CREATE UNIQUE INDEX "jurisdiction_policy_one_active_per_jurisdiction"
  ON "jurisdiction_policy" ("jurisdiction_code")
  WHERE "status" = 'ACTIVE';

-- Partial unique index: at most one live revision per curriculum+version+grade+subject (CONSTRUCTION-003)
CREATE UNIQUE INDEX "curriculum_subject_version_one_live"
  ON "curriculum_subject_version" ("curriculum_version_id", "grade_id", "subject_id")
  WHERE "state" IN ('ACTIVE', 'ACTIVE_WITH_REVIEW');
