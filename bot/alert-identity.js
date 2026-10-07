import { cleanLabel } from './navigation.js';

const CACHES = new WeakMap();
const TTL = 5 * 60 * 1000;
const LIMIT = 500;
const keyOf = (row) => `${Number(row.chain_id)}:${String(row.target_address).toLowerCase()}:${row.target_type || 'hook'}`;
function fallback(row) { return { name: row.target_type === 'token' ? 'Unnamed token' : 'Unnamed hook', kind: row.target_type === 'token' ? 'token' : 'hook', source: 'Address only' }; }
function cacheFor(resolver) {
  if (!CACHES.has(resolver)) CACHES.set(resolver, new Map());
  return CACHES.get(resolver);
}
function knownIdentity(value, row) {
  const name = cleanLabel(value?.name || value?.hookName || value?.symbol);
  if (!name || /^(hook|token|unnamed hook|unnamed token|unlabeled hook)$/i.test(name)) return null;
  return { name, kind: row.target_type === 'token' ? 'token' : 'hook', symbol: cleanLabel(value.symbol, 20), source: cleanLabel(value.source || 'Indexed identity', 100) };
}
async function boundedRead(operation) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2500); })]); }
  finally { clearTimeout(timer); }
}

/** One registry read per menu, no RPC probes. Heavy fallbacks capped at three targets. */
export async function alertIdentities(ctx, rows, suppliedProjects) {
  let projects = suppliedProjects;
  if (!projects) {
    try { projects = await ctx.services?.projects?.listProjects?.() || []; } catch { projects = []; }
  }
  const result = new Map();
  let fallbackBudget = 3;
  for (const row of rows) {
    const key = keyOf(row), address = String(row.target_address).toLowerCase();
    const project = projects.find((p) => p.deployments?.some((d) => Number(d.chainId) === Number(row.chain_id) && String(d.address).toLowerCase() === address));
    const deployment = project?.deployments?.find((d) => Number(d.chainId) === Number(row.chain_id) && String(d.address).toLowerCase() === address);
    if (project) {
      result.set(key, { name: cleanLabel(deployment.name || project.name), kind: row.target_type === 'token' ? 'token' : 'hook', projectName: cleanLabel(project.name), projectId: project.id, source: cleanLabel(deployment.provenance || project.provenance || 'Project relationship') });
      continue;
    }
    const lightweight = ctx.services?.resolveAlertIdentity;
    const resolver = lightweight || (row.target_type === 'token' ? ctx.services?.resolveTokenHooks : ctx.services?.resolveHookMarkets);
    if (typeof resolver !== 'function') { result.set(key, fallback(row)); continue; }
    const cache = cacheFor(resolver), cached = cache.get(key);
    if (cached && cached.until > Date.now()) { result.set(key, cached.identity); continue; }
    if (!lightweight && fallbackBudget-- <= 0) { result.set(key, fallback(row)); continue; }
    let identity;
    try {
      const raw = await boundedRead(() => lightweight ? resolver(Number(row.chain_id), address, row.target_type || 'hook') : row.target_type === 'token' ? resolver(address) : resolver(Number(row.chain_id), address));
      if (lightweight) identity = knownIdentity(raw, row);
      else if (row.target_type === 'token') {
        const relationship = raw?.relationships?.find((r) => Number(r.chainId) === Number(row.chain_id));
        const token = [relationship?.baseToken, relationship?.quoteToken].find((t) => t?.address?.toLowerCase() === address);
        identity = knownIdentity(token, row);
      } else identity = knownIdentity({ name: raw?.profile?.project?.name || raw?.profile?.verifiedContract?.name || raw?.project?.name, source: raw?.profile?.project?.provenance || raw?.profile?.verifiedContract?.provenance }, row);
    } catch { /* A missing identity never becomes an invented project name. */ }
    identity ||= fallback(row);
    cache.set(key, { identity, until: Date.now() + TTL });
    if (cache.size > LIMIT) for (const oldKey of [...cache.keys()].slice(0, cache.size - LIMIT)) cache.delete(oldKey);
    result.set(key, identity);
  }
  return { projects, get: (row) => result.get(keyOf(row)) || fallback(row) };
}
