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
