-- CreateEnum
CREATE TYPE "friendship_status" AS ENUM ('PENDING_GUARDIAN', 'ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "challenge_status" AS ENUM ('PENDING', 'ACTIVE', 'DECLINED', 'EXPIRED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "friend_code" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "used_by_student_id" UUID,

    CONSTRAINT "friend_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friend_code_attempt" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friend_code_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friendship" (
    "id" UUID NOT NULL,
    "student_low" UUID NOT NULL,
    "student_high" UUID NOT NULL,
    "status" "friendship_status" NOT NULL,
    "code_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "ended_reason" VARCHAR(24),
    "ended_by_student_id" UUID,

    CONSTRAINT "friendship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friendship_guardian_approval" (
    "id" UUID NOT NULL,
    "friendship_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendship_guardian_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_block" (
    "id" UUID NOT NULL,
    "blocker_student_id" UUID NOT NULL,
    "blocked_student_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_report" (
    "id" UUID NOT NULL,
    "reporter_student_id" UUID NOT NULL,
    "reported_student_id" UUID NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "friendship_id" UUID,
    "challenge_id" UUID,
    "status" VARCHAR(16) NOT NULL,
    "resolution" VARCHAR(16),
    "resolved_by_account_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_restriction" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "report_id" UUID,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMP(3),

    CONSTRAINT "social_restriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge" (
    "id" UUID NOT NULL,
    "challenger_student_id" UUID NOT NULL,
    "opponent_student_id" UUID NOT NULL,
    "friendship_id" UUID NOT NULL,
    "curriculum_version_id" UUID NOT NULL,
    "grade_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "subject_version_id" UUID NOT NULL,
    "status" "challenge_status" NOT NULL,
    "items" JSONB NOT NULL,
    "assembly_report" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "responded_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_participant" (
    "id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "role" VARCHAR(12) NOT NULL,
    "session_id" UUID,

    CONSTRAINT "challenge_participant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "friend_code_code_key" ON "friend_code"("code");

-- CreateIndex
CREATE INDEX "friend_code_student_id_created_at_idx" ON "friend_code"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "friend_code_attempt_student_id_at_idx" ON "friend_code_attempt"("student_id", "at");

-- CreateIndex
CREATE INDEX "friendship_student_low_idx" ON "friendship"("student_low");

-- CreateIndex
CREATE INDEX "friendship_student_high_idx" ON "friendship"("student_high");

-- CreateIndex
CREATE INDEX "friendship_guardian_approval_student_id_status_idx" ON "friendship_guardian_approval"("student_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "friendship_guardian_approval_friendship_id_student_id_key" ON "friendship_guardian_approval"("friendship_id", "student_id");

-- CreateIndex
CREATE INDEX "student_block_blocked_student_id_idx" ON "student_block"("blocked_student_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_block_blocker_student_id_blocked_student_id_key" ON "student_block"("blocker_student_id", "blocked_student_id");

-- CreateIndex
CREATE INDEX "safety_report_status_created_at_idx" ON "safety_report"("status", "created_at");

-- CreateIndex
CREATE INDEX "safety_report_reported_student_id_idx" ON "safety_report"("reported_student_id");

-- CreateIndex
CREATE INDEX "social_restriction_student_id_idx" ON "social_restriction"("student_id");

-- CreateIndex
CREATE INDEX "challenge_challenger_student_id_created_at_idx" ON "challenge"("challenger_student_id", "created_at");

-- CreateIndex
CREATE INDEX "challenge_opponent_student_id_status_idx" ON "challenge"("opponent_student_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_participant_session_id_key" ON "challenge_participant"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_participant_challenge_id_student_id_key" ON "challenge_participant"("challenge_id", "student_id");

-- AddForeignKey
ALTER TABLE "friendship_guardian_approval" ADD CONSTRAINT "friendship_guardian_approval_friendship_id_fkey" FOREIGN KEY ("friendship_id") REFERENCES "friendship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_participant" ADD CONSTRAINT "challenge_participant_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
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
