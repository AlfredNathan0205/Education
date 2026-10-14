-- Step 10: append to the migration made by `prisma migrate dev --create-only --name blueprint_assembly`.

-- At most one PUBLISHED and one DRAFT version per blueprint (Prisma cannot express partial unique indexes).
CREATE UNIQUE INDEX "assessment_blueprint_version_one_published" ON "assessment_blueprint_version" ("blueprint_id") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "assessment_blueprint_version_one_draft" ON "assessment_blueprint_version" ("blueprint_id") WHERE "status" = 'DRAFT';

-- Counts are never negative; a cell asks for at least one question; a version has at least one question.
ALTER TABLE "assessment_blueprint_version" ADD CONSTRAINT "assessment_blueprint_version_total_check" CHECK ("total_questions" BETWEEN 1 AND 50);
ALTER TABLE "blueprint_difficulty_requirement" ADD CONSTRAINT "blueprint_difficulty_requirement_count_check" CHECK ("count" >= 0);
ALTER TABLE "blueprint_type_requirement" ADD CONSTRAINT "blueprint_type_requirement_count_check" CHECK ("count" >= 0);
ALTER TABLE "blueprint_cell_requirement" ADD CONSTRAINT "blueprint_cell_requirement_min_count_check" CHECK ("min_count" >= 1);

-- Seed designs. QUICK10 v1 is the Quick 10 that was built in code before Step 10 (5/3/2, whole subject, open with EASY),
-- published and switched on so students see no change. SUBJECT20 v1 is a DRAFT, switched off: its 8/7/5 split is a guess
-- (spec D1-D5 = 3/5/6/4/2 grouped as D1+D2, D3, D4+D5 = 8/6/6, one moved to MEDIUM) to be confirmed. SUBJECT25 has no
-- version and is off: the spec allows it only when content readiness permits.
INSERT INTO "assessment_blueprint" ("id", "code", "name", "description", "enabled", "updated_at") VALUES
  ('5e3d1000-0000-4000-8000-000000000010', 'QUICK10', 'Quick 10', 'Ten questions from the whole subject: 5 easy, 3 medium, 2 hard.', true, CURRENT_TIMESTAMP),
  ('5e3d1000-0000-4000-8000-000000000020', 'SUBJECT20', 'Subject test (20)', 'Twenty questions from the whole subject. The difficulty split is a guess to confirm before publishing.', false, CURRENT_TIMESTAMP),
  ('5e3d1000-0000-4000-8000-000000000025', 'SUBJECT25', 'Subject test (25)', 'Off until content readiness permits (spec). No version yet.', false, CURRENT_TIMESTAMP);

INSERT INTO "assessment_blueprint_version"
  ("id", "blueprint_id", "version", "status", "total_questions", "scope_mode", "scope_strict", "prefer_unseen", "opening_difficulty", "notes", "published_at") VALUES
  ('5e3d1000-0000-4000-8000-000000000110', '5e3d1000-0000-4000-8000-000000000010', 1, 'PUBLISHED', 10, 'WHOLE_SUBJECT', false, true, 'EASY',
   'Seeded by the Step 10 migration: the Quick 10 previously built in code.', CURRENT_TIMESTAMP),
  ('5e3d1000-0000-4000-8000-000000000120', '5e3d1000-0000-4000-8000-000000000020', 1, 'DRAFT', 20, 'WHOLE_SUBJECT', false, true, 'EASY',
   'GUESS to confirm: spec D1-D5 3/5/6/4/2 mapped to three levels as 8/7/5.', NULL);

INSERT INTO "blueprint_difficulty_requirement" ("id", "version_id", "difficulty", "count") VALUES
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000110', 'EASY', 5),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000110', 'MEDIUM', 3),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000110', 'HARD', 2),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000120', 'EASY', 8),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000120', 'MEDIUM', 7),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000120', 'HARD', 5);

INSERT INTO "blueprint_type_requirement" ("id", "version_id", "question_type", "count") VALUES
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000110', 'MCQ', 10),
  (gen_random_uuid(), '5e3d1000-0000-4000-8000-000000000120', 'MCQ', 20);
