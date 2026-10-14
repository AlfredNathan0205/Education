-- Step 12: the whole of the `student_web` migration (made with `prisma migrate dev --create-only --name student_web`,
-- which is empty because Step 12 changes no tables). Seeds FOCUS10: the diagnostic-balanced first test on the
-- student's chosen chapters (spec STUDENT_WEB: "First experience uses subject + studied chapter"). Same numbers as
-- Quick 10 (5/3/2, open with EASY); loose scope, so a student with too few questions in their chapters still gets
-- a test, and the assembly run records the widening. Published and switched on, as agreed with the PM.
INSERT INTO "assessment_blueprint" ("id", "code", "name", "description", "enabled", "updated_at") VALUES
  ('5e3d1000-0000-4000-8000-000000000011', 'FOCUS10', 'Focus 10',
   'Ten questions from the chapters you chose: 5 easy, 3 medium, 2 hard. Uses the whole subject when your chapters have too few questions.',
   true, CURRENT_TIMESTAMP);

INSERT INTO "assessment_blueprint_version"
  ("id", "blueprint_id", "version", "status", "total_questions", "scope_mode", "scope_strict", "prefer_unseen", "opening_difficulty", "notes", "published_at") VALUES
  ('5e3d1000-0000-4000-8000-000000000111', '5e3d1000-0000-4000-8000-000000000011', 1, 'PUBLISHED', 10, 'STUDENT_FOCUS', false, true, 'EASY',
   'Seeded by the Step 12 migration: the first test on the chapters the student chose.', CURRENT_TIMESTAMP);

INSERT INTO "blueprint_difficulty_requirement" ("id", "version_id", "difficulty", "count") VALUES
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000111', 'EASY', 5),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000111', 'MEDIUM', 3),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000111', 'HARD', 2);

INSERT INTO "blueprint_type_requirement" ("id", "version_id", "question_type", "count") VALUES
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000111', 'MCQ', 10);
