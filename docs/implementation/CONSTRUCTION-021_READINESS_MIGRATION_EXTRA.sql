-- Step 21: append to the migration made by `prisma migrate dev --create-only --name readiness`.
-- Foreign keys are declared in the Prisma schema (never here); this file holds CHECKs, partial indexes, a trigger and a seed.

-- Release tiers are a fixed list. An event moves between two different tiers.
ALTER TABLE "subject_release" ADD CONSTRAINT "subject_release_tier_check" CHECK ("tier" IN ('FOUNDATION_ONLY', 'INTERNAL', 'CONTROLLED', 'GENERAL'));
ALTER TABLE "subject_release_event" ADD CONSTRAINT "subject_release_event_check" CHECK (
  "from_tier" IN ('FOUNDATION_ONLY', 'INTERNAL', 'CONTROLLED', 'GENERAL')
  AND "to_tier" IN ('FOUNDATION_ONLY', 'INTERNAL', 'CONTROLLED', 'GENERAL')
  AND "from_tier" <> "to_tier"
  AND length(btrim("note")) >= 10);

-- The release history is append-only.
CREATE OR REPLACE FUNCTION "subject_release_event_is_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subject_release_event is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "subject_release_event_no_update_or_delete" BEFORE UPDATE OR DELETE ON "subject_release_event"
  FOR EACH ROW EXECUTE FUNCTION "subject_release_event_is_append_only"();

-- An audience is INTERNAL or CONTROLLED, with a reason; one live grant per account.
ALTER TABLE "release_access" ADD CONSTRAINT "release_access_check" CHECK (
  "tier" IN ('INTERNAL', 'CONTROLLED') AND length(btrim("reason")) >= 5);
CREATE UNIQUE INDEX "release_access_one_live" ON "release_access" ("account_id") WHERE "revoked_at" IS NULL;

-- Readiness policies: exactly one ACTIVE; a sign-off names the academic lead and a reference, together.
ALTER TABLE "readiness_policy_version" ADD CONSTRAINT "readiness_policy_version_check" CHECK (
  "status" IN ('ACTIVE', 'RETIRED')
  AND jsonb_typeof("params") = 'object'
  AND (("signed_off_at" IS NULL) = ("signed_off_by_name" IS NULL))
  AND (("signed_off_at" IS NULL) = ("signed_off_reference" IS NULL)));
CREATE UNIQUE INDEX "readiness_policy_version_one_active" ON "readiness_policy_version" ("status") WHERE "status" = 'ACTIVE';

-- A report's highest tier is a tier; its result is an object.
ALTER TABLE "readiness_report" ADD CONSTRAINT "readiness_report_check" CHECK (
  "highest_tier" IN ('FOUNDATION_ONLY', 'INTERNAL', 'CONTROLLED', 'GENERAL') AND jsonb_typeof("result") = 'object');

-- READINESS_V1, PROVISIONAL (not signed off). Must match READINESS_V1 in apps/api/src/release/readiness-domain.ts
-- (a unit test checks). An academic lead signs it off with `readiness policy sign-off`, or publishes a corrected version.
INSERT INTO "readiness_policy_version" ("id", "code", "status", "params", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000210', 'READINESS_V1', 'ACTIVE',
   '{"objective":{"limited":5,"assessmentReady":8,"robust":12},"tiers":{"INTERNAL":{"objectivesLimitedShare":0.5,"objectivesReadyShare":0,"objectivesRobustShare":0,"chapterMin":10,"chapterMinPerDifficulty":1,"chapterMinCognitive":1,"maxQualityIssueShare":0.05,"designDepth":2},"CONTROLLED":{"objectivesLimitedShare":1,"objectivesReadyShare":0.8,"objectivesRobustShare":0,"chapterMin":60,"chapterMinPerDifficulty":5,"chapterMinCognitive":2,"maxQualityIssueShare":0.02,"designDepth":5},"GENERAL":{"objectivesLimitedShare":1,"objectivesReadyShare":1,"objectivesRobustShare":0.5,"chapterMin":120,"chapterMinPerDifficulty":15,"chapterMinCognitive":3,"maxQualityIssueShare":0.01,"designDepth":10}}}'::jsonb,
   'Seeded by the Step 21 migration. PROVISIONAL: objective thresholds from the spec (tier C min 5, tier B min 8, target 12; every objective treated as tier B); GENERAL chapter minimum 120 and quality 1% from the spec; all other numbers proposed for academic sign-off.');
