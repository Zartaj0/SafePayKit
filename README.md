# SafePayKit

**Open safety rails for retry-safe, policy-controlled x402 / Pay.sh-style agent
API spend on Solana.**

SafePayKit is a reference implementation for one narrow question:

> How can an autonomous agent pay per request without holding raw spend authority,
> overspending during retries, or leaving opaque billing records?

It provides the safety layer around agent-paid API flows: policy checks,
reservation reuse, retry safety, signed quotes, signed receipts, and audit-ready
evidence.

## Why This Exists

- x402 uses HTTP `402 Payment Required` to let APIs request payment and let
  clients retry with payment proof. See [x402 HTTP 402 docs](https://docs.x402.org/core-concepts/http-402).
- Solana documents x402 as an agent-payment flow on Solana. See
  [Solana x402 overview](https://solana.com/x402/what-is-x402).
- Pay.sh documents wallet-approved HTTP 402 requests and sandbox payment flows.
  See [Pay.sh docs](https://pay.sh/docs).

SafePayKit does not replace those rails. It adds the control layer around them:
budget reservation, retry-safe idempotency, allowlists, TTLs, receipts, audit
logs, and evidence verification.

## What Works

- Deterministic policy engine for authorization, reuse, settlement, refunds,
  and breaker logic.
- Vault service that holds the signer instead of the agent.
- x402-style client wrapper for `402 Payment Required` retry flows.
- Paid API mock with provider-signed quotes.
- Dashboard demo with normal, timeout retry, price block, recipient block, route
  block, and breaker scenarios.
- File-backed local persistence for policy, receipts, runs, auth tokens, audit
  logs, and vault signer identity.
- Independent conformance proof for quote signatures, receipt signatures, retry
  reuse, policy blocks, and Solana Memo-compatible receipt anchor payloads.

## Demo

Start the clean presenter demo:

```bash
npm run demo
```

Open `http://127.0.0.1:4300`, then run:

1. `Normal payment`
2. `Timeout retry`
3. `Price drift block`
4. `Breaker trip`

For a short CLI proof you can show on video:

```bash
npm run demo:proof
```

For the full machine-checkable report:

```bash
npm run conformance
```

## Verification

```bash
npm test
npm run verify
npm run conformance
```

Current expected result: all tests pass, `verify` prints two settled receipts
with one retry reuse, and `conformance` prints `"ok": true`.

## Public Docs

- [SPEC.md](SPEC.md): SafePay Spend Control v0 reference semantics.
- [CONFORMANCE.md](CONFORMANCE.md): what the conformance proof checks.
- [DEMO.md](DEMO.md): short presentation flow.
- [ARCHITECTURE.md](ARCHITECTURE.md): component and evidence flow.
- [ADOPTION.md](ADOPTION.md): how wallets, providers, facilitators, and agent
  frameworks can reuse the pieces.
- [DEPLOY.md](DEPLOY.md): optional hosted-dashboard instructions.

## Scope

- Local reference implementation for x402 / Pay.sh-style flows.
- The demo uses a mock paid API provider and vault service.
- Solana Memo-compatible receipt anchors are generated and verified locally.
- Production deployments should replace demo auth, storage, settlement, and
  anchoring adapters.

## Repository Layout

```text
packages/policy-schema    shared policy, quote, receipt, and verifier helpers
packages/core             deterministic spend-control engine
packages/x402-client      safe 402 retry wrapper
packages/vault-service    signer boundary, auth, settlement, persistence
examples/paid-api-server  provider-signed paid API mock
examples/demo-agent       autonomous caller simulation
apps/dashboard            judge-facing local dashboard
scripts/                  demo, conformance, scenario, and verification commands
tests/                    core, e2e, evidence, and persistence tests
```
