// ----------------------------------------------------------------------------
// bot/hook-view.js — Hook view + sibling token navigation
//
// Provides:
//   - hookView(token)       : the hook behind a token, with pagination of
//                             sibling tokens (tokens sharing the same v4 hook).
//   - siblingView(chainId, hook, siblings, offset) : token list for a hook.
//   - siblingTokenView(chainId, hook, siblingToken) : render a sibling token's
//                             card (used after clicking a sibling button).
//
// Deterministic callback navigation: tg:siblings:{chainId}:{hook}:{offset}
// paginates; tg:sibling:{chainId}:{hook}:{tokenAddress} jumps to a sibling;
// tg:back returns to the previous view in the session stack.
// ----------------------------------------------------------------------------
'use strict';

import { getChain } from './chains.js';
import { KEYS } from './keys.js';
import { renderTokenCard } from './token-view.js';

const PAGE_SIZE = 8;

/** Render the hook view with related-token pagination. */
export function renderHookView(token, chainId, hookInfo, siblings, siblingOffset = 0) {
  const chain = getChain(chainId);
  const displayed = siblings.slice(siblingOffset, siblingOffset + PAGE_SIZE);
  const hasNext = siblingOffset + PAGE_SIZE < siblings.length;
  const hasPrev = siblingOffset > 0;

  let hookLine = hookInfo
    ? `Hook: ${hookInfo.hookName || 'v4 hook'}\n${hookInfo.hookAddress.slice(2, 10)}...${hookInfo.hookAddress.slice(-6)} • ${hookInfo.hookNamed ? 'verified contract' : 'address-only'}`
    : `Hook: none indexed`;

  const lines = [
    `🪝 *Hookline* • *Hook profile*`,
    ``,
    `*${token.symbol}* on chain ${chain ? chain.name : chainId}`,
    `Address: \`${token.address}\``,
    hookLine,
    ``,
    `Related tokens: ${siblings.length} total`,
    displayed.length
      ? displayed.map((rel, i) => `${i + 1 + siblingOffset}. *${rel.baseToken?.symbol || rel.quoteToken?.symbol || rel.pairLabel}* $${rel.liquidityUsd != null ? rel.liquidityUsd.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : 'n/a'} TVL`)
      : '  (none indexed)',
  ].filter(Boolean);

  const siblingButtons = displayed.flatMap((rel) => {
    const candidates = [rel.baseToken, rel.quoteToken].filter((entry) => entry?.address);
    const preferred = candidates.find(
      (entry) => entry.address.toLowerCase() !== token.address.toLowerCase()
    ) || candidates[0];
    return preferred
      ? [[KEYS.sibling(chainId, preferred.address, preferred.symbol || rel.pairLabel)]]
      : [];
  });
  const buttons = [
    ...siblingButtons,
    [KEYS.back(), KEYS.related(chainId, hookInfo?.hookAddress || token.address)],
  ];
  if (hasPrev) {
    buttons.unshift([KEYS.siblingPrev(chainId, hookInfo?.hookAddress || token.address, siblingOffset)]);
  }
  if (hasNext) {
    buttons.push([KEYS.siblingNext(chainId, hookInfo?.hookAddress || token.address, siblingOffset)]);
  }
  if (displayed.length) buttons.unshift([KEYS.dex(chainId, token.address)]);

  return {
    text: lines.join('\n'),
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
    hookInfo,
    siblings: siblings.slice(siblingOffset, siblingOffset + PAGE_SIZE),
    siblingOffset,
    total: siblings.length,
  };
}

/** Render a sibling token's card and push the current token view onto the stack. */
export function siblingTokenView(session, chainId, hookAddress, siblingAddress, siblings) {
  const siblingToken = siblings.find((rel) => rel.baseToken?.address === siblingAddress.toLowerCase() || rel.quoteToken?.address === siblingAddress.toLowerCase());
  const token = siblingToken
    ? { address: siblingAddress.toLowerCase(), symbol: siblingToken.baseToken?.symbol || siblingToken.quoteToken?.symbol || '', name: siblingToken.pairLabel }
    : { address: siblingAddress.toLowerCase(), symbol: '', name: '' };

  const marketInfo = siblingToken
    ? { markets: siblingToken.poolId ? [{ poolId: siblingToken.poolId, pairAddress: siblingToken.poolId }] : [], priceUsd: siblingToken.priceUsd }
    : { markets: [], priceUsd: null };

  const card = renderTokenCard(token, chainId, { hookAddress, hookName: 'Sibling', hookNamed: false }, marketInfo.markets);
  return {
    kind: 'token_view',
    message: card,
    session: { chainId, address: siblingAddress.toLowerCase(), siblingOffset: null },
  };
}
