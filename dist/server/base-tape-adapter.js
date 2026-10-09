/**
 * Cloudflare Worker-compatible Base Tape log adapter.
 *
 * Envio HyperSync is the authenticated primary source, SQD Portal is the
 * keyless bounded fallback, and the existing reviewed JSON-RPC pool remains
 * the final fallback. Every external result is normalized to eth_getLogs shape
 * and rejected unless its identity and requested range are internally sound.
 */

'use strict';

const BASE_CHAIN_ID = 8453;
const BASE_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const ENVIO_ENDPOINT = 'https://base.hypersync.xyz/query';
const SQD_ENDPOINT = 'https://portal.sqd.dev/datasets/base-mainnet/stream';

// Leave five requests of headroom under Envio's free 15 rpm package.
const ENVIO_RATE_LIMIT_PER_MINUTE = 10;
const ENVIO_RATE_WINDOW_MS = 60_000;
const ADAPTER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ADAPTER_TIMEOUT_MS = 8_000;
const SQD_MAX_WINDOW_BLOCKS = 1_000;
const SQD_MAX_LOGS = 10_000;
const SQD_MAX_PAGES = 4;

const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const DATA = /^0x(?:[0-9a-f]{2})*$/i;
const DEFAULT_RATE_STATE = { envioRequestTimes: [] };

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function integer(value, code) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('range');
    return Number(parsed);
  } catch {
    throw failure(code);
  }
}

function quantity(value, code = 'tape_log_quantity_invalid') {
  return `0x${BigInt(integer(value, code)).toString(16)}`;
}

function lowerHash(value, code) {
  const normalized = String(value || '').toLowerCase();
  if (!HASH.test(normalized)) throw failure(code);
  return normalized;
}

function normalizeTopicFilterEntry(entry) {
  if (entry == null) return null;
  const values = Array.isArray(entry) ? entry : [entry];
  if (!values.length) return null;
  return values.map((value) => lowerHash(value, 'tape_filter_topics_invalid'));
}

function validateFilter(filter) {
  if (!filter || typeof filter !== 'object') throw failure('tape_filter_invalid');
  const address = String(filter.address || '').toLowerCase();
  if (!ADDRESS.test(address) || address !== BASE_POOL_MANAGER) throw failure('tape_filter_address_invalid');
  if (!Array.isArray(filter.topics) || !filter.topics.length) throw failure('tape_filter_topics_empty');
  const topics = filter.topics.map(normalizeTopicFilterEntry);
  if (!topics[0]?.length) throw failure('tape_filter_topic0_invalid');
  return { address, topics };
}

function validateRange(filter, pinned) {
  if (!pinned) throw failure('tape_pin_required');
  const from = integer(filter.fromBlock, 'tape_from_block_invalid');
  const to = integer(filter.toBlock, 'tape_to_block_invalid');
  if (to < from) throw failure('tape_to_before_from');
  if (to > pinned.number) throw failure('tape_to_after_pinned');
  return { from, to };
}

function topicMatches(topics, filters) {
  for (let index = 0; index < filters.length; index++) {
    const allowed = filters[index];
    if (!allowed) continue;
    if (!allowed.includes(topics[index])) return false;
  }
  return true;
}

function normalizeLog(source, filters, range) {
  const address = String(source.address || '').toLowerCase();
  if (address !== BASE_POOL_MANAGER) throw failure('tape_source_log_address_invalid');

  const rawTopics = Array.isArray(source.topics)
    ? source.topics
    : [source.topic0, source.topic1, source.topic2, source.topic3].filter(Boolean);
  if (!rawTopics.length) throw failure('tape_source_log_topics_invalid');
  const topics = rawTopics.map((topic) => lowerHash(topic, 'tape_source_log_topics_invalid'));
  if (!topicMatches(topics, filters)) throw failure('tape_source_log_topic_mismatch');

  const blockNumber = integer(source.block_number ?? source.blockNumber, 'tape_source_log_block_invalid');
  if (blockNumber < range.from || blockNumber > range.to) throw failure('tape_source_log_range_invalid');
  const blockHash = lowerHash(source.block_hash ?? source.blockHash, 'tape_source_log_block_hash_invalid');
  const transactionHash = lowerHash(
    source.transaction_hash ?? source.transactionHash,
    'tape_source_log_transaction_hash_invalid',
  );
  const logIndex = integer(source.log_index ?? source.logIndex, 'tape_source_log_index_invalid');
  const transactionIndex = integer(
    source.transaction_index ?? source.transactionIndex ?? 0,
    'tape_source_transaction_index_invalid',
  );
  const data = String(source.data || '').toLowerCase();
  if (!DATA.test(data)) throw failure('tape_source_log_data_invalid');

  return {
    address,
    blockNumber: quantity(blockNumber),
    blockHash,
    transactionHash,
    transactionIndex: quantity(transactionIndex),
    logIndex: quantity(logIndex),
    topics,
    data,
    removed: false,
  };
}

