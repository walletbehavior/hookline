# Hookline FAQ

## What is Hookline?

Hookline is a multichain intelligence desk and API for onchain hooks. It helps people inspect deployed contracts, decode Uniswap v4 hook permissions, preserve evidence, compare deployments, and monitor supported networks.

## What problem does it solve?

Hook information is split across explorers, repositories, RPC calls, dashboards, and social posts. Hookline organizes it around one chain-aware identity and keeps direct observations separate from derived metrics and project claims.

## Where does the current data come from?

Current evidence comes directly from configured Ethereum, Base, Arbitrum One, and Robinhood Chain RPC endpoints. Hookline uses bytecode and call methods, current block height, deterministic hashing, and local permission decoding. The network page shows the selected upstream and current status.

## Is Hookline already indexing pool volume and liquidity?

No. The current release provides point-in-time contract evidence and network telemetry. Event-backed pool discovery, swap activity, liquidity changes, and historical analytics are planned work.

## What do the 14 permission flags mean?

Uniswap v4 hook addresses encode enabled callback permissions in their low 14 bits. Hookline decodes those bits into the canonical callback names. An enabled callback says where the hook can participate in the pool lifecycle; it does not describe the full runtime behavior or determine safety.

## Does Hookline audit contracts?

No. Hookline provides evidence and monitoring. It is not a smart-contract audit, legal opinion, or trading recommendation.

## Why are comparisons limited to one chain?

An address is not a complete identity, and block heights on different chains do not share state or time semantics. Hookline requires the same chain for direct evidence comparisons.

## What happens when an RPC request fails?

The failure is shown explicitly. A failed refresh does not erase the most recent successful observation.

## Are watchlists uploaded?

Not in the current release. Named watchlists and their observations are stored in the user's browser and can be exported or imported as JSON.

## Does Hookline submit transactions or connect my wallet?

The evidence RPC does not submit transactions. The public proxy rejects transaction-submission and account-access methods. The main inspection workflow does not require a wallet.

## What is the paid RPC?

The paid endpoint uses x402 to request 0.01 USDC on Base for a higher-capacity Hookline request. A valid unpaid request receives a standard HTTP 402 challenge with the payment terms.

## What is HKLN?

HKLN is Hookline's service-alignment asset on Base.

Contract address:

```text
0x11672C8cD5CB3F17364339244826B110Bac0AC91
```

Current product access does not require holding HKLN. Future holder features are not active until they are implemented and documented.

## Does market capitalization create revenue for Hookline?

No. Market capitalization itself does not create creator fees. Venue fees depend on actual trading activity, and product revenue depends on people paying for useful services such as capacity, history, alerts, team workflows, or integrations.

## Is Hookline affiliated with Uniswap, Robinhood, Flaunch, or PayAI?

No. Hookline is independent and is not endorsed by those organizations. It uses public protocols, chains, tools, and infrastructure where documented.

## How can builders contribute?

Open a focused issue with the chain, contract, block range, expected result, and reproduction steps. Code contributions should include tests and preserve Hookline's evidence and safety constraints.

## What comes next?

The next major milestone is an event-backed hook registry that connects hook deployments to pools and official PoolManager activity with reproducible provenance.
