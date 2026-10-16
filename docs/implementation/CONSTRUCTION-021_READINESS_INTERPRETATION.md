# Step 21: Content readiness and release tiers

Spec sources:
- `BUILD_SEQUENCE.md` 21: content readiness.
- `DECISION_10.md`:
  - 10O: "Strict EQC/diversity/QC/LO gates; unavailable if not ready";
  - 10P: Alpha of ~10–30 controlled users;
  - 10Q: Private Beta of ~100–300 genuine ICSE Grade 8 students, invite-only.
- `MASTER_SPEC.md`: feature activation `FOUNDATION_ONLY → INTERNAL → CONTROLLED → GENERAL`; "code readiness never bypasses academic/privacy/safety/operational readiness"; use EQC, diversity and quality, not raw count.
- `INVARIANTS_AND_POLICIES.md`, the coverage and diversity baseline:
  - EQC weights by variant level;
  - objective tiers A min 12/target 20+, B min 8/target 12+, C min 5/target 8+;
  - chapter launch minimum ~120;
  - "readiness also requires LO/diversity/QC/audit conditions";
  - quality target: major+critical below 1%.
- `STATE_MACHINES.md`: LO readiness `NOT_READY → LIMITED → ASSESSMENT_READY → ROBUST`.

**PM decisions (16 October):**
- **Subjects:** all four (Physics, Chemistry, Biology, Maths), each gated on its own.
- **Thresholds:** provisional now, as a versioned policy, signed off by an academic lead.
- **Not ready means hidden:** students see "Coming soon".
- **Release:** promotion needs a passing report plus a named approver, audited.

## Built
- **Release tiers per subject** (curriculum version × grade × subject). They are kept across curriculum correction revisions.

  | Tier | Who sees it |
  |---|---|
  | FOUNDATION_ONLY | nobody (also the default when no release has been made) |
  | INTERNAL | accounts given internal access (staff and the alpha) |
  | CONTROLLED | internal and controlled access (the beta) |
  | GENERAL | everyone in the cohort |

  The exam service checks the tier everywhere a subject reaches a student:
  - the subject list on Home and Test (otherwise "Coming soon");
  - starting a test, practice or retest;
  - starting a ranked challenge, where both players must be able to see the subject;
  - the subjects a parent or guardian sees, which are the child's.
- **Early access:** an account is given INTERNAL or CONTROLLED access, one live grant at a time.
  - **Who gives it:** a super administrator on the readiness page, by email, with a reason. For the beta there is a bulk CLI: one email per line.
  - **Removing it:** it can be removed, and every change is audited.
  - **Erasure:** a person's access is deleted when they are erased (added to Step 20's erasure map; the schema test caught the new table).
- **A readiness policy, versioned:** READINESS_V1 is seeded **PROVISIONAL**, and exactly one policy is active.
  - **Changing it:** an operator publishes a new version from a JSON file. It is validated, and a wider audience can never ask for less.
  - **Sign-off:** an academic lead's sign-off is recorded by name and with a reference to their written approval.
  - **Effect of signing off:** INTERNAL can be released on a provisional policy; CONTROLLED and GENERAL need a signed-off policy.
- **A readiness check** of a subject, on demand from the admin page or the CLI. It uses **exactly what students would be served**: approved, published, not degraded, on an objective in the served curriculum revision.
  - This fixes a gap found while building: the Step 6 coverage report counts every approved question, published or not.
  - Each check is kept as a report.
  - It is evaluated for each tier, cumulatively (a tier passes only if every lower tier does too).
  - It lists every failing check in plain words, naming the chapters and difficulties that are short.

  What it checks:
  - **The curriculum** is ACTIVE.
  - **Objectives:** each gets a state from its distinct servable questions: NOT_READY (under 5), LIMITED (5+), ASSESSMENT_READY (8+), ROBUST (12+). Each tier requires shares of objectives in those states. From CONTROLLED up, no objective may be NOT_READY, so a rollup cannot hide a gap.
  - **Chapters:** a minimum size, a minimum of each difficulty, and a minimum number of cognitive levels.
  - **Quality:** quarantined plus degraded questions, as a share of approved plus quarantined.
  - **Test designs:** every switched-on whole-subject or chapter design (Quick 10, Focus 10, and Subject 20 once enabled) must be buildable several times over in each difficulty.
- **Release changes,** made only by an approver, with a sign-off note of at least 10 characters.
  - **Promotions** go one tier at a time, on a report that is under 24 hours old, for the current revision, from the active policy, and passing that tier.
  - **Demotions,** to any lower tier, need no report: taking a subject away never waits for paperwork.
  - **The history** is append-only, citing the report and the approver. Changes are audited, sent through the outbox, and safe against two approvers acting at once.
- **The admin page** at `/admin/readiness` (MFA applies):
  - the policy and its sign-off status;
  - each subject's tier and its latest check, with a warning when a subject is released further than its latest check supports;
  - "Check readiness now", with the report: each tier's checks, a chapter table, and the objectives with the fewest questions;
  - release and move-back buttons with the note, and the history;
  - early-access management.
- **CLI** (`node dist/release/cli/readiness.js`): `policy`, `policy publish`, `policy sign-off`, `report <curriculum> <grade> <subject>`, and `access <INTERNAL|CONTROLLED> <emails.txt> "<reason>"`.
- **New kill switch:** `RELEASE_GATING_ENABLED=false` makes every served subject visible again. It is for local development with data from before this step, and is refused in production.

## READINESS_V1 numbers (PROVISIONAL)

