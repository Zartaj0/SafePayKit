# Architecture

SafePayKit separates the payment flow into four concerns:

1. `policy-schema`
   Defines the shared policy, quote, reservation, and receipt shapes.

2. `core`
   Deterministic spend rules:
   - authorize
   - reuse idempotent reservation
   - settle
   - refund
   - trip / reset breaker

3. `vault-service`
   Holds the spend authority, enforces policy, issues short-lived authorization tokens, signs settlement receipts, and persists local runtime state.

4. `x402-client` + provider
   The client handles `402 Payment Required`, obtains authorization from the vault, and retries safely against a paid API provider.

5. `conformance`
   The verifier checks the evidence bundle independently: provider quote
   signature, reservation scope, vault receipt signature, and Solana
   Memo-compatible anchor payload.

## Flow

```mermaid
sequenceDiagram
    participant Agent
    participant API as Paid API
    participant Vault as SafePay Vault

    Agent->>API: POST /api/research
    API-->>Agent: 402 + provider-signed quote
    Agent->>Vault: authorize(quote, runId, idempotencyKey)
    Vault-->>Agent: reservation + auth token
    Agent->>API: retry request + auth token
    API->>Vault: verify token
    Vault-->>API: token valid
    API->>Vault: settle reservation
    Vault-->>API: signed receipt
    API-->>Agent: paid result
```

## Evidence Flow

```mermaid
sequenceDiagram
    participant Verifier
    participant State as SafePay Evidence Bundle

    Verifier->>State: read policy + reservation + quote + receipt
    Verifier->>Verifier: verify provider quote signature
    Verifier->>Verifier: verify quote fingerprint and reservation scope
    Verifier->>Verifier: verify vault receipt signature
    Verifier->>Verifier: derive safepay:v0 Solana Memo anchor
```

## Safety Wedge

The novelty is not “agent payments.” The novelty is safe spend control around retries:

- budget reservation before settlement
- provider-signed quote verification
- idempotent reservation reuse
- recipient / route policy enforcement
- TTL expiry
- signed receipts
- independent receipt evidence verification
- Solana Memo-compatible receipt anchor payloads
- audit log and breaker state
- restart-safe local persistence
