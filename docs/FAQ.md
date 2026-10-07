# Hookline FAQ

## What is Hookline?

Hookline is a multichain intelligence desk and API for onchain hooks. It helps people discover active hooks and projects, inspect deployed contracts, decode Uniswap v4 hook permissions, preserve evidence, compare deployments, and monitor supported networks.

## What problem does it solve?

Hook information is split across explorers, repositories, RPC calls, dashboards, and social posts. Hookline organizes it around one chain-aware identity and keeps direct observations separate from derived metrics and project claims.

## Where does the current data come from?

The board uses a timestamped v4.xyz community-indexer snapshot for hook discovery and aggregate pool and swap counts. Its directory metadata is community-curated, project-submitted, or Hookline-researched and labeled accordingly. Live contract evidence comes directly from configured Ethereum, BNB Chain, Base, Arbitrum One, and Robinhood Chain RPC endpoints. Hookline uses bytecode and call methods, current block height, deterministic hashing, and local permission decoding.

## Is the board exhaustive?

No. The sync collects activity leaders for every two-nibble hook-address prefix exposed by the public index. That creates broad cross-chain coverage without overstating completeness or overloading a community service. First-party PoolManager event indexing is the path to exhaustive, reproducible coverage.

## Is Hookline already indexing pool volume and liquidity?

Yes. Open a hook profile to resolve related markets. When DexScreener has the pool, Hookline shows price, market capitalization, liquidity, 24-hour volume, and change while keeping the indexed hook relationship visible.

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

Research remains anonymous and does not require a wallet. On supported EVM markets, Hookline can prepare a short-lived, fee-bound route for a connected browser wallet. The wallet signs and submits the exact reviewed transaction. Hookline's backend never signs, broadcasts, or receives wallet secrets, and the public RPC continues to reject transaction-submission and account-access methods.

## What is the paid RPC?

The paid endpoint uses x402 to request 0.01 USDC on Base for a higher-capacity Hookline request. A valid unpaid request receives a standard HTTP 402 challenge with the payment terms.

## What does the Telegram bot do?

Send it a token or hook address to navigate hook relationships, related tokens, markets, and trade previews. A website hook link opens the matching chain and profile directly. From a hook profile, enable a persistent alert for direct runtime changes, new indexed pool relationships, or indexed liquidity movement of 10% or more. Checks run every 10 minutes. Telegram does not sign; reviewed execution opens on the website for the user's wallet.

## What does Hookline execution cost?

Hookline shows a 1% gross execution fee and applies 0.3% cashback instantly in the route, leaving a 0.7% effective fee. There is no deferred cashback claim. A short-lived intent binds the wallet, chain, destination, calldata, value, and economics before signing. After confirmation, Hookline independently verifies the transaction and stores a compact receipt without keys, signatures, or signed transaction material.

## Do I need a Hookline account?

No. Discovery, inspection, watchlists, and alerts do not require a Hookline login. Telegram supplies its own identity for alert subscriptions, and the connected wallet is the execution identity. A broader account system can be added later for cross-device synchronization without blocking current use.

## Does market capitalization create revenue for Hookline?

No. Market capitalization itself does not create creator fees. Venue fees depend on actual trading activity, and product revenue depends on people paying for useful services such as capacity, history, alerts, team workflows, or integrations.

## Is Hookline affiliated with Uniswap, Robinhood, Flaunch, or PayAI?

No. Hookline is independent and is not endorsed by those organizations. It uses public protocols, chains, tools, and infrastructure where documented.

## How can builders contribute?

Open a focused issue with the chain, contract, block range, expected result, and reproduction steps. Code contributions should include tests and preserve Hookline's evidence and safety constraints.

## What comes next?

The next major milestone is an event-backed hook registry that connects hook deployments to pools and official PoolManager activity with reproducible provenance.
