# Legal — the operator's responsibility

kysigned (this repository) is **software**, released under the Apache License 2.0. It ships with **no legal documents**, and Kychee, Inc. provides none for your deployment.

If you deploy and operate a kysigned instance as a service for other people, **you alone are responsible for every legal document that governs your service and your users.** Kychee is not your lawyer and gives no legal advice. Consult qualified counsel in your jurisdiction before going live.

## Legal documents an operator typically needs

A non-exhaustive starting checklist — your counsel will tailor it to your business, jurisdiction, and customers:

- **Terms of Service** — the contract between you and your users.
- **Privacy Policy** — what personal data you collect, why, how long you keep it, and your users' rights (GDPR / CCPA / etc.).
- **Cookie & Consent Notice** — the cookies and analytics your site uses, and how consent is obtained.
- **Data Processing Agreement (DPA)** — required when you process personal data on behalf of business customers under GDPR and similar laws.
- **Acceptable Use Policy** — what users may and may not do with your service.
- **Electronic-signature disclosures** — your consent-to-transact-electronically notice, and the document types that are excluded from electronic signing in the jurisdictions you serve (wills, codicils, notarial deeds, and more). Electronic-signature law (US ESIGN/UETA, EU eIDAS, and others) varies widely; note that a kysigned signature is a Simple/Advanced Electronic Signature, never a Qualified Electronic Signature (QES).

How a kysigned signature actually works — what it proves and what it does not — is documented in [`docs/trust-model.md`](docs/trust-model.md). Your legal documents should describe the service accurately on that basis.

## Write your agreements back-to-back with run402

A kysigned instance runs entirely on **run402** (https://run402.com) — the underlying infrastructure for compute, database, email, and storage. **You cannot promise your users more than run402 promises you.**

Draft your commitments — uptime / SLA, data durability and deletion, security, sub-processor disclosures, liability — **back-to-back** with run402's terms: pass run402's obligations and limitations through to your own agreements rather than guaranteeing beyond them, so you are never left exposed in the gap between what you promise your customers and what the platform provides you. Review run402's terms, DPA, and sub-processor list before making any commitment that depends on the platform.

---

*This file is operator guidance — not legal advice, and not a template. Kychee's own hosted service (kysigned.com) runs legal documents specific to Kychee, Inc.; they are intentionally not included in this repository and are not for your use.*
