-- CreateTable
CREATE TABLE "subject_release" (
    "id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "tier" VARCHAR(16) NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL,
    "changed_by_account_id" UUID NOT NULL,

    CONSTRAINT "subject_release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_release_event" (
    "id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "from_tier" VARCHAR(16) NOT NULL,
    "to_tier" VARCHAR(16) NOT NULL,
    "readiness_report_id" UUID,
    "approver_account_id" UUID NOT NULL,
    "note" VARCHAR(1000) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_release_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_access" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "tier" VARCHAR(16) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "granted_by_account_id" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_account_id" UUID,

    CONSTRAINT "release_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readiness_policy_version" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "params" JSONB NOT NULL,
    "notes" VARCHAR(1000),
    "signed_off_by_name" VARCHAR(200),
    "signed_off_reference" VARCHAR(200),
    "signed_off_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "readiness_policy_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readiness_report" (
    "id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "highest_tier" VARCHAR(16) NOT NULL,
    "result" JSONB NOT NULL,
    "generated_by_account_id" UUID,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "readiness_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subject_release_curriculum_version_id_grade_id_subject_id_key" ON "subject_release"("curriculum_version_id", "grade_id", "subject_id");

-- CreateIndex
CREATE INDEX "subject_release_event_release_id_at_idx" ON "subject_release_event"("release_id", "at");

-- CreateIndex
CREATE INDEX "release_access_account_id_idx" ON "release_access"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "readiness_policy_version_code_key" ON "readiness_policy_version"("code");

-- CreateIndex
CREATE INDEX "readiness_report_curriculum_version_id_grade_id_subject_id__idx" ON "readiness_report"("curriculum_version_id", "grade_id", "subject_id", "generated_at");

-- AddForeignKey
ALTER TABLE "subject_release_event" ADD CONSTRAINT "subject_release_event_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "subject_release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_release_event" ADD CONSTRAINT "subject_release_event_readiness_report_id_fkey" FOREIGN KEY ("readiness_report_id") REFERENCES "readiness_report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readiness_report" ADD CONSTRAINT "readiness_report_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "readiness_policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
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
