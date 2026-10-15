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
