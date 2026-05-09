# Conformance

```bash
npm run conformance
```

This command starts an isolated local vault and paid API provider, runs the
critical flows, and prints a JSON report with `"ok": true` when the reference
semantics hold.

It checks:

- admin endpoints require auth
- provider quote key is allowlisted
- normal payment settles once
- timeout retry reuses one reservation
- unsafe price is blocked before settlement
- provider quote signatures verify
- vault receipt signatures verify
- receipt evidence matches reservation state
- Solana Memo-compatible receipt anchor payloads are deterministic

Scope: this is local conformance for `SafePay Spend Control v0`. It prepares and
verifies `safepay:v0:<hash>` Memo payloads, but does not submit live Solana
transactions by default.