function normalizeLogSet(sources, filters, range, prefix) {
  if (!Array.isArray(sources)) throw failure(`${prefix}_logs_invalid`);
  const seen = new Set();
  const logs = sources.map((source) => normalizeLog(source, filters, range));
  for (const log of logs) {
    const identity = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(identity)) throw failure(`${prefix}_duplicate_log`);
    seen.add(identity);
  }
  return logs.sort((left, right) =>
    integer(left.blockNumber, `${prefix}_sort_invalid`) - integer(right.blockNumber, `${prefix}_sort_invalid`)
    || integer(left.logIndex, `${prefix}_sort_invalid`) - integer(right.logIndex, `${prefix}_sort_invalid`));
}

async function readBounded(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ADAPTER_MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.();
    throw failure('tape_source_response_too_large');
  }
  if (!response.body?.getReader) throw failure('tape_source_body_unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ADAPTER_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw failure('tape_source_response_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function post(fetchImpl, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADAPTER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw failure(`tape_source_http_${response.status}`);
    return await readBounded(response);
  } catch (error) {
    if (error?.name === 'AbortError') throw failure('tape_source_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function reserveEnvioRequest(rateState, now) {
  const cutoff = now - ENVIO_RATE_WINDOW_MS;
  rateState.envioRequestTimes = (rateState.envioRequestTimes || []).filter((time) => time > cutoff);
  if (rateState.envioRequestTimes.length >= ENVIO_RATE_LIMIT_PER_MINUTE) {
    throw failure('envio_rate_limited');
  }
  rateState.envioRequestTimes.push(now);
}

function envioTopics(filters) {
  return filters.map((entry) => entry || []);
}

async function fetchEnvioLogs({ token, range, filters, fetchImpl, rateState, now }) {
  reserveEnvioRequest(rateState, now());
  const text = await post(fetchImpl, ENVIO_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      from_block: range.from,
      to_block: range.to + 1,
      logs: [{ address: [BASE_POOL_MANAGER], topics: envioTopics(filters) }],
      field_selection: {
        log: [
          'block_number', 'block_hash', 'transaction_hash', 'transaction_index',
          'log_index', 'address', 'data', 'topic0', 'topic1', 'topic2', 'topic3',
        ],
      },
    }),
  });
  let payload;
  try { payload = JSON.parse(text); } catch { throw failure('envio_json_invalid'); }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw failure('envio_response_invalid');
  }
  const archiveHeight = integer(payload.archive_height, 'envio_archive_height_invalid');
  const nextBlock = integer(payload.next_block, 'envio_next_block_invalid');
  if (archiveHeight < range.to || nextBlock < range.to + 1) throw failure('envio_range_incomplete');
  const sources = [];
  for (const batch of payload.data) {
    if (!batch || !Array.isArray(batch.logs)) throw failure('envio_batch_invalid');
    sources.push(...batch.logs);
  }
  return normalizeLogSet(sources, filters, range, 'envio');
}

function sqdRequest(range, filters) {
  return {
    type: 'evm',
    fromBlock: range.from,
    toBlock: range.to,
    includeAllBlocks: true,
    fields: {
      block: { number: true, hash: true },
      log: {
        address: true,
        topics: true,
        data: true,
        logIndex: true,
        transactionIndex: true,
        transactionHash: true,
      },
    },
    logs: [{ address: [BASE_POOL_MANAGER], topic0: filters[0] }],
  };
}

function parseNdjson(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { throw failure('sqd_ndjson_invalid'); }
  }
  return records;
}

async function fetchSqdLogs({ range, filters, pinned, fetchImpl }) {
  if (range.to - range.from + 1 > SQD_MAX_WINDOW_BLOCKS) throw failure('sqd_window_too_wide');
  const records = [];
  let nextBlock = range.from;
  let totalBytes = 0;
  for (let page = 0; nextBlock <= range.to && page < SQD_MAX_PAGES; page++) {
    const text = await post(fetchImpl, SQD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sqdRequest({ from: nextBlock, to: range.to }, filters)),
    });
    totalBytes += new TextEncoder().encode(text).byteLength;
    if (totalBytes > ADAPTER_MAX_RESPONSE_BYTES) throw failure('tape_source_response_too_large');
    const pageRecords = parseNdjson(text);
    if (!pageRecords.length) throw failure('sqd_range_incomplete');
    records.push(...pageRecords);
    const lastHeader = pageRecords.at(-1)?.header;
    const lastBlock = integer(lastHeader?.number, 'sqd_header_invalid');
    if (lastBlock < nextBlock || lastBlock > range.to) throw failure('sqd_range_noncontiguous');
    nextBlock = lastBlock + 1;
  }
  if (nextBlock <= range.to || records.length !== range.to - range.from + 1) {
    throw failure('sqd_range_incomplete');
  }
  const sources = [];
  for (let offset = 0; offset < records.length; offset++) {
    const record = records[offset];
    const header = record?.header;
    const number = integer(header?.number, 'sqd_header_invalid');
    const hash = lowerHash(header?.hash, 'sqd_header_invalid');
    if (number !== range.from + offset) throw failure('sqd_range_noncontiguous');
    if (number === pinned.number && hash !== pinned.hash) throw failure('sqd_pin_mismatch');
    if (!Array.isArray(record.logs || [])) throw failure('sqd_logs_invalid');
    for (const log of record.logs || []) {
      sources.push({ ...log, blockNumber: number, blockHash: hash });
    }
  }
  if (sources.length > SQD_MAX_LOGS) throw failure('sqd_log_limit_exceeded');
  return normalizeLogSet(sources, filters, range, 'sqd');
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'tape_source_unavailable';
}

