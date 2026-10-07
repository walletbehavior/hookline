# Security policy

## Reporting

Do not open a public issue for a vulnerability that could expose user data, bypass payment verification, abuse the public proxy, exhaust infrastructure, or alter evidence integrity.

Contact the maintainer privately through the contact method listed on the WalletBehavior GitHub profile and include:

- affected route and version
- impact
- reproduction steps
- proof of concept with secrets removed
- suggested mitigation when available

## Scope

High-priority areas include JSON-RPC validation, method restrictions, upstream URL control, x402 verification and settlement, response-size limits, browser import validation, cross-site scripting, and evidence-provenance integrity.

Hookline does not custody user funds and its public evidence routes do not submit transactions. The HKLN token and third-party venue contracts are outside the Hookline Worker codebase.
