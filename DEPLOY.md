# Deploying The Demo Dashboard

Hosting is optional for submission. A GitHub repo plus a clear demo video is
usually enough for judges to evaluate the project.

If a hosted URL is useful, SafePayKit now has a single-process hosted demo:

```bash
npm start
```

`npm start` runs the vault, paid API mock, and dashboard in one Node process.
Only the dashboard port is exposed. The vault and paid API remain internal on
localhost.

## Generic Node Host Settings

- Build command: none
- Start command: `npm start`
- Node version: 20 or newer
- Public port: use the platform-provided `PORT`

Optional environment variables:

```text
SAFEPAY_ADMIN_TOKEN=<random string>
SAFEPAY_AGENT_TOKEN=<random string>
SAFEPAY_PROVIDER_TOKEN=<random string>
SAFEPAY_STORE_FILE=/tmp/safepaykit-hosted-demo.json
```

Do not set `DEVNET_PRIVATE_KEY` on a public dashboard host unless you are adding
a live devnet transaction feature. The current dashboard does not need it.

## Local Video Demo

For the safest submission path, record this locally instead of hosting:

```bash
npm run dev
```

Then open `http://127.0.0.1:4300`.
