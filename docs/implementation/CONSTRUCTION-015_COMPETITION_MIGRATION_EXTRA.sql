-- Step 15: append to the migration made by `prisma migrate dev --create-only --name competition`.

-- Exactly one ACTIVE competition policy (Prisma cannot express a partial unique index).
CREATE UNIQUE INDEX "competitive_scoring_policy_one_active" ON "competitive_scoring_policy" ("status") WHERE "status" = 'ACTIVE';

-- The CP ledger is immutable (spec: corrections are compensating entries). Rows can be added, never changed or
-- deleted. TRUNCATE (test databases only) is not a row operation and is not blocked.
CREATE OR REPLACE FUNCTION "cp_event_is_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cp_event is append-only: add a compensating entry instead of changing or deleting one';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cp_event_no_update_or_delete" BEFORE UPDATE OR DELETE ON "cp_event"
  FOR EACH ROW EXECUTE FUNCTION "cp_event_is_append_only"();

-- An AWARD is positive, a REVERSAL negative, nothing is zero; XP is positive; a qualification's CP is never negative.
ALTER TABLE "cp_event" ADD CONSTRAINT "cp_event_amount_check" CHECK ("amount" <> 0 AND ("kind" <> 'AWARD' OR "amount" > 0) AND ("kind" <> 'REVERSAL' OR "amount" < 0));
ALTER TABLE "xp_event" ADD CONSTRAINT "xp_event_amount_check" CHECK ("amount" > 0);
ALTER TABLE "competitive_qualification" ADD CONSTRAINT "competitive_qualification_cp_check" CHECK ("cp" >= 0 AND ("qualified" OR "cp" = 0));

-- Policy CP_V1: PROVISIONAL weights (see CONSTRUCTION-015). Must match CP_V1 in
-- apps/api/src/competition/competition-domain.ts (a unit test checks).
INSERT INTO "competitive_scoring_policy" ("id", "code", "status", "params", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000150', 'CP_V1', 'ACTIVE',
   '{"base":{"QUICK10":100,"FOCUS10":100,"SUBJECT20":200,"SUBJECT25":250},"difficultyWeight":{"EASY":1,"MEDIUM":1.25,"HARD":1.5},"accuracyShare":0.9,"improvementShare":0.1,"minEligibleQuestions":5,"ranking":{"minQualified":2,"minEligibleQuestions":20,"boardSize":10},"xp":{"perAnswer":1,"perFinish":5},"week":{"utcOffsetMinutes":330}}'::jsonb,
   'Seeded by the Step 15 migration. Spec maxima (100/200/250), ranking minimums and tie order; weights provisional.');