| Requirement | INTERNAL (alpha) | CONTROLLED (beta) | GENERAL | Source |
|---|---|---|---|---|
| Objective states (distinct questions) | LIMITED 5, READY 8, ROBUST 12 | same | same | spec tier C min 5, tier B min 8 / target 12; **every objective treated as tier B** |
| Objectives at least LIMITED | 50% | 100% | 100% | proposed |
| Objectives at least ASSESSMENT_READY | not checked | 80% | 100% | proposed |
| Objectives ROBUST | not checked | not checked | 50% | proposed |
| Questions per chapter | 10 | 60 | 120 | GENERAL: spec launch minimum; others proposed |
| Per difficulty per chapter | 1 | 5 | 15 | proposed |
| Cognitive levels per chapter | 1 | 2 | 3 | proposed |
| Quarantined + degraded share, at most | 5% | 2% | 1% | GENERAL: spec quality target; others proposed |
| Each design's mix, times over | 2× | 5× | 10× | proposed |

For a sense of scale (arithmetic, not a forecast): a subject of 10 chapters needs at least 1,200 servable questions for GENERAL, and about 600 for the beta.

## Assumptions and open decisions (please confirm)
1. **Academic lead: the numbers above.** Everything not marked "spec" is my proposal. I chose INTERNAL low enough to let an alpha start on a partial bank, and CONTROLLED high enough that mastery labels can actually appear: about 7 or more distinct questions per objective are needed for a reportable label, from Step 13's arithmetic. The lead can publish a corrected version before signing off.
2. **EQC is an upper bound.**
   - **Duplicates:** exact duplicates count 0, as in the spec.
   - **Variant levels** (surface, parameter, scenario, reasoning) are not recorded on questions yet, so every other question counts 1. The real EQC can only be lower.
   - **To fix it:** recording variants when questions are authored would make it exact, but that needs a change to the question upload format and to review. Decide whether that comes before the beta.
3. **Every objective is tier B.** Objectives carry no A/B/C tier yet, so tier A objectives (min 12) are under-checked and tier C ones over-checked. Adding a tier to the curriculum upload is a curriculum-format change.
4. **Not built:** the spec's QC also includes post-approval audit sampling (20% of the first 1,000 questions, and so on). Quality is judged only from quarantine and DEGRADED health.
5. **Releases do not move by themselves.** If quality drops after a release, the page warns ("released further than its latest check supports"), but nothing demotes automatically. Should it?
6. **Found while building, not fixed here:**
   - `ACTIVE_WITH_REVIEW` subjects disappear from students in production (only `ACTIVE` is served).
   - Publishing is blocked while a newer draft correction revision exists.
   - Curriculum activation has no admin page or API route (tests and seeds only). Before the alpha, someone has to activate the four subjects by a supported route, so this needs a small step of its own.
7. **People, not code:** the content itself. Authoring, AI generation, review and publication of roughly 600 (beta) to 1,200 (general) questions per subject is the real work of this stage. The Chemistry gap in HARD questions found earlier would fail CHAPTER_DIFFICULTY from INTERNAL up.

## Not built
- Variant levels and objective tiers (decisions 2 and 3).
- Audit sampling.
- Automatic demotion.
- A curriculum activation route (decision 6).
- Per-school or per-cohort releases.
- A student-facing "beta" label.

## Migration
One migration, `readiness`: Prisma's DDL plus `CONSTRUCTION-021_READINESS_MIGRATION_EXTRA.sql`.
- **New tables:** `subject_release`, `subject_release_event`, `release_access`, `readiness_policy_version` and `readiness_report`.
- **Foreign keys** (in the schema): release events → release and report; report → policy.

The extra SQL adds:
- the tier lists;
- the event rules: two different tiers and a note;
- the append-only history trigger;
- an audience is INTERNAL or CONTROLLED with a reason, and one live grant per account;
- exactly one active policy, sign-off name and reference together, and params as an object;
- the report checks;
- the READINESS_V1 seed (a unit test checks that it matches the code).

**On a database with subjects already open to students** (not production, which has none), every subject becomes FOUNDATION_ONLY. Release them through the page, or set `RELEASE_GATING_ENABLED=false` locally.

## Checks done here
- **Unit tests: 77 suites, 1183 tests** (Step 20 had 74 and 1145). They cover:
  - **Who sees what:** every tier × audience, and the switch.
  - **Release changes:** one step, fresh, same subject and current revision, active policy, passing, signed off for CONTROLLED and GENERAL, approver only, demotion without a report.
  - **Readiness:**
    - the seed matches the code;
    - spec numbers are kept, and invalid or less-strict policies are refused;
    - objective states;
    - thin, internal-only, beta, full and cumulative cases;
    - duplicates counting once;
    - chapters named when short of a difficulty or cognitive levels;
    - quality, and design depth;
    - no nulls in the stored result.
  - **The services, against an in-memory store:**
    - audiences: super administrators only, the person must exist, replacing, revoking, audited, and the operator path;
    - releases, history and audit;
    - stale, failing and wrong-revision reports;
    - sign-off required for the beta;
    - demotion;
    - the subject list warning;
    - policy sign-off and publishing.
  - **Step 20's erasure map** now covers the new tables.
- **Browser tests: 58 of 58 pass** (29 × phone and desktop). The new ones:
  - an approver (after the authenticator) checks Physics, sees it ready for internal testing, releases it with a note, sees the history, and the beta button stays disabled;
  - Chemistry shows exactly what is missing;
  - early access given and removed;
  - a student refused.
- **The schema validates.** The extra SQL ran on a throwaway Postgres 16: the seed, one active policy, the sign-off pair, params as an object, the tier lists, the event rules, append-only on update and delete, one live grant, and re-granting after a revoke.
- **Not run here:** the migration and the 2 new real-database integration tests:
  - a thin bank fails, students are not offered it, and it cannot be released;
  - released to internal testers only, then the beta after sign-off, then taken back, with the history and audit.
