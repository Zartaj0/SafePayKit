# SafePay Spend Control v0

This is the public-goods surface of SafePayKit: a small set of interoperable
semantics for safe autonomous spend.

It is not a settlement rail. It defines how an agent, vault, and provider can
agree on quote, reservation, retry, and receipt behavior without giving the
agent raw spend authority.

## Roles

- `agent`: autonomous caller that wants to access a paid API.
- `provider`: API merchant that issues signed quotes and delivers the paid result.
- `vault`: policy boundary that authorizes spend, holds the signer, and produces receipts.

## Quote

A provider-issued quote is the input to authorization.

Required fields:

- `quoteId`
- `domain`
- `route`
- `resource`
- `recipient`
- `tokenMint`
- `amountMinor`
- `issuedAt`
- `expiresAt`
- `providerId`
- `providerPublicKey`
- `providerSignature`

The provider signs the canonical quote payload with Ed25519. The signed payload
binds the provider to the quote identity, route, resource, recipient, token,
amount, issue time, expiry, provider id, and metadata.

The vault must reject a quote when:

- the provider signature is missing
- the provider public key is not allowlisted by policy
- the signature does not verify
- the quote is expired
- the domain, route, recipient, token, or amount violates policy

## Reservation

A reservation is the vault's spend hold before settlement.

Reservation identity is scoped by:

```text
policyId + agentId + runId + idempotencyKey
```

The vault must reuse the existing reservation for the same scoped idempotency
key when the quote fingerprint matches. The quote fingerprint intentionally
binds spend-critical fields while ignoring ephemeral quote identity and expiry:

- `domain`
- `route`
- `resource`
- `recipient`
- `tokenMint`
- `amountMinor`

This lets a retry reuse the same logical spend when a provider reissues an
equivalent quote with a different `quoteId` or expiry.

## Budget Accounting

Policy checks must include both settled spend and open reservations.

The vault must count open reservations against:

- per-run budget
- daily budget
- velocity limit

This prevents agents from overcommitting budget through many unsettled requests.

## Authorization Token

The vault issues a short-lived authorization token after policy approval.

The provider must verify the token with the vault before settlement. In this
reference implementation the token is opaque and server-side; production
adapters can replace it with a signed claim as long as it remains bound to the
reservation and quote fingerprint.

## Receipt

Settlement produces a vault-signed receipt.

Required receipt fields:

- `receiptId`
- `reservationId`
- `providerReceiptId`
- `runId`
- `agentId`
- `amountMinor`
- `settledAt`
- `vaultSignature`
- `vaultPublicKey`

The receipt proves that the vault settled a specific reservation for a bounded
amount at a specific time.

## Receipt Evidence Bundle

SafePayKit treats the proof as a bundle, not a standalone log line.

A verifier should be able to check:

- the receipt exists
- the reservation exists
- the receipt matches the reservation, run, and agent
- the settled amount is within the reserved amount
- the reservation quote fingerprint is stable
- the provider quote signature verifies against the policy allowlist
- the vault receipt signature verifies against the receipt payload
- any anchor hash or memo matches the receipt evidence

This is what makes the project useful as public goods: another wallet,
provider, facilitator, or agent framework can copy the same checks without
copying the demo service.

## Solana Memo Anchor Payload

The reference implementation can derive a deterministic anchor payload:

```text
standard = safepay-receipt-anchor-v0
memo = safepay:v0:<sha256(anchor-payload)>
```

The payload binds:

- receipt id
- reservation id
- run id
- agent id
- provider id
- provider receipt id
- amount
- token mint
- quote fingerprint
- vault public key
- vault signature
- settlement time

The conformance command prepares and verifies this payload locally. The
`demo:devnet` command submits the memo to Solana devnet.

## Minimum Conformance

A compatible implementation should provide:

- provider-signed quotes
- policy-bound authorization
- scoped idempotency reuse
- open-reservation budget accounting
- TTL expiry
- single settlement per reservation
- signed receipts
- receipt evidence verification
- deterministic Solana Memo-compatible anchor payloads
- auditable blocked-attempt reasons

## Why This Is Public Goods

If every wallet, facilitator, and provider invents these rules privately, agent
commerce fragments around incompatible retry and receipt semantics. This spec is
the smallest shared surface SafePayKit proposes for safe autonomous spend.
