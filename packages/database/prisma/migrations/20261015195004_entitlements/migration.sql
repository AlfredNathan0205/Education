-- CreateTable
CREATE TABLE "entitlement" (
    "key" VARCHAR(32) NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "values" JSONB NOT NULL,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "holder_account_id" UUID,
    "source" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "ended_reason" VARCHAR(24),
    "created_by_account_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_event" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "actor_account_id" UUID,
    "reason" VARCHAR(300),
    "details" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_grant" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "entitlement_key" VARCHAR(32) NOT NULL,
    "value" JSONB NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "granted_by_account_id" UUID NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_account_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_code_key" ON "plan"("code");

-- CreateIndex
CREATE INDEX "subscription_student_id_status_idx" ON "subscription"("student_id", "status");

-- CreateIndex
CREATE INDEX "subscription_status_ends_at_idx" ON "subscription"("status", "ends_at");

-- CreateIndex
CREATE INDEX "subscription_event_subscription_id_at_idx" ON "subscription_event"("subscription_id", "at");

-- CreateIndex
CREATE INDEX "entitlement_grant_student_id_idx" ON "entitlement_grant"("student_id");

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Step 18: append to the migration made by `prisma migrate dev --create-only --name entitlements`.

-- Exactly one default plan (Prisma cannot express a partial unique index); statuses and sources are fixed lists.
CREATE UNIQUE INDEX "plan_one_default" ON "plan" ("is_default") WHERE "is_default";
ALTER TABLE "plan" ADD CONSTRAINT "plan_status_check" CHECK ("status" IN ('ACTIVE', 'RETIRED') AND (NOT "is_default" OR "status" = 'ACTIVE'));
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_kind_check" CHECK ("kind" IN ('LIMIT', 'BOOLEAN'));

-- A subscription: its source and status; the system's beta grant has no holder; an ended one says when and why;
-- a period ends after it starts. At most one active beta plan per student.
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_check" CHECK (
  "source" IN ('BETA', 'ADMIN_GRANT', 'PROVIDER')
  AND "status" IN ('ACTIVE', 'ENDED')
  AND ("source" <> 'BETA' OR "holder_account_id" IS NULL)
  AND (("status" = 'ACTIVE' AND "ended_at" IS NULL AND "ended_reason" IS NULL)
    OR ("status" = 'ENDED' AND "ended_at" IS NOT NULL AND "ended_reason" IS NOT NULL AND "ended_reason" IN ('EXPIRED', 'ADMIN_ENDED', 'REPLACED')))
  AND ("ends_at" IS NULL OR "ends_at" > "starts_at"));
CREATE UNIQUE INDEX "subscription_one_active_beta" ON "subscription" ("student_id") WHERE "status" = 'ACTIVE' AND "source" = 'BETA';

-- The subscription history is append-only.
CREATE OR REPLACE FUNCTION "subscription_event_is_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subscription_event is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "subscription_event_no_update_or_delete" BEFORE UPDATE OR DELETE ON "subscription_event"
  FOR EACH ROW EXECUTE FUNCTION "subscription_event_is_append_only"();
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_type_check" CHECK ("type" IN ('CREATED', 'EXTENDED', 'ENDED', 'EXPIRED'));

-- A single-entitlement grant names a real entitlement, has a period, and once revoked says by whom.
ALTER TABLE "entitlement_grant" ADD CONSTRAINT "entitlement_grant_key_fkey" FOREIGN KEY ("entitlement_key") REFERENCES "entitlement"("key");
ALTER TABLE "entitlement_grant" ADD CONSTRAINT "entitlement_grant_check" CHECK (
  "ends_at" > "starts_at" AND (("revoked_at" IS NULL) = ("revoked_by_account_id" IS NULL)));

-- The catalogue and the plans. Values must match FREE_VALUES / UNLIMITED_VALUES in
-- apps/api/src/entitlement/entitlement-domain.ts (a unit test checks). The FREE limits are PROVISIONAL
-- (see CONSTRUCTION-018). No prices: pricing comes after the beta (spec D09).
INSERT INTO "entitlement" ("key", "kind", "description") VALUES
  ('SELF_TESTS_PER_DAY', 'LIMIT', 'Tests and practice sets a student may start themselves each day (recommended practice, retests and challenges are never limited).'),
  ('LONG_TESTS', 'BOOLEAN', 'Tests of 20 questions or more (Subject 20 and 25).'),
  ('PARENT_REPORT_WEEKS', 'LIMIT', 'How many weeks of weekly reports a parent may open.');
INSERT INTO "plan" ("id", "code", "name", "status", "is_default", "values", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000180', 'FREE', 'Free', 'ACTIVE', TRUE,
   '{"SELF_TESTS_PER_DAY":3,"LONG_TESTS":false,"PARENT_REPORT_WEEKS":4}'::jsonb,
   'Seeded by the Step 18 migration. Every student has it. The complete core loop is never limited. Limits provisional.'),
  ('5e3d1000-0000-4000-8000-000000000181', 'BETA', 'Beta', 'ACTIVE', FALSE,
   '{"SELF_TESTS_PER_DAY":null,"LONG_TESTS":true,"PARENT_REPORT_WEEKS":null}'::jsonb,
   'Granted automatically to every student while BETA_GRANT_UNTIL is set. Everything included.'),
  ('5e3d1000-0000-4000-8000-000000000182', 'PLUS', 'Plus', 'ACTIVE', FALSE,
   '{"SELF_TESTS_PER_DAY":null,"LONG_TESTS":true,"PARENT_REPORT_WEEKS":null}'::jsonb,
   'The paid plan to come. Not on sale: no price and no payment provider yet. Administrators may grant it.');
