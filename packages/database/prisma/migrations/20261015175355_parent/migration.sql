-- CreateTable
CREATE TABLE "claim_policy_version" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "params" JSONB NOT NULL,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_policy_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_report" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "week_start" TIMESTAMP(3) NOT NULL,
    "week_end" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_report_version" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "claim_policy_version_id" UUID NOT NULL,
    "mastery_policy_version_id" UUID NOT NULL,
    "reason" VARCHAR(24) NOT NULL,
    "content" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_report_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_claim" (
    "id" UUID NOT NULL,
    "report_version_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "subject_id" UUID NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "label" VARCHAR(24) NOT NULL,
    "from_label" VARCHAR(24),
    "template_code" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressed_claim" (
    "id" UUID NOT NULL,
    "report_version_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "subject_id" UUID NOT NULL,
    "objective_path" VARCHAR(300) NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppressed_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parent_share_invitation" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "email_normalized" VARCHAR(320) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "consent_record_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "accepted_by_account_id" UUID,

    CONSTRAINT "parent_share_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parent_view_grant" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "viewer_account_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "consent_record_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "ended_by_account_id" UUID,
    "ended_reason" VARCHAR(24),

    CONSTRAINT "parent_view_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claim_policy_version_code_key" ON "claim_policy_version"("code");

