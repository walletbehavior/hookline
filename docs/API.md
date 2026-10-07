# Hookline API reference

Base URL: `https://hookline.world`

## Hookline methods

All Hookline RPC requests use JSON-RPC 2.0 and require an `id` and array-valued `params`.

### `hookline_chains`

Returns supported chain IDs, names, upstream identifiers, and transaction-submission capability.

```json
{"jsonrpc":"2.0","method":"hookline_chains","params":[],"id":1}
```

### `hookline_decodePermissions`

Decodes the low 14 bits of a 20-byte address into canonical Uniswap v4 hook permission flags.

```json
{"jsonrpc":"2.0","method":"hookline_decodePermissions","params":["0x0000000000000000000000000000000000003fff"],"id":2}
```

### `hookline_chainStatus`

Returns current chain identity, latest block, latency, upstream, and status for a supported numeric chain ID.

```json
{"jsonrpc":"2.0","method":"hookline_chainStatus","params":[8453],"id":3}
```

### `hookline_getHook`

Returns live contract evidence for a supported chain and address.

```json
{"jsonrpc":"2.0","method":"hookline_getHook","params":[8453,"0xb08211d57032dd10b1974d4b876851a7f7596888"],"id":4}
```

## Public routes

Send Hookline methods to `POST /rpc`. Safe standard methods can be sent to `POST /rpc/{chainId}`.

The standard proxy allowlist includes chain identity, block, bytecode, storage, balance, transaction lookup, receipt, fee, gas-price, and estimation calls. It rejects transaction submission, account requests, debug, trace, personal, and administrative methods.

Constraints:

- Request bodies: 32 KiB maximum
- Upstream responses: 2 MiB maximum
- Upstream timeout: eight seconds
- Batches: rejected
- Public rate limit: best-effort 60 POST requests per IP per minute
- Cache policy: no-store for dynamic evidence

## x402 capacity

`POST /rpc/paid` exposes the Hookline methods through the official x402 Hono middleware.

| Field | Value |
| --- | --- |
| Scheme | `exact` |
| Network | `eip155:8453` |
| Asset | Base USDC |
| Amount | `10000` atomic units, or 0.01 USDC |
| Settlement | `0x69e73F4B54ED92939D48B5472894179BF3292DD3` |

An unpaid, valid request receives HTTP `402` and a `Payment-Required` header. Malformed JSON-RPC is rejected before a payment challenge is created.

## Errors

Hookline uses JSON-RPC error envelopes. Important codes include:

- `-32700`: invalid JSON or body limit exceeded
- `-32600`: invalid JSON-RPC request
- `-32601`: unsupported or disallowed method
- `-32602`: invalid method parameters
- `-32029`: public rate limit exceeded

Upstream failures are returned as explicit errors and are not converted into successful evidence.
