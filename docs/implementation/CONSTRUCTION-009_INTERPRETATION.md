# CONSTRUCTION-009: assessment assembly and execution (Quick 10)

Build Sequence steps 10 (Assessment Blueprint/Assembly) and 11 (Assessment Execution), plus the student web slice to take a test. Spec: `docs/modules/ASSESSMENT_ENGINE.md` in the frozen repository.

## Scope (answered by the PM)
- Assembly + execution + student web pages.
- Quick 10 only, in two modes: **TEST** and **PRACTICE**. Chapter 10/20 and Subject 25 come later.
- Strict serving rule with a development-only switch (below).

## What was built
- **Assembly** (`exam-domain.ts`, pure): a blueprint-driven pick of 10 approved questions. Prefers questions the student has not seen, spreads across chapters then objectives, fills the difficulty mix, and uses a seeded random generator only as the last tie-break. The seed and an assembly report (mix delivered, substitutions, unseen count) are stored with the instance.
- **Locked instance**: the exact question revisions and the shuffled option order are written when the test is created and never change. Every item references an exact `question_revision`.
- **Execution** (`exam.service.ts`): present one question at a time, lock, skip, revisit skipped once, submit, deterministic scoring, full review after submit. Every state-changing call holds a row lock on the session.
- **API** `exam/*`, student web `/tests` and `/tests/[id]`.
- **Events** to the outbox: `assessment.created`, `started`, `answer_locked`, `question_skipped`, `submitted`, `scored` (all `.v1`). Payloads never carry the answer.

## Behaviour that follows the spec
- One question at a time; selection is editable until locked (kept in the page); a locked answer is final; no going back.
- Skipped questions come back once, at the end. The summary shows answered/unanswered with **Review skipped** or **Submit anyway**.
- No correctness and no running score during a test; no countdown. Active response time is captured (client hint, clamped to 15 minutes, beside the server's own elapsed time).
- The client never receives answer keys or explanations before submit. The question endpoint selects only the stem and option text.
- Each lock is idempotent: the same request key returns the same result; a second, different answer is refused (409).
- First lock in a TEST commits the competitive attempt (`committed_at`); the result records `competitive_eligible`.
- Resume window 24 hours (`EXAM_RESUME_HOURS`).
- Scoring needs no AI.

## Decisions to review
1. **Difficulty bands.** The spec's Quick 10 mix is five levels (2/3/3/1/1). The bank has three (EASY/MEDIUM/HARD), so D1+D2 -> EASY (5), D3 -> MEDIUM (3), D4+D5 -> HARD (2). If the bank moves to five levels, change `QUICK10.mix`.
2. **Serving gate.** Production serves only APPROVED questions from an **ACTIVE** curriculum revision (not `ACTIVE_WITH_REVIEW`, not `SUSPENDED`). `EXAM_ALLOW_UNACTIVATED_CURRICULUM=true` lets local testing use the newest non-terminal revision; the API refuses to start with it when `NODE_ENV=production`. `docker-compose.yml` turns it on for local development only.
3. **Who may take a test.** The account's own student, age-classified, and not awaiting guardian consent. Fails closed, same rule as the display name.
4. **PRACTICE** shows that one question's answer and explanation after it is locked, and nothing else. It is never competitive.
5. **Expiry.** After the window, an attempt with at least one locked answer is scored as it stands (unanswered score zero); one with none is void and has no result. Evaluated when next touched, not by a background job.
6. **Instance and session are separate tables** (as in the canonical model). One session per instance for now.
7. **Question objective check.** A question is usable only if its objective path still exists in the curriculum revision being served.
8. **Retry of a skip** is not idempotent: a repeated skip answers 409 and the page just re-asks the server what is current.

## Not done (deliberately)
- Competitive points and leaderboards (step 15) and mastery evidence (step 13): the events are emitted, nothing consumes them yet.
- Chapter-scoped tests, Subject 25, true/false, fill-blank and matching questions.
- "Technical failures excluded/replaced safely" and invalidating an item after the fact (`InvalidateAssessmentItem`).
- Equivalence policies between assessments, family/variant diversity, bank health states, and a separate assembly-run table: the assembly report on the instance stands in for it.
- Choosing a grade, school or chapter: a student sees every served subject.
- No per-student limit on how many tests can be started.

## Known things to check
- The question bank's `question_revision_stem_unique_per_unit` index is on `stem_hash` alone (no unit column), so identical wording cannot exist in two units. It predates this block.

## Verification
Pure rules, the service (against an in-memory stand-in) and the controller have unit tests; deliberate breakages (an answer key leaking, jumping ahead, a TEST revealing answers, no commit, no void) were each caught. Real-database integration tests cover a full TEST, concurrent creates, concurrent locks, skip and revisit, expiry, isolation between students, and the serving gate. They have not been run in the sandbox (no Prisma engine there).
