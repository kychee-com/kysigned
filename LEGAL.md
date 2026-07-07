# Legal Notices

This document supplements the [Apache License 2.0](LICENSE) and provides important disclaimers about the use of kysigned.

## What Signatures Prove

A kysigned signature records cryptographic evidence — packaged into a self-contained evidence-bundle PDF delivered to every party — that:

- Someone with send access to a specific email address approved a specific document at a specific time. This proves **mailbox control**, not the identity of the person behind the mailbox. Mailbox compromise is an inherent limitation.

**kysigned does not guarantee:**

- That the person who signed is who they claim to be
- That the signer read or understood the document
- That the signer had legal capacity or authority to sign
- That the signature is legally binding or enforceable in any jurisdiction
- That the signing event satisfies the requirements of any particular law, regulation, or contract

The evidentiary value of a kysigned signature depends on the context, the jurisdiction, and the signing method used.

## Jurisdictional Limitations

Electronic signature laws vary by jurisdiction. In the United States, the ESIGN Act (15 U.S.C. 7001) and the Uniform Electronic Transactions Act (UETA) generally recognize electronic signatures, but with exceptions (see Excluded Document Types below).

**kysigned makes no representation** that its signatures satisfy the legal requirements of any specific jurisdiction. Users are responsible for determining whether electronic signatures are valid and enforceable for their particular use case and jurisdiction.

## Record Permanence

A completed kysigned signature is delivered as a **self-contained evidence-bundle PDF** to every party. That bundle — not any central database or ledger — is the durable record, and it lives wherever its holders keep it. Once delivered:

- The bundle is beyond the operator's reach: there is nothing central to revoke, alter, or take offline — the evidence lives entirely inside the delivered PDF
- The operator (kysigned.com or any forked instance) retains only an **ephemeral working copy** of a document while its envelope is active, and deletes it once the bundle is delivered (a hard cap of 30 days)
- kysigned holds **no signing keys of any kind**, so there is no central signing secret and no central record to expunge

A signer who wants their copy of a bundle deleted must delete it from their own storage; copies already delivered to other parties are outside any single party's control. Users and signers should understand before signing that a delivered bundle is permanent in the hands of whoever received it.

## Operator Responsibility

kysigned is distributed under the Apache License 2.0. Anyone may fork, modify, and deploy their own instance.

**If you deploy your own instance of kysigned, you are the operator.** As the operator, you are solely responsible for:

- Compliance with all applicable privacy laws (GDPR, CCPA, etc.)
- Your own Terms of Service, Privacy Policy, and legal agreements with your users
- Data retention and deletion practices
- Email deliverability and communication with signers
- Any legal obligations arising from the use of your instance

Kychee provides the software as-is. Kychee is not responsible for the actions, omissions, or legal obligations of third-party operators.

## Excluded Document Types

Under the U.S. ESIGN Act and UETA, certain documents **cannot** be executed with electronic signatures, including but not limited to:

- Wills, codicils, and testamentary trusts
- Adoption, divorce, and other family law documents (varies by state)
- Court orders, notices, and official court documents
- Notices of cancellation or termination of utility services
- Notices of default, acceleration, repossession, foreclosure, or eviction related to a primary residence
- Notices of cancellation or termination of health or life insurance benefits
- Product recall notices affecting health or safety
- Documents required to accompany the transportation of hazardous materials

Other jurisdictions may have additional exclusions. **Do not use kysigned for document types that are excluded from electronic signature laws in your jurisdiction.**

## Disclaimer of Warranties and Limitation of Liability

The kysigned software is provided "AS IS" and "AS AVAILABLE" without warranty of any kind. The full warranty disclaimer and limitation of liability are set forth in the [Apache License 2.0](LICENSE), which governs all use of this software. Nothing in this document limits, expands, or modifies the terms of the Apache License 2.0.

To the maximum extent permitted by applicable law, Kychee and its contributors shall not be liable for any direct, indirect, incidental, special, consequential, or exemplary damages arising from the use of this software — including but not limited to damages for loss of data, business interruption, or reliance on any signature or verification result.

## No Legal Advice

Nothing in this document, the kysigned software, or the kysigned website constitutes legal advice. Consult a qualified attorney for questions about the legal validity of electronic signatures in your jurisdiction and use case.

## Contact

For questions about these legal notices: legal@kychee.com
