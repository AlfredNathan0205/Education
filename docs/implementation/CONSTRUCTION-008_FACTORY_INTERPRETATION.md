# Step 8: AI Question Factory (mock provider first)

The whole pipeline is built and runs end to end against a **mock provider**. A real model is added later by writing one class
that implements `AiProvider` (`apps/api/src/factory/ai-provider.ts`) and naming it in `createAiProvider`. Nothing else changes.

## What it does
Coverage need (Step 6, operator picks the cell) -> generation request -> generator -> deterministic checks (Step 7) -> exact-duplicate
check -> blind answer solver + six validators + adversarial reviewer, run separately -> confidence and route (Step 7 weights and
thresholds) -> up to two repairs for repairable weakness -> stored as a **DRAFT** for a person.

- **Nothing is ever approved, published or activated by the factory.** The spec allows auto-approval only under a trust policy,
  and none exists. Every draft goes through the normal path: a person submits, a different person approves and confirms the key.
- Drafts enter as origin `AI_DRAFT` with `ai_source = "factory batch <id>; provider/model"`, so they can be quarantined as a
  batch (Step 7) and are shown to reviewers as AI drafts, with route, confidence, repairs and the validators' reasons.
- GREEN is stored; YELLOW is repaired (max 2) then stored flagged; AMBER is stored flagged; RED is rejected (kept in the batch record,
  not in the bank); incomplete evidence stores nothing.
- Every model call goes through one gateway: daily token budget (checked before each call), timeout, shape check, and a record in
  `ai_call_log` (role, provider, model, prompt/schema version, input and output hashes, latency, status, tokens). Text is not logged.
- Limits from the spec: at most 20 candidates per cell per run; 50 per cell per day (provisional, refused up front); yield breaker
  (< 30% usable) and duplicate-saturation breaker (> 40%) stop the batch; kill switch `FACTORY_ENABLED`; budget required.
- Operator commands: `factory run | suggest | batches | show | stop` (see README).

## Mock provider
Its questions say `[MOCK]` and are meaningless as teaching content. `MOCK_AI_FAULTS` makes every Nth candidate misbehave
(wrong key, weak explanation, repeat, unusable reply) so each route can be seen. Refused when `NODE_ENV=production`.

## Assumptions to confirm
1. The breakers only start judging after **10** attempts (`BREAKER_MIN_ATTEMPTS`). The spec gives the percentages, not a minimum sample.
2. "Repairable" = no critical gate, something below GREEN, and every weak dimension is explanation, distractors, readability or
   cognitive/difficulty fit. A wrong answer, off-curriculum or ambiguous question is not repaired, it is rejected. Novelty alone never blocks a repair.
3. Novelty is a simple word-overlap measure and is advisory (the spec says similarity alone never rejects). Exact repeats of existing
   wording are rejected.
4. One blind solver pass by default (`FACTORY_SOLVER_PASSES`, 1 to 3). More passes cost more and expose solver disagreement.
5. What C1 to C4 and EASY/MEDIUM/HARD mean is **not in this repository**. `prompts.ts` has empty definitions and tells the model "not
   supplied". Real generation quality is capped until the owners write them.
6. Prompts are first drafts (`PROMPT_VERSION p1`). They need testing against a real model and your reviewers' findings.
7. The daily cap counts attempts in a UTC day for the cell. Token cost per candidate with a real model is unknown until measured.

## Not built (needs people, a real model, or later steps)
- A real provider and its key; a decision on provider, model and budget.
- Second-opinion model escalation, audit sampling and H1/H2 human review lanes (nothing is auto-approved, so sampling has nothing to sample yet).
- Automatic scheduling of batches (the operator starts each one), per-provider cost in currency, prompt A/B comparison.
- The meaning of AMBER/YELLOW overlap and difficulty D1-D5 remain as noted in Step 7.
