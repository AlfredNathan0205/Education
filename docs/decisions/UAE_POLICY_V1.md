# UAE jurisdiction policy v1 (from counsel, supplied 2026-10-11)

Source (pointer only): "Legal Memorandum on UAE Age of Majority, Legal Capacity and Guardian Consent Requirements under Federal Decree-Law No. 25 of 2025 (Civil Transactions Law), effective 1 June 2026."
Citations are as supplied by the PM from counsel. The builder has not independently verified them.

Machine-readable form: `apps/api/policy-templates/ae.v1.json`. Load with the policy CLI: `draft AE <file>`, then `review <id> "<reference above>"` (a human attests counsel review), then `activate <id>`.

## Mapping from counsel's wording to codes

| Counsel | Code |
| --- | --- |
| Minor under 18 Gregorian years | `minorAgeThreshold: 18` |
| Guardian consent required under 18 | `guardianConsentAgeThreshold: 18` |
| Verification against an official government ID (Emirates ID, passport, birth certificate) | `GOVERNMENT_ID_DOCUMENT` |
| Verification through an approved digital government identity system | `DIGITAL_GOVERNMENT_IDENTITY` |
| Guardian: ID verified AND relationship confirmed (birth certificate or court order) AND explicit consent | `GUARDIAN_ID_RELATIONSHIP_AND_CONSENT` (one composite code) |
| "Self-declared date of birth is not sufficient" | `SELF_DECLARED` is deliberately absent from the accepted list |

## Consequences the PM must decide on

1. **Activating this policy blocks onboarding at the date-of-birth step.** The web slice records every DOB as `SELF_DECLARED`, which this policy does not accept, so the API returns 422 for every student. No date-of-birth verification flow exists yet. Recommendation: load and review the policy, but do **not** activate until a verification flow is built, or accept that onboarding is closed until then. Before activation, the system stays fail-closed (guardian consent required for everyone).
2. **Guardian verification is conjunctive.** Counsel requires all three elements. The policy model lists alternatives, so one composite code stands for "all three"; the guardian flow, when built, must enforce every element. The model cannot express this structure.
3. **Every ICSE Grade 8 student is a minor under an 18 threshold**, so guardian verification (ID, relationship document, explicit consent) is on the critical path for any student to use the product. This flow handles identity documents and birth certificates: a vendor/storage/retention decision for counsel and security review.
4. **Overlay not modelled.** Counsel notes sector rules (for example a social-media framework under Cabinet Resolution No. 106 of 2026) may set an absolute prohibition below 15 that parental consent cannot override, and require approved age-assurance methods. Not representable in this policy and not implemented. Open question for counsel: does any such overlay apply to an assessment platform? Grade 8 students are typically under 15, so the answer matters.
5. **"Additional robust methods where regulations require"** (document scan with biometric matching, authority-approved methods) are not listed, because counsel did not name a specific one. Add as a new policy version if needed.
