-- Step 16: append to the migration made by `prisma migrate dev --create-only --name social`.

-- At most one friendship that is not ENDED per pair, and the pair is stored in order (low < high, never oneself).
CREATE UNIQUE INDEX "friendship_one_open_per_pair" ON "friendship" ("student_low", "student_high") WHERE "status" <> 'ENDED';
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_pair_order_check" CHECK ("student_low" < "student_high");
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_ended_check" CHECK (("status" = 'ENDED') = ("ended_at" IS NOT NULL));

-- No blocking or reporting oneself; no challenging oneself.
ALTER TABLE "student_block" ADD CONSTRAINT "student_block_not_self_check" CHECK ("blocker_student_id" <> "blocked_student_id");
ALTER TABLE "safety_report" ADD CONSTRAINT "safety_report_not_self_check" CHECK ("reporter_student_id" <> "reported_student_id");
ALTER TABLE "challenge" ADD CONSTRAINT "challenge_not_self_check" CHECK ("challenger_student_id" <> "opponent_student_id");

-- Fixed vocabularies (no free text anywhere in this step).
ALTER TABLE "safety_report" ADD CONSTRAINT "safety_report_reason_check"
  CHECK ("reason" IN ('UNWANTED_CONTACT', 'CHALLENGE_SPAM', 'SUSPECTED_CHEATING', 'MADE_ME_UNCOMFORTABLE', 'OTHER'));
ALTER TABLE "safety_report" ADD CONSTRAINT "safety_report_status_check"
  CHECK (("status" = 'OPEN' AND "resolution" IS NULL) OR ("status" = 'RESOLVED' AND "resolution" IS NOT NULL AND "resolution" IN ('NO_ACTION', 'RESTRICTED')));
ALTER TABLE "friendship_guardian_approval" ADD CONSTRAINT "friendship_guardian_approval_status_check"
  CHECK ("status" IN ('PENDING', 'APPROVED', 'DECLINED') AND (("status" = 'PENDING') = ("decided_at" IS NULL)));
ALTER TABLE "challenge_participant" ADD CONSTRAINT "challenge_participant_role_check" CHECK ("role" IN ('CHALLENGER', 'OPPONENT'));

-- At most one open (PENDING or ACTIVE) challenge between the same two students in a subject, whichever way round.
CREATE UNIQUE INDEX "challenge_one_open_per_pair_subject" ON "challenge"
  (LEAST("challenger_student_id", "opponent_student_id"), GREATEST("challenger_student_id", "opponent_student_id"), "subject_id")
  WHERE "status" IN ('PENDING', 'ACTIVE');

-- Competition policy CP_V2: CP_V1 plus ranked challenges (CHALLENGE10 up to 100 CP; no win bonus, no CP loss).
-- Must match CP_V2 in apps/api/src/competition/competition-domain.ts (a unit test checks).
UPDATE "competitive_scoring_policy" SET "status" = 'RETIRED' WHERE "code" = 'CP_V1' AND "status" = 'ACTIVE';
INSERT INTO "competitive_scoring_policy" ("id", "code", "status", "params", "notes") VALUES
  ('5e3d1000-0000-4000-8000-000000000160', 'CP_V2', 'ACTIVE',
   '{"base":{"QUICK10":100,"FOCUS10":100,"SUBJECT20":200,"SUBJECT25":250,"CHALLENGE10":100},"difficultyWeight":{"EASY":1,"MEDIUM":1.25,"HARD":1.5},"accuracyShare":0.9,"improvementShare":0.1,"minEligibleQuestions":5,"ranking":{"minQualified":2,"minEligibleQuestions":20,"boardSize":10},"xp":{"perAnswer":1,"perFinish":5},"week":{"utcOffsetMinutes":330}}'::jsonb,
   'Seeded by the Step 16 migration: CP_V1 plus ranked challenges. Weights provisional, as CP_V1.');
