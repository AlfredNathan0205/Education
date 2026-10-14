-- Step 13: append to the migration made by `prisma migrate dev --create-only --name mastery`.

-- Exactly one ACTIVE mastery policy (Prisma cannot express a partial unique index).
CREATE UNIQUE INDEX "mastery_policy_version_one_active" ON "mastery_policy_version" ("status") WHERE "status" = 'ACTIVE';

-- Weights and counts are never negative; a score is 0 or 1.
ALTER TABLE "mastery_evidence_event" ADD CONSTRAINT "mastery_evidence_event_weight_check" CHECK ("weight" >= 0 AND "weight" <= 1);
ALTER TABLE "mastery_evidence_event" ADD CONSTRAINT "mastery_evidence_event_score_check" CHECK ("score" IN (0, 1));

-- Policy MASTERY_V1: the spec's baseline weights, prior and gates, plus a provisional confidence formula (see
-- CONSTRUCTION-013). Must match MASTERY_V1 in apps/api/src/mastery/mastery-domain.ts.
INSERT INTO "mastery_policy_version" ("id", "code", "status", "params", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000130', 'MASTERY_V1', 'ACTIVE',
   '{"prior":{"alpha":1,"beta":1},"independence":{"distinct":1,"exactRepeat":0.05},"context":{"fullTest":1,"quickTest":0.9,"practice":0.6,"fullTestMinQuestions":20},"quality":{"HEALTHY":1,"NEW":0.9,"WATCH":0.7,"DEGRADED":0.3,"QUARANTINED":0},"weightCap":1,"confidence":{"volumeScale":2.5,"diversityBase":0.6,"diversityPerFamily":0.2,"singleSessionFactor":0.85,"recencyFullDays":30,"recencyFloorDays":180,"recencyFloor":0.8},"gates":{"ordinary":{"confidence":75,"effective":5,"families":2,"sessions":2,"controlled":1},"strong":{"mastery":85,"confidence":85,"effective":6,"families":3,"sessions":2},"weak":{"effective":6,"families":3,"sessions":2}},"bands":{"strong":85,"secure":70,"developing":55},"rollup":{"minReportableShare":0.6,"minReportable":2}}'::jsonb,
   'Seeded by the Step 13 migration. Spec baseline weights/prior/gates; confidence formula provisional; families = distinct questions until the bank has reasoning families.');
