# Demo

## Presenter Flow

```bash
npm run demo
```

Open `http://127.0.0.1:4300`. The script starts the vault, paid API, and
dashboard, then seeds a clean policy with the provider quote key.

Run these dashboard scenarios:

1. `Normal payment`: provider-signed quote, vault authorization, signed receipt.
2. `Timeout retry`: same idempotency key, one reservation, one settlement.
3. `Price drift block`: unsafe quote blocked before settlement.
4. `Breaker trip`: repeated anomalies trip the breaker.

Then show the short terminal proof:

```bash
npm run demo:proof
```

## Talk Track

Opening:

> SafePayKit is not the payment rail. It is the open safety layer around
> x402 / Pay.sh-style agent spend.

Key lines:

- The agent never holds the spending key.
- The provider signs the quote; the vault verifies it against policy.
- Retry safety is scoped by policy, agent, run, and idempotency key.
- Open reservations count against budgets before settlement.
- Receipts are signed and independently verifiable.
- The Solana Memo payload is prepared and verified locally; this demo does not
  submit an onchain transaction.

Closing:

> If agent payments grow on Solana, builders need shared safety semantics, not
> another gateway clone.