/**
 * Wrap the reviewed RPC pool with the two free log services.
 * Non-log calls and the final log fallback retain the pool's existing rules.
 */
export function createBaseTapeAdapter({
  env = {},
  poolRpc,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  rateState = DEFAULT_RATE_STATE,
} = {}) {
  if (typeof poolRpc !== 'function') throw failure('tape_adapter_pool_required');
  if (typeof fetchImpl !== 'function') throw failure('tape_adapter_fetch_required');
  const diagnostics = {
    envio: { attempts: 0, successes: 0, lastFailure: null },
    sqd: { attempts: 0, successes: 0, lastFailure: null },
    rpc: { calls: 0 },
    lastLogSource: null,
  };
  let pinned = null;

  const invokePool = async (chainId, method, params) => {
    diagnostics.rpc.calls++;
    if (method === 'eth_getLogs') diagnostics.lastLogSource = 'rpc';
    return poolRpc(chainId, method, params);
  };

  const rpc = async (chainId, method, params = []) => {
    if (method !== 'eth_getLogs') return invokePool(chainId, method, params);
    if (Number(chainId) !== BASE_CHAIN_ID) throw failure('tape_adapter_chain_invalid');
    const filter = params[0];
    const validated = validateFilter(filter);
    const range = validateRange(filter, pinned);

    const token = typeof env.ENVIO_API_TOKEN === 'string' ? env.ENVIO_API_TOKEN.trim() : '';
    if (token) {
      diagnostics.envio.attempts++;
      try {
        const logs = await fetchEnvioLogs({
          token,
          range,
          filters: validated.topics,
          fetchImpl,
          rateState,
          now,
        });
        diagnostics.envio.successes++;
        diagnostics.envio.lastFailure = null;
        diagnostics.lastLogSource = 'envio';
        return logs;
      } catch (error) {
        diagnostics.envio.lastFailure = errorCode(error);
      }
    }

    diagnostics.sqd.attempts++;
    try {
      const logs = await fetchSqdLogs({
        range,
        filters: validated.topics,
        pinned,
        fetchImpl,
      });
      diagnostics.sqd.successes++;
      diagnostics.sqd.lastFailure = null;
      diagnostics.lastLogSource = 'sqd';
      return logs;
    } catch (error) {
      diagnostics.sqd.lastFailure = errorCode(error);
    }

    return invokePool(chainId, method, params);
  };

  rpc.pinBlock = (chainId, block) => {
    if (typeof poolRpc.pinBlock !== 'function') throw failure('tape_adapter_pin_unavailable');
    const next = {
      number: integer(block?.number, 'tape_adapter_pin_invalid'),
      hash: lowerHash(block?.hash, 'tape_adapter_pin_invalid'),
    };
    if (Number(chainId) !== BASE_CHAIN_ID) throw failure('tape_adapter_chain_invalid');
    if (pinned && (pinned.number !== next.number || pinned.hash !== next.hash)) {
      throw failure('tape_adapter_pin_changed');
    }
    poolRpc.pinBlock(chainId, block);
    pinned = next;
  };
  rpc.upstreamRequests = () =>
    typeof poolRpc.upstreamRequests === 'function' ? poolRpc.upstreamRequests() : 0;
  if (typeof poolRpc.suggestedLogRange === 'function') {
    rpc.suggestedLogRange = (...args) => poolRpc.suggestedLogRange(...args);
  }
  rpc.tapeSourceDiagnostics = () => structuredClone(diagnostics);
  return rpc;
}

export {
  ADAPTER_MAX_RESPONSE_BYTES,
  BASE_POOL_MANAGER,
  ENVIO_ENDPOINT,
  ENVIO_RATE_LIMIT_PER_MINUTE,
  SQD_ENDPOINT,
  SQD_MAX_LOGS,
  SQD_MAX_WINDOW_BLOCKS,
};
