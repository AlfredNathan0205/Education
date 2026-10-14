-- Step 14, migration 2 of 2: the WHOLE content of an otherwise empty migration made by
-- `prisma migrate dev --create-only --name recommendation_blueprints`.
--
-- Why a separate migration: the first one adds the enum value OBJECTIVES to blueprint_scope_mode, and Postgres refuses
-- to use a new enum value in the same transaction that added it ("unsafe use of new value"). A migration file sent as
-- one script runs as one transaction, so these rows come one migration later (checked on Postgres 16: in one
-- transaction it fails; split, both succeed).
--
-- PRACTICE10 and RETEST10: ten questions on the objectives a recommendation targets, widening one ring at a time
-- (micro-concept, topic, chapter) when they hold too few. Unseen questions first. The 4/4/2 split is PROVISIONAL.
-- Both are switched on and published so recommendations work at once; neither is ever offered as an ordinary test.

INSERT INTO "assessment_blueprint" ("id", "code", "name", "description", "enabled", "updated_at") VALUES
  ('5e3d1000-0000-4000-8000-000000000030', 'PRACTICE10', 'Practice (10)', 'Ten practice questions on the objectives a recommendation targets. Answers are shown after each one.', true, CURRENT_TIMESTAMP),
  ('5e3d1000-0000-4000-8000-000000000040', 'RETEST10', 'Retest (10)', 'A ten-question test on the objectives just practised, preferring questions not seen before.', true, CURRENT_TIMESTAMP);

INSERT INTO "assessment_blueprint_version"
  ("id", "blueprint_id", "version", "status", "total_questions", "scope_mode", "scope_strict", "prefer_unseen", "opening_difficulty", "notes", "published_at") VALUES
  ('5e3d1000-0000-4000-8000-000000000230', '5e3d1000-0000-4000-8000-000000000030', 1, 'PUBLISHED', 10, 'OBJECTIVES', false, true, 'EASY',
   'Seeded by the Step 14 migration. 4/4/2 is provisional.', CURRENT_TIMESTAMP),
  ('5e3d1000-0000-4000-8000-000000000240', '5e3d1000-0000-4000-8000-000000000040', 1, 'PUBLISHED', 10, 'OBJECTIVES', false, true, 'EASY',
   'Seeded by the Step 14 migration. 4/4/2 is provisional.', CURRENT_TIMESTAMP);

INSERT INTO "blueprint_difficulty_requirement" ("id", "version_id", "difficulty", "count") VALUES
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000230', 'EASY', 4),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000230', 'MEDIUM', 4),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000230', 'HARD', 2),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000240', 'EASY', 4),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000240', 'MEDIUM', 4),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000240', 'HARD', 2);

INSERT INTO "blueprint_type_requirement" ("id", "version_id", "question_type", "count") VALUES
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000230', 'MCQ', 10),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000240', 'MCQ', 10);
