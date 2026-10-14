-- Fix 13A: option positions are 0..3 everywhere (OPTION_POSITIONS in question-domain.ts).
-- Append to an otherwise EMPTY migration (prisma migrate dev --create-only --name option_positions).
--
-- The constraints are added NOT VALID, so the migration cannot fail on old development rows. Postgres still
-- enforces them on every new or updated row. Each is then validated only if no existing row breaks it, so a
-- clean database (CI, staging, production) ends up with fully validated constraints.

ALTER TABLE "question_option"
  ADD CONSTRAINT "question_option_position_range" CHECK ("position" BETWEEN 0 AND 3) NOT VALID;

ALTER TABLE "assessment_instance_question"
  ADD CONSTRAINT "assessment_instance_question_option_order_range"
  CHECK ("option_order" IS NULL OR ("option_order" <@ ARRAY[0, 1, 2, 3] AND "option_order" @> ARRAY[0, 1, 2, 3] AND cardinality("option_order") = 4)) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "question_option" WHERE "position" NOT BETWEEN 0 AND 3) THEN
    ALTER TABLE "question_option" VALIDATE CONSTRAINT "question_option_position_range";
  ELSE
    RAISE NOTICE 'question_option has rows outside 0..3 (old development data); constraint left NOT VALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "assessment_instance_question"
    WHERE "option_order" IS NOT NULL AND NOT ("option_order" <@ ARRAY[0, 1, 2, 3] AND "option_order" @> ARRAY[0, 1, 2, 3] AND cardinality("option_order") = 4)
  ) THEN
    ALTER TABLE "assessment_instance_question" VALIDATE CONSTRAINT "assessment_instance_question_option_order_range";
  ELSE
    RAISE NOTICE 'assessment_instance_question has old 1..4 option orders (development data); constraint left NOT VALID';
  END IF;
END $$;
