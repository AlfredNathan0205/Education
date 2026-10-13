# Step 6: coverage and generation demand (measurement part)

## Built
- `coverage report <curriculum> <grade> <subject> <targetPerCell> [top]`: read-only operator report. No schema change, no migration.
- Cell = learning objective x difficulty. Counts approved (same rule the exam engine serves), queued (draft, in review,
  changes required), retired. Gaps are listed per objective and are never hidden by chapter rollups.
- Provisional Generation Need Score using the spec baseline weights (depth .30, diversity .25, exposure .15,
  quality attrition .10, test demand .10, curriculum priority .10). Components without data are left out and
  their weight shared over the rest (the spec says this for the Coverage Health Score; applying it to the need score is
  my assumption). Exposure and demand are normalised against the busiest cell, which is my choice, not the spec's.
- Suggested request size per cell = min(20, target - approved - queued). The spec limits (20 per cell per cycle, 50 per day,
  yield breaker 30%, duplicate saturation 40%, two repairs) are constants for the generator to enforce later.
- Only aggregate exposure counts are read; no student is identifiable.

## Not built, and why
- Cognitive level and question type: questions do not store them. Adding them is a question-model change (Step 7).
- Diversity, reasoning/scenario families, duplicate detection: Question Bank step.
- Curriculum priority P0-P6: the scheme is not defined in the repository. Needs your definition.
- Empirical calibration: needs real student answers.
- Persisted coverage snapshots, Coverage Health Score, in-flight reservation, kill switches and budgets: arrive with the AI Question Factory.
- The target per cell is yours to choose; no default is built in.

## Operator steps (Claude Code)
Nothing to migrate. After the build: run the report against the sample data and check it matches what the question bank shows.
