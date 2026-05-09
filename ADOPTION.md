# Adoption Notes

SafePayKit is meant to be copied or embedded. The useful artifact is the spend
control behavior, not this exact demo service.

## Wallets

Wallets can embed the policy engine to keep agent-specific limits outside the
agent runtime.

Useful pieces:

- policy schema
- scoped idempotency key rules
- open-reservation accounting
- signed receipt verification
- conformance checks for safe agent-spend defaults

## API Providers

Providers can issue signed quotes and verify vault authorizations before serving
paid results.

Useful pieces:

- provider-signed quote format
- quote fingerprinting
- reservation-bound settlement
- receipt fields for customer support and dispute trails
- receipt evidence bundles for support and audit workflows

## Facilitators

Facilitators can use SafePay semantics as the policy layer around the payment
rail.

Useful pieces:

- quote validation rules
- retry-safe authorization reuse
- breaker and anomaly behavior
- receipt verification and anchoring interface

## Agent Frameworks

Agent frameworks can use the client wrapper pattern so agents request paid
resources without holding raw spend authority.

Useful pieces:

- `402` retry wrapper
- idempotency key propagation
- vault authorization flow
- clear blocked-attempt errors
- reusable conformance command for integration tests

## What To Replace For Production

- Replace shared-secret auth with real identity and authorization.
- Replace file persistence with SQLite, Postgres, or another durable store.
- Replace mock settlement with a USDC/facilitator adapter.
- Anchor receipt hashes on Solana if the deployment needs public auditability.
- Add policy approval workflows for high-value or unusual quotes.
