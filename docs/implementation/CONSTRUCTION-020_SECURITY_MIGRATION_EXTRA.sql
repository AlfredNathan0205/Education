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
