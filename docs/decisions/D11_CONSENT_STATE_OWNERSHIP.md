# D11 — Ownership of consent, age-classification and guardian-verification state

**Status:** PROVISIONAL. This is the builder's recommendation, built on after the Project Manager instructed "lets start building" on 2026-10-11. It needs explicit ratification and an entry in the Decision Register of the specification repository.

**Resolves:** Blocker 2 from PRE-001 (no named owner for consent / age-classification / guardian-verification state).

## Decision

Consent, age-classification and guardian-verification state is owned by **Domain 01 (Identity & Access)** as a named sub-module, **01b Privacy & Consent**. The 21-domain map is unchanged.

| Sub-module                 | Owns                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01a Accounts & Sessions    | `account`, `authentication_identity`, `otp_challenge`, `auth_session`                                                                                                                                    |
| 01b Privacy & Consent      | `age_classification`, `guardian_relationship`, `guardian_verification`, `guardian_authority`, `jurisdiction_policy`, `consent_purpose`, `consent_policy_version`, `consent_record`, `consent_withdrawal` |
| 01c Authorization skeleton | `role`, `permission`, `role_permission`, `resource_scope`, `role_assignment`                                                                                                                             |

`student` is owned by Domain 02 (Student Profile & Enrollment). Block 002 creates only a minimal `student` table so privacy state has something to reference; Domain 02 extends it later. `audit_event` is owned by Domain 20; Block 002 creates the minimal table and only appends to it.

## Why sub-ownership and not a new domain

- `PRIVACY_SECURITY.md` already requires four separate concepts: student identity, login account, guardian relationship, consent authority. The data model already separates them. Only the owner was unnamed.
- A 22nd domain would change the frozen domain map and need an ACR. A sub-module note clarifies ownership without changing the map.
- Separation is enforced in code: `apps/api/src/privacy` never writes `account` or `auth_session`, and `apps/api/src/identity` never writes consent or age state.

## Reversibility

If counsel or the PM later wants a dedicated Privacy & Consent domain, the code boundary above makes the extraction mechanical. Promotion would go through an ACR.

## What this decision does NOT settle

Nothing about the legal thresholds or mandatory verification methods. See `BLOCKER_01_UAE_CHILD_DATA_REGIME.md`, which is still open pending counsel.
