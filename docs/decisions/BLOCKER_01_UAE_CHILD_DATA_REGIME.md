# Blocking Question 1 — Update: UAE Child Data Regime

**Status:** Still BLOCKING for CONSTRUCTION-002 (Identity & Privacy Skeleton). Not resolved — this note narrows the question and adds sourced findings; it does not substitute for legal review.

---

## What changed from the original review

The original PRE-001 review framed this as "which jurisdiction's consent law governs Release 1" and named UAE PDPL as the presumed answer once market order was set (UAE first). That framing was too narrow: **two separate UAE federal laws are in play**, and the more specific one is very recent.

## The two laws

### 1. Federal Decree-Law No. 45 of 2021 — Personal Data Protection Law (PDPL)
General data-protection baseline. In force since 2 January 2022. Establishes consent as the primary lawful basis for processing, requires consent to be provable, clear, and revocable, and grants standard data-subject rights (access, correction, erasure, portability, restriction).

**Open discrepancy — do not treat either claim as settled:** secondary sources disagree on whether PDPL itself specifies a child age threshold — one summary states it requires parental consent for processing data of children under 16; another states plainly that PDPL outlines no specific child protections or age threshold at all. This needs resolving against the actual statutory text (Arabic-authoritative), not secondary blog summaries, before it drives any schema decision.

### 2. Federal Decree-Law No. 26 of 2025 — Child Digital Safety
A dedicated child-specific law, sourced directly from the UAE's official legislation portal (uaelegislation.gov.ae, legislation ID 3912):
- **Issued:** 1 Oct 2025. **Effective:** 1 Jan 2026 (already in force as of this note).
- **Defines "Child"** as any person who has not completed 18 Gregorian years — notably broader than the commonly-cited "under 16" figure for PDPL.
- Contains a dedicated **Article 7 — Protection of Privacy and Personal Data** and **Article 8 — Age Verification**, plus obligations covering parental control tools, age-appropriate content restrictions, children's-personal-data-protection features, and reporting channels.

**Because every Exam App user in the launch cohort (ICSE Grade 8) is under 18, this law — not the general PDPL — is very likely the primary regime the identity/privacy skeleton needs to satisfy, with PDPL's general consent/rights machinery operating underneath it.** This is a strong working hypothesis from official-source metadata, not a confirmed legal conclusion — see caveats below.

## What is NOT yet verified
- The full operative text of both laws (only a portal index page and secondary summaries have been reviewed; the official portal itself states the Arabic text prevails over any English translation in case of conflict).
- Exact mechanics required for Article 8 age verification (self-declared DOB vs. document-based vs. guardian-linked verification — materially different build effort).
- Exact parental-consent mechanics required under either law for a specific product like Exam App (school-distributed access may interact differently with guardian consent than direct-to-consumer signup).
- Interaction with the India DPDP Act once India launches second, and whether the architecture needs to be region-configurable from day one or can be UAE-first with India added later without rework.

## Recommendation
Get an actual legal read (UAE-qualified privacy counsel, not secondary sources) on Federal Decree-Law 26/2025 Articles 7–8 and PDPL's child provisions specifically, before CONSTRUCTION-002 finalizes the consent/age-classification data model and API contracts. This is a genuine legal-compliance gate, not an engineering estimate either of us should make.

## What CONSTRUCTION-002 can safely provision for now, regardless of exact legal answer
These look robust to the outcome of legal review, since both plausible readings need them in some form:
- An explicit, versioned **age-classification** step at registration (not bolted on later).
- A **guardian/parent relationship** entity distinct from the student account (already in the Canonical Data Model — `guardian_relationship`, `guardian_verification`).
- A **consent record** that is purpose-specific, versioned, and revocable (already an invariant — "Consent is purpose-specific/versioned").
- Room in the data model for an **age-verification method** field (self-declared vs. document-based vs. guardian-linked) — build the column, don't hard-code the method, since Article 8's exact verification bar hasn't been confirmed yet.

What should still wait: any decision on *which* verification method is mandatory, and any UI/UX flow that assumes a specific consent mechanic, since that's exactly the part that depends on the legal read.
