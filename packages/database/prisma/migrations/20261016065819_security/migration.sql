-- AlterTable
ALTER TABLE "account" ADD COLUMN     "erased_at" TIMESTAMP(3),
ADD COLUMN     "inactive_flagged_at" TIMESTAMP(3),
ADD COLUMN     "last_sign_in_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "auth_session" ADD COLUMN     "mfa_verified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "student" ADD COLUMN     "erased_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "privacy_request" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "subject_type" VARCHAR(16) NOT NULL,
    "subject_id" UUID NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "capacity" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_account_id" UUID,
    "completed_at" TIMESTAMP(3),
    "failure_code" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "privacy_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_tombstone" (
    "id" UUID NOT NULL,
    "subject_type" VARCHAR(16) NOT NULL,
    "subject_id" UUID NOT NULL,
    "account_ids" UUID[],
    "request_id" UUID,
    "erased_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deletion_tombstone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_mfa_factor" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "secret_ciphertext" VARCHAR(512) NOT NULL,
    "last_used_step" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),

    CONSTRAINT "admin_mfa_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_mfa_recovery_code" (
    "id" UUID NOT NULL,
    "factor_id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_run" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "counts" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "error" VARCHAR(300),

    CONSTRAINT "retention_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "privacy_request_subject_type_subject_id_kind_idx" ON "privacy_request"("subject_type", "subject_id", "kind");

-- CreateIndex
CREATE INDEX "privacy_request_status_due_at_idx" ON "privacy_request"("status", "due_at");

-- CreateIndex
CREATE INDEX "privacy_request_requested_by_account_id_requested_at_idx" ON "privacy_request"("requested_by_account_id", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "deletion_tombstone_subject_type_subject_id_key" ON "deletion_tombstone"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_mfa_factor_account_id_key" ON "admin_mfa_factor"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_mfa_recovery_code_code_hash_key" ON "admin_mfa_recovery_code"("code_hash");

-- CreateIndex
CREATE INDEX "admin_mfa_recovery_code_factor_id_idx" ON "admin_mfa_recovery_code"("factor_id");

-- CreateIndex
CREATE INDEX "retention_run_started_at_idx" ON "retention_run"("started_at");

-- AddForeignKey
ALTER TABLE "admin_mfa_recovery_code" ADD CONSTRAINT "admin_mfa_recovery_code_factor_id_fkey" FOREIGN KEY ("factor_id") REFERENCES "admin_mfa_factor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Step 20: append to the migration made by `prisma migrate dev --create-only --name security`.
-- Foreign keys are declared in the Prisma schema (never here); this file holds CHECKs, partial indexes and backfills.

-- Data-rights requests: fixed lists, and each status says what it needs. An export is complete the moment it is made.
ALTER TABLE "privacy_request" ADD CONSTRAINT "privacy_request_check" CHECK (
  "kind" IN ('EXPORT', 'ERASURE')
  AND "subject_type" IN ('STUDENT', 'ACCOUNT')
  AND "capacity" IN ('SELF', 'GUARDIAN')
  AND "status" IN ('PENDING', 'RUNNING', 'CANCELLED', 'COMPLETED', 'FAILED')
  AND ("kind" = 'ERASURE' OR "status" = 'COMPLETED')
  AND ("capacity" = 'SELF' OR "subject_type" = 'STUDENT')
  AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancelled_by_account_id" IS NOT NULL))
  AND (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL))
  AND "attempts" >= 0);
-- At most one erasure waiting or running per subject.
CREATE UNIQUE INDEX "privacy_request_one_open_erasure" ON "privacy_request" ("subject_type", "subject_id")
  WHERE "kind" = 'ERASURE' AND "status" IN ('PENDING', 'RUNNING');

ALTER TABLE "deletion_tombstone" ADD CONSTRAINT "deletion_tombstone_subject_type_check" CHECK ("subject_type" IN ('STUDENT', 'ACCOUNT'));

-- An erased account is closed for good.
ALTER TABLE "account" ADD CONSTRAINT "account_erased_is_closed_check" CHECK ("erased_at" IS NULL OR "status" = 'CLOSED');

-- The authenticator: an active one says when it was confirmed.
ALTER TABLE "admin_mfa_factor" ADD CONSTRAINT "admin_mfa_factor_status_check" CHECK (
  "status" IN ('PENDING', 'ACTIVE') AND (("status" = 'ACTIVE') = ("activated_at" IS NOT NULL)));

-- An erased student's plan ends with the reason ERASED (Step 18's check, with that reason added).
ALTER TABLE "subscription" DROP CONSTRAINT "subscription_check";
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_check" CHECK (
  "source" IN ('BETA', 'ADMIN_GRANT', 'PROVIDER')
  AND "status" IN ('ACTIVE', 'ENDED')
  AND ("source" <> 'BETA' OR "holder_account_id" IS NULL)
  AND (("status" = 'ACTIVE' AND "ended_at" IS NULL AND "ended_reason" IS NULL)
    OR ("status" = 'ENDED' AND "ended_at" IS NOT NULL AND "ended_reason" IS NOT NULL AND "ended_reason" IN ('EXPIRED', 'ADMIN_ENDED', 'REPLACED', 'ERASED')))
  AND ("ends_at" IS NULL OR "ends_at" > "starts_at"));

-- Backfill: the last sign-in of existing accounts is their newest session (before old sessions are deleted).
UPDATE "account" a SET "last_sign_in_at" = s.last
  FROM (SELECT "account_id", max("created_at") AS last FROM "auth_session" GROUP BY "account_id") s
  WHERE s."account_id" = a."id" AND a."last_sign_in_at" IS NULL;