-- CreateIndex
CREATE INDEX "student_report_student_id_week_start_idx" ON "student_report"("student_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "student_report_student_id_week_start_key" ON "student_report"("student_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "student_report_version_report_id_version_key" ON "student_report_version"("report_id", "version");

-- CreateIndex
CREATE INDEX "report_claim_report_version_id_idx" ON "report_claim"("report_version_id");

-- CreateIndex
CREATE INDEX "suppressed_claim_report_version_id_idx" ON "suppressed_claim"("report_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "parent_share_invitation_token_hash_key" ON "parent_share_invitation"("token_hash");

-- CreateIndex
CREATE INDEX "parent_share_invitation_student_id_created_at_idx" ON "parent_share_invitation"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "parent_share_invitation_email_normalized_created_at_idx" ON "parent_share_invitation"("email_normalized", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "parent_view_grant_invitation_id_key" ON "parent_view_grant"("invitation_id");

-- CreateIndex
CREATE UNIQUE INDEX "parent_view_grant_consent_record_id_key" ON "parent_view_grant"("consent_record_id");

-- CreateIndex
CREATE INDEX "parent_view_grant_viewer_account_id_idx" ON "parent_view_grant"("viewer_account_id");

-- CreateIndex
CREATE INDEX "parent_view_grant_student_id_idx" ON "parent_view_grant"("student_id");

-- AddForeignKey
ALTER TABLE "student_report_version" ADD CONSTRAINT "student_report_version_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "student_report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_report_version" ADD CONSTRAINT "student_report_version_claim_policy_version_id_fkey" FOREIGN KEY ("claim_policy_version_id") REFERENCES "claim_policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_claim" ADD CONSTRAINT "report_claim_report_version_id_fkey" FOREIGN KEY ("report_version_id") REFERENCES "student_report_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressed_claim" ADD CONSTRAINT "suppressed_claim_report_version_id_fkey" FOREIGN KEY ("report_version_id") REFERENCES "student_report_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Step 17: append to the migration made by `prisma migrate dev --create-only --name parent`.

-- Exactly one ACTIVE claim policy (Prisma cannot express a partial unique index).
CREATE UNIQUE INDEX "claim_policy_version_one_active" ON "claim_policy_version" ("status") WHERE "status" = 'ACTIVE';
ALTER TABLE "claim_policy_version" ADD CONSTRAINT "claim_policy_version_status_check" CHECK ("status" IN ('ACTIVE', 'RETIRED'));

-- Reports: a week is exactly 7 days; versions count from 1; the reason is one of two.
ALTER TABLE "student_report" ADD CONSTRAINT "student_report_week_check" CHECK ("week_end" = "week_start" + INTERVAL '7 days');
ALTER TABLE "student_report_version" ADD CONSTRAINT "student_report_version_check" CHECK ("version" >= 1 AND "reason" IN ('WEEK_ENDED', 'EVIDENCE_CHANGED'));

-- A frozen report is never edited: corrections add a new version. Rows can be added, never changed.
-- (DELETE stays possible so a future erasure saga can remove a student's reports; see CONSTRUCTION-017.)
CREATE OR REPLACE FUNCTION "report_is_frozen"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is frozen: add a new report version instead of changing one', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "student_report_version_no_update" BEFORE UPDATE ON "student_report_version" FOR EACH ROW EXECUTE FUNCTION "report_is_frozen"();
CREATE TRIGGER "report_claim_no_update" BEFORE UPDATE ON "report_claim" FOR EACH ROW EXECUTE FUNCTION "report_is_frozen"();
CREATE TRIGGER "suppressed_claim_no_update" BEFORE UPDATE ON "suppressed_claim" FOR EACH ROW EXECUTE FUNCTION "report_is_frozen"();

-- Fixed vocabularies: claim kinds, the labels a claim may carry, and refusal reasons. (IS NOT NULL is spelled out:
-- a NULL makes an IN (...) test unknown, and a CHECK lets unknown through.)
ALTER TABLE "report_claim" ADD CONSTRAINT "report_claim_kind_check" CHECK (
  ("kind" = 'STRENGTH' AND "label" = 'STRONG' AND "from_label" IS NULL)
  OR ("kind" = 'FOCUS' AND "label" = 'NEEDS_ATTENTION' AND "from_label" IS NULL)
  OR ("kind" = 'IMPROVEMENT' AND "label" IN ('DEVELOPING', 'SECURE', 'STRONG') AND "from_label" IS NOT NULL AND "from_label" IN ('NEEDS_ATTENTION', 'DEVELOPING', 'SECURE')));
ALTER TABLE "suppressed_claim" ADD CONSTRAINT "suppressed_claim_check" CHECK (
  "kind" IN ('STRENGTH', 'FOCUS', 'IMPROVEMENT')
  AND "reason" IN ('STRONG_GATE_NOT_MET', 'WEAK_GATE_NOT_MET', 'NO_EARLIER_CLAIM', 'TREND_GATE_NOT_MET', 'OVER_LIMIT'));

-- Sharing (adult students only, checked in code): statuses, and an ended grant says when and why.
ALTER TABLE "parent_share_invitation" ADD CONSTRAINT "parent_share_invitation_status_check" CHECK (
  "status" IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED')
  AND (("status" = 'PENDING') = ("resolved_at" IS NULL))
  AND (("status" = 'ACCEPTED') = ("accepted_by_account_id" IS NOT NULL)));
ALTER TABLE "parent_view_grant" ADD CONSTRAINT "parent_view_grant_end_check" CHECK (
  ("ended_at" IS NULL AND "ended_reason" IS NULL AND "ended_by_account_id" IS NULL)
  OR ("ended_at" IS NOT NULL AND "ended_reason" IN ('STUDENT_STOPPED', 'VIEWER_LEFT') AND "ended_by_account_id" IS NOT NULL));
-- At most one open grant per student and viewer, and one pending invitation per student.
CREATE UNIQUE INDEX "parent_view_grant_one_open" ON "parent_view_grant" ("student_id", "viewer_account_id") WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "parent_share_invitation_one_pending" ON "parent_share_invitation" ("student_id") WHERE "status" = 'PENDING';
-- A viewer is never the student themselves (their own account): enforced in code; the token hash is unique (Prisma).

-- Policy CLAIM_V1: PROVISIONAL limits and wording (see CONSTRUCTION-017). Must match CLAIM_V1 in
-- apps/api/src/parent/parent-domain.ts (a unit test checks).
INSERT INTO "claim_policy_version" ("id", "code", "status", "params", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000170', 'CLAIM_V1', 'ACTIVE',
   '{"limits":{"strengths":5,"focus":3,"improvements":5},"improvement":{"minPeriodSessions":1},"templates":{"STRENGTH":"STRENGTH_V1","FOCUS":"FOCUS_V1","IMPROVEMENT":"IMPROVEMENT_V1"},"week":{"utcOffsetMinutes":330}}'::jsonb,
   'Seeded by the Step 17 migration. Strength = STRONG label; focus = NEEDS_ATTENTION label; improvement = gated band rise with evidence in the period. Limits and wording provisional.');

-- Consent purpose for an adult student sharing their summary, with DRAFT wording (refused in production until
-- counsel-reviewed wording is added under a new reference and published as a new version).
INSERT INTO "consent_purpose" ("id", "code", "description") VALUES
  ('5e3d1000-0000-4000-8000-000000000171', 'PARENT_REPORT_SHARING', 'An adult student shares their progress summary with a parent they invite.')
  ON CONFLICT ("code") DO NOTHING;
INSERT INTO "consent_policy_version" ("id", "consent_purpose_id", "version", "text_reference", "effective_from")
  SELECT '5e3d1000-0000-4000-8000-000000000172', p."id", 1, 'consent-text:PARENT_REPORT_SHARING:v1-draft', NOW()
  FROM "consent_purpose" p WHERE p."code" = 'PARENT_REPORT_SHARING'
  AND NOT EXISTS (SELECT 1 FROM "consent_policy_version" v WHERE v."consent_purpose_id" = p."id");
