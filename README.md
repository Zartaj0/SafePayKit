# SafePayKit

**Open safety rails for retry-safe, policy-controlled x402 / Pay.sh-style agent
API spend on Solana.**

## Status

SafePayKit is a concept/reference prototype. It is not currently used in
production, it was not submitted to a hackathon, and it should not be treated as
a live payments product. The repository is kept public as an implementation
sketch for agent-spend safety semantics: policy checks, retry-safe reservations,
signed receipts, audit logs, and optional Solana devnet proof.

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
- Product console with an editable live agent request form plus normal, timeout
  retry, price block, recipient block, route block, and breaker checks.
- File-backed local persistence for policy, receipts, runs, auth tokens, audit
  logs, and vault signer identity.
- Independent conformance proof for quote signatures, receipt signatures, retry
  reuse, policy blocks, and Solana Memo-compatible receipt anchor payloads.
- Real devnet settlement command that pays a separate merchant address and
  includes the receipt anchor memo in the Solana transaction.

## Run Locally

Start the local product console:

```bash
npm run demo
```

Open the dashboard URL printed by the command. The top panel is editable: change
route, price, recipient, run ID, idempotency key, or timeout behavior, then click
`Send Live Request`.

Useful live edits:

- Set price to `125` and recipient to `merchant_demo_main` to approve and settle.
- Set price to `900` to block above the per-request limit.
- Set recipient to `merchant_rogue_sink` to block recipient drift.
- Check timeout to prove the retry reuses the same reservation.

Click `Run Full Sweep` only when you want the full scripted control sweep.

The button runs:

1. normal paid API call
2. timeout retry with reservation reuse
3. price drift block before settlement
4. breaker trip after repeated unsafe attempts

The live trace, metrics, receipt list, blocked attempts, and breaker panel update
after each request.

For a short CLI proof:

```bash
npm run demo:proof
```

For real devnet settlement using `DEVNET_PRIVATE_KEY` from `.env`:

```bash
npm run demo:real
```

This approves one safe paid API call, proves one unsafe quote is blocked before
settlement, sends a real Solana devnet transfer to a separate merchant address
with `safepay:v0:<hash>` in the memo, and prints the explorer URL.

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

## Scope

- Local reference implementation for x402 / Pay.sh-style flows.
- The local console uses a mock paid API provider and vault service.
- `npm run demo:real` submits a real Solana devnet transfer with the receipt
  anchor memo.
- Production deployments should replace local auth, storage, and settlement
  adapters.

## Repository Layout

```text
packages/policy-schema    shared policy, quote, receipt, and verifier helpers
packages/core             deterministic spend-control engine
packages/x402-client      safe 402 retry wrapper
packages/vault-service    signer boundary, auth, settlement, persistence
examples/paid-api-server  provider-signed paid API mock
examples/demo-agent       autonomous caller simulation
apps/dashboard            local product console
scripts/                  local run, conformance, scenario, and verification commands
tests/                    core, e2e, evidence, and persistence tests
```
