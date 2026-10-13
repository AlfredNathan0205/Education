# Step 5 completion: school plan mapping and chapter selection

## Built
- `school_academic_plan` (school + curriculum + grade + academic year; DRAFT or PUBLISHED), `school_plan_entry`
  (term label, optional assessment label, subject code, chapter code), `student_chapter_selection`.
- No universal Term 1 / Term 2 mapping. Labels are the school's own words, never interpreted.
- Chapter codes are validated against the newest curriculum subject version of each subject, using the same
  served-states rule as the exam engine (ACTIVE only; dev switch `EXAM_ALLOW_UNACTIVATED_CURRICULUM`).
- Operator CLI: `schools plan chapters|create|add|remove|publish|reopen|show|list`. Every change is audited with the operator.
- Student API `GET/PUT students/me/chapters`; web page `/profile/chapters`. Fail-closed through
  `studentIdForDataCollection` (needs classification and, if required, valid guardian consent). Needs a grade first.
- A published plan for the student's selected registry school is shown as a suggestion. It never selects anything,
  never limits choices, and is not shown for a free-text (candidate) school.

## Not done, on purpose
- The selection is not yet used by test assembly. Wiring it in changes what students are tested on; decide first.
- Real plan content must come from schools. None was invented.
- Needs a decision from the owner / counsel: how a school is VERIFIED or SCHOOL_CONFIRMED; school reporting
  authority (NO_ACCESS ... MANAGED_ACCOUNT); ending access on leave; an "independent / no school" option;
  per-student jurisdiction.

## Operator steps (Claude Code)
1. Apply the patch; the migration `guardian_school` (already planned) must also include these tables:
   run `prisma migrate dev --name guardian_school` once with the whole schema.
2. Integration tests: 2 new tests in "School plans and chapter selection constraints".
3. Hand test: `plan chapters ICSE GRADE_8`, create/add/publish a plan for a school, then sign in as a student
   who chose that school and open /profile/chapters.
