# Contributing to Hookline

Contributions should improve the accuracy, reproducibility, reliability, or usability of Hookline evidence.

## Before opening a change

- Use chain ID plus normalized contract address as the identity.
- Keep direct observations, deterministic derivations, external metadata, and project claims distinct.
- Never add invented usage, price, balance, volume, partnership, or safety claims.
- Never add transaction submission to the public proxy.
- Preserve prior successful evidence when a refresh fails.
- Avoid background polling and unbounded historical scans.

## Development

```sh
npm ci
node scripts/build-hookline-worker.mjs
node scripts/test-hookline-worker.mjs
node node_modules/wrangler/bin/wrangler.js dev --config wrangler.jsonc
```

Run syntax checks and the Worker test suite before proposing a change:

```sh
node --check dist/app.js
node --check worker/index.js
node scripts/build-hookline-worker.mjs
node scripts/test-hookline-worker.mjs
```

## Issues

A useful issue includes:

- chain ID
- exact contract address when applicable
- observed block or block range
- expected and actual behavior
- minimal reproduction steps
- non-sensitive logs or screenshots

Do not post vulnerabilities, private keys, access tokens, or personal data in a public issue.
