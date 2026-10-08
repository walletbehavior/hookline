import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonicalProjectRegistry, projectContext, publicProjectRegistry, handleProjectsApi } from '../projects/api.js';
import { handleProjectMessage, handleProjectCallback } from '../projects/telegram.js';
import { getContributionStatus } from '../projects/contributions.js';

// Real SQL constraints, transactions, joins, and RETURNING semantics. No network.
class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    for (const migration of ['0002_project_contributions.sql', '0003_project_evidence.sql']) {
      this.sqlite.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
    }
  }
  prepare(sql) {
    const database = this;
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      async first() { return database.sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: database.sqlite.prepare(sql).all(...values) }; },
      async run() { return statement._run(); },
      _run() { const result = database.sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = statements.map((statement) => statement._run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

const NOW = Date.now();
const address = '0x' + '1'.repeat(40);
const secondAddress = '0x' + '2'.repeat(40);
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const REVIEW_TOKEN = 'offline-project-review-token-' + 'a'.repeat(40);
const noFetch = async () => { throw new Error('Unexpected network access in offline integration test'); };
const originalFetch = globalThis.fetch;
globalThis.fetch = noFetch;

function env() { return { DB: new D1(), PROJECT_REVIEW_TOKEN: REVIEW_TOKEN }; }
function assets() {
  const projects = [
    { id: 'alpha', name: 'Alpha Hooks', website: 'https://alpha-hooks.org/', summary: 'Verified research record for integration tests.', category: 'Liquidity', provenance: 'researched project record', sources: [{ label: 'Docs', url: 'https://alpha-hooks.org/docs' }], deployments: [{ chainId: 1, address, name: 'Alpha hook', role: 'hook', monitor: true, provenance: 'official deployment reference', sourceUrl: 'https://alpha-hooks.org/docs' }] },
    { id: 'beta', name: 'Beta Hooks', website: 'https://beta-hooks.org/', summary: 'Another liquidity mechanism.', category: 'Liquidity', provenance: 'researched project record', sources: [{ label: 'Docs', url: 'https://beta-hooks.org/docs' }], deployments: [{ chainId: 8453, address: secondAddress, name: 'Beta hook', role: 'hook', monitor: false, provenance: 'official deployment reference', sourceUrl: 'https://beta-hooks.org/docs' }] },
    { id: 'gamma', name: 'Gamma Tools', website: 'https://gamma-hooks.org/', summary: 'Developer tools without a token or linked deployment.', category: 'Developer tools', provenance: 'researched project record', sources: [{ label: 'Docs', url: 'https://gamma-hooks.org/docs' }], deployments: [] },
  ];
  const fingerprint='f'.repeat(64),deploymentIds=[`1_${address}`,`8453_${secondAddress}`];
  return { hooks: JSON.stringify({ schemaVersion: 1, generatedAt: new Date(NOW).toISOString(), projects: [], hooks: [] }),
    projects: JSON.stringify({ schemaVersion: 1, generatedAt: new Date(NOW).toISOString(), projects }),
    runtimeFamilies: JSON.stringify({schemaVersion:1,generatedAt:new Date(NOW).toISOString(),source:{kind:'offline fixture'},
      deployments:[{id:deploymentIds[0],chainId:1,address,name:'Alpha hook',fingerprint},{id:deploymentIds[1],chainId:8453,address:secondAddress,name:'Beta hook',fingerprint}],
      families:[{runtimeFingerprint:fingerprint,codeByteLength:42,deploymentCount:2,chainIds:[1,8453],representativeName:'Alpha hook',deployments:deploymentIds}]})};
}
async function api(e, source, path, { method = 'GET', body, token, headers = {} } = {}) {
  const request = new Request(`https://hookline.world${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const response = await handleProjectsApi(request, e, source);
  if (response == null) return { response: null, body: null };
  return { response, body: await response.json() };
}
async function count(e, table) { return Number((await e.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n); }
function projectSubmission(extra = {}) { return { kind: 'project', name: 'New Mechanism', website: 'https://new-mechanism.org/', description: 'An independently reviewed new hook project.', contracts: [{ chainId: 1, address: secondAddress, role: 'hook' }], contact: '@mechanism_team', agreement: true, ...extra }; }
async function submitAndApprove(e, source, input = projectSubmission()) {
  const submitted = await api(e, source, '/api/project-submissions', { method: 'POST', body: input });
  assert.equal(submitted.response.status, 201);
  const approved = await api(e, source, `/api/project-submissions/${submitted.body.id}/review`, { method: 'POST', token: REVIEW_TOKEN, body: { decision: 'approve', reason: 'Verified project identity and canonical domain against primary sources. Proposed deployments remain unverified.', proofUrl: `${input.website}docs` } });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'approved');
  return submitted.body;
}
async function addObservation(e, { id, projectId = 'alpha', chainId = 1, contract = address, blockNumber, observedAt = NOW, canonical = 1 }) {
  const observation = { id, projectId, chainId, address: contract, blockNumber, blockHash: hash(blockNumber), observedAt: new Date(observedAt).toISOString(), source: 'Offline pinned RPC fixture', status: 'observed', fields: { bytecodeLength: 42, runtimeFingerprint: 'f'.repeat(64), owner: null }, probes: { owner: { status: 'unavailable' } }, fieldMeta: {} };
  await e.DB.prepare('INSERT INTO project_observations(id,project_id,chain_id,address,block_number,block_hash,observed_at,payload_json,canonical) VALUES(?,?,?,?,?,?,?,?,?)').bind(id, projectId, chainId, contract, blockNumber, hash(blockNumber), observedAt, JSON.stringify(observation), canonical).run();
  return observation;
}
async function addEvent(e, { id, projectId = 'alpha', chainId = 1, blockNumber = 120, canonical = 1, observedAt = NOW }) {
  const event = { id, projectId, projectName: projectId, chainId, address, blockNumber, observedAt: new Date(observedAt).toISOString(), kind: 'observed_change', title: 'Configuration changed', classification:'configuration', before: 10, after: 20, evidence: { scope: 'between pinned observations', fromBlock: 100, toBlock: blockNumber, source: 'Offline pinned RPC fixture' } };
  await e.DB.prepare('INSERT INTO project_events(id,project_id,chain_id,address,block_number,block_hash,observed_at,kind,payload_json,canonical) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, projectId, chainId, address, blockNumber, hash(blockNumber), observedAt, event.kind, JSON.stringify(event), canonical).run();
  return event;
}
async function withDns(name, value, operation) {
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://cloudflare-dns.com');
    assert.equal(endpoint.pathname, '/dns-query');
    assert.equal(endpoint.searchParams.get('name'), name);
    assert.equal(endpoint.searchParams.get('type'), 'TXT');
    assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify({ Status: 0, Answer: [{ name: name + '.', type: 16, data: JSON.stringify(value) }] }), { headers: { 'content-type': 'application/dns-json' } });
  };
  try { return await operation(); } finally { globalThis.fetch = noFetch; }
}
function telegram(e, source) {
  const replies = [], answers = [];
  const client = { async reply(chatId, text, options) { replies.push({ chatId, text, options }); return { message_id: replies.length }; }, async answer(id) { answers.push(id); } };
  const ctx = { env: e, services: { projects: projectContext(source, e) } };
  let messageId = 100;
  return { client, ctx, replies, answers,
    async send(command, args = '', userId = '12345', chatId = userId, explicitMessageId) {
      const result = await handleProjectMessage(client, { command, args, chatId, messageId: explicitMessageId ?? ++messageId }, ctx, userId);
      assert.equal(result?.handled, true);
      return replies.at(-1);
    },
  };
}
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('canonical and public contexts await storage and preserve distinct authority', async () => {
  const e = env(), source = assets(), context = projectContext(source, e);
  assert.equal(canonicalProjectRegistry(source).projects.length, 3);
  assert.equal((await context.getCanonicalProject('alpha')).website, 'https://alpha-hooks.org/');
  assert.equal((await context.getProject('alpha')).name, 'Alpha Hooks');
  assert.equal((await context.getRuntimeFamily('f'.repeat(48))).deploymentCount,2);
  assert.equal(await context.getRuntimeFamily('0'.repeat(48)),null);
  assert.equal((await context.listProjects()).length, 3);
  assert.equal(await context.getCanonicalProject('missing'), null);
  assert.equal(await context.getProject('missing'), null);
  const fallback = projectContext(source);
  assert.equal((await fallback.getCanonicalProject('alpha')).id, 'alpha');
  assert.equal((await fallback.getProject('gamma')).deployments.length, 0);
});

test('HTTP directory and profiles expose only canonical observations, chain-aware relationships, and source windows', async () => {
  const e = env(), source = assets();
  await addObservation(e, { id: 'old', blockNumber: 100, observedAt: NOW - 1000 });
  await addObservation(e, { id: 'latest', blockNumber: 120 });
  await addObservation(e, { id: 'orphan', blockNumber: 140, observedAt: NOW + 1000, canonical: 0 });
  await addEvent(e, { id: 'alpha-event' });
  await addEvent(e, { id: 'beta-event', projectId: 'beta', chainId: 8453 });
  await addEvent(e, { id: 'orphan-event', blockNumber: 140, canonical: 0 });
  const list = await api(e, source, '/api/projects');
  assert.equal(list.response.status, 200);
  assert.match(list.response.headers.get('cache-control'), /public/);
  const alpha = list.body.projects.find((project) => project.id === 'alpha');
  assert.equal(alpha.evidenceCoverage.level, 'pinned_state');
  assert.equal(alpha.evidenceCoverage.label, 'Pinned contract state');
  assert.equal(alpha.coverage.observedDeployments, 1, 'Historical snapshots must not inflate deployment coverage.');
  assert.equal(alpha.coverage.runtimeFamilies,1);
  assert.equal(alpha.coverage.repeatedRuntimeFamilies,1);
  assert.equal(alpha.latestObservedAt, new Date(NOW).toISOString());
  const beta=list.body.projects.find((project) => project.id === 'beta');
  assert.equal(beta.coverage.observedDeployments, 0);
  assert.equal(beta.evidenceCoverage.level, 'linked_only');
  assert.equal(list.body.projects.find((project) => project.id === 'gamma').evidenceCoverage.level, 'directory_only');
  const detail = await api(e, source, '/api/projects/alpha');
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.observations.length, 1);
  assert.equal(detail.body.observations[0].id, 'latest');
  assert.equal(detail.body.observations[0].fields.owner, null);
  assert.equal(detail.body.events.length, 1);
  assert.equal(detail.body.events[0].evidence.fromBlock, 100);
  assert.equal(detail.body.runtimeFamilies.length,1);
  assert.equal(detail.body.runtimeFamilies[0].deploymentCount,2);
  assert.equal(detail.body.runtimeFamilies[0].relatedProjects[0].id,'beta');
  assert.match(detail.body.runtimeFamilies[0].evidence.scope,/not proof of affiliation/);
  assert.equal(detail.body.related[0].id, 'beta');
  assert.match(detail.body.related[0].reason, /not deployment affiliation/);
  const activity = await api(e, source, '/api/project-activity');
  assert.equal(activity.body.schemaVersion,3);
  assert.equal(activity.body.events.length, 2);
  assert.equal(activity.body.events[0].signalType,'configuration_change');
  assert.equal(activity.body.filters.focus,'important');
  assert.equal((await api(e,source,'/api/project-activity?signal=configuration_change')).body.events.length,2);
  assert.equal((await api(e,source,'/api/project-activity?signal=factory_launch')).body.events.length,0);
  assert.equal((await api(e, source, '/api/project-activity?focus=outcome')).body.events.length,0);
  assert.equal((await api(e, source, '/api/project-activity?focus=configuration&history=current')).body.events.length,2);
  assert.equal((await api(e, source, '/api/project-activity?project=alpha')).body.events.length, 1);
  const comparison = await api(e, source, '/api/project-comparison?ids=alpha,beta');
  assert.equal(comparison.response.status, 200);
  assert.equal(comparison.body.projects.length, 2);
  assert.match(comparison.body.comparisonScope, /Not normalized performance/);
});

test('HTTP missing projects, invalid comparisons, methods, and unrelated paths fail clearly', async () => {
  const e = env(), source = assets();
  for (const path of ['/api/projects/missing', '/api/project-activity?project=missing']) assert.equal((await api(e, source, path)).response.status, 404);
  for (const path of ['/api/project-activity?focus=nope','/api/project-activity?history=future','/api/project-activity?signal=nope']) assert.equal((await api(e,source,path)).response.status,400);
  for (const path of ['/api/project-comparison?ids=alpha', '/api/project-comparison?ids=alpha,missing', '/api/project-comparison?ids=alpha,alpha']) assert.equal((await api(e, source, path)).response.status, 400);
  for (const path of ['/api/projects', '/api/projects/alpha', '/api/project-activity', '/api/project-comparison']) assert.equal((await api(e, source, path, { method: 'POST', body: {} })).response.status, 405);
  assert.equal((await api(e, source, '/api/elsewhere')).response, null);
  const down = await api({ DB: { prepare() { return { all: async () => { throw Error('Database details must not be public'); } }; }, batch: async () => [] } }, source, '/api/projects');
  assert.equal(down.response.status, 503);
  assert.doesNotMatch(JSON.stringify(down.body), /Database details/);
});

test('HTTP receipt authentication, no query credentials, private headers, and agent-only review', async () => {
  const e = env(), source = assets();
  const created = await api(e, source, '/api/project-submissions', { method: 'POST', body: projectSubmission() });
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(created.body.status, 'pending_review');
  const path = `/api/project-submissions/${created.body.id}`;
  assert.equal((await api(e, source, path)).response.status, 404);
  assert.equal((await api(e, source, path, { token: 'b'.repeat(43) })).response.status, 404);
  assert.equal((await api(e, source, `${path}?receiptToken=${created.body.receiptToken}`)).response.status, 400);
  const status = await api(e, source, path, { token: created.body.receiptToken });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.id, created.body.id);
  for (const key of ['contact', 'payload', 'receiptToken', 'capability_hash', 'actor_key', 'telegram_user_id']) assert.equal(key in status.body, false);
  assert.equal((await api(e, source, '/api/project-submissions')).response.status, 404);
  assert.equal((await api(e, source, '/api/project-submissions/review-queue')).response.status, 403);
  assert.equal((await api(e, source, '/api/project-submissions/review-queue', { token: created.body.receiptToken })).response.status, 403);
  const queue = await api(e, source, '/api/project-submissions/review-queue', { token: REVIEW_TOKEN });
  assert.equal(queue.response.status, 200);
  assert.equal(queue.body.submissions[0].payload.contact, '@mechanism_team');
  assert.equal((await api(e, source, path + '/review', { method: 'POST', token: created.body.receiptToken, body: { decision: 'approve', reason: 'Self approval', proofUrl: 'https://new-mechanism.org/' } })).response.status, 403);
});

test('approved new projects appear in public lists and async context without promoting submitted contract affiliations', async () => {
  const e = env(), source = assets();
  const submitted = await submitAndApprove(e, source);
  const list = await api(e, source, '/api/projects');
  const project = list.body.projects.find((item) => item.id === submitted.projectId);
  assert(project, 'Approved project must appear in public registry.');
  assert.equal(project.metadataProvenance, 'community-reviewed');
  assert.deepEqual(project.deployments, [], 'Submitted contract addresses must not turn into proven affiliation.');
  assert.equal(project.coverage.observedDeployments, 0);
  assert.equal((await projectContext(source, e).getProject(submitted.projectId)).name, 'New Mechanism');
  const publicText = JSON.stringify(list.body);
  assert.doesNotMatch(publicText, /mechanism_team|receiptToken|capability_hash|authenticated-review-agent/);
  assert.equal(publicText.includes(submitted.receiptToken), false);
});

test('agent-approved domains remain canonical after owner-authored profile updates', async () => {
  const e = env(), source = assets();
  const submitted = await submitAndApprove(e, source);
  const context = projectContext(source, e);
  const authority = await context.getCanonicalProject(submitted.projectId);
  assert.equal(authority.website, 'https://new-mechanism.org/');
  assert.equal(authority.provenance, 'agent-reviewed canonical domain');
  const claim = await api(e, source, '/api/project-submissions', { method: 'POST', body: { kind: 'claim', projectId: submitted.projectId, agreement: true } });
  assert.equal(claim.response.status, 201, JSON.stringify(claim.body));
  assert.equal(claim.body.verification.name, '_hookline.new-mechanism.org');
  const verified = await withDns(claim.body.verification.name, claim.body.verification.value, () => api(e, source, `/api/project-submissions/${claim.body.id}/verify`, { method: 'POST', token: claim.body.receiptToken }));
  assert.equal(verified.response.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.status, 'verified_owner');
  const updated = await api(e, source, `/api/project-submissions/${claim.body.id}/metadata`, { method: 'POST', token: claim.body.receiptToken, body: { name: 'New Mechanism Updated', website: 'https://www.new-mechanism.org/team', description: 'Owner-authored copy, not a source of contract affiliation.', agreement: true } });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.status, 'approved');
  assert.equal((await context.getCanonicalProject(submitted.projectId)).website, 'https://new-mechanism.org/');
  const migrated = await api(e, source, `/api/project-submissions/${claim.body.id}/metadata`, { method: 'POST', token: claim.body.receiptToken, body: { website: 'https://different-controller.org/', agreement: true } });
  assert.equal(migrated.response.status, 422);
  assert.equal(migrated.body.error.code, 'domain_change_requires_review');
  const another = await api(e, source, '/api/project-submissions', { method: 'POST', body: { kind: 'claim', projectId: submitted.projectId, agreement: true } });
  assert.equal(another.body.verification.name, '_hookline.new-mechanism.org');
  assert.equal((await api(e, source, `/api/project-submissions/${claim.body.id}`, { token: claim.body.receiptToken })).body.status, 'verified_owner', 'Metadata update receipt must not revoke the original claim capability.');
});

test('Telegram directory, profile, deep links, follows, unfollows, and callback use shared project services', async () => {
  const e = env(), source = assets(), bot = telegram(e, source);
  await addObservation(e, { id: 'tg-observed', blockNumber: 120 });
  const directory = await bot.send('projects');
  assert.match(directory.text, /Alpha Hooks,/);
  assert(directory.options.reply_markup.inline_keyboard.flat().some(button=>button.text==='Alpha Hooks' && button.callback_data==='pr:view:alpha'));
  await handleProjectCallback(bot.client,{id:'directory-details',data:'pr:view:alpha',from:{id:'12345'},message:{message_id:10,chat:{id:'12345'}}},bot.ctx,'12345');
  assert.match(bot.replies.at(-1).text,/1 linked deployments, 1 with saved direct observations/);
  const profile = await bot.send('project', 'alpha');
  assert.match(profile.text, /1 linked deployments, 1 with saved direct observations/);
  assert.match(profile.text, /chain 1, block 120/);
  assert.equal(profile.options.reply_markup.inline_keyboard[1][0].callback_data, 'project_follow:alpha');
  assert.match((await bot.send('start', 'project_alpha')).text, /Alpha Hooks/);
  assert.match((await bot.send('project', 'missing')).text, /not found/);
  assert.match((await bot.send('follow', 'alpha')).text, /Following Alpha Hooks/);
  assert.match((await bot.send('following')).text, /\/project alpha/);
  const paused=await bot.send('unfollow', 'alpha');
  assert.match(paused.text,/Paused Alpha Hooks/);
  assert(paused.options.reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='pr:on:alpha'));
  assert.match((await bot.send('following')).text, /No project follows/);
  const callback = await handleProjectCallback(bot.client, { id: 'callback-1', data: 'project_follow:beta', message: { chat: { id: '12345' } } }, bot.ctx, '12345');
  assert.equal(callback.handled, true);
  assert.deepEqual(bot.answers, ['directory-details','callback-1']);
  assert.match(bot.replies.at(-1).text, /Following Beta Hooks/);
  assert.equal((await e.DB.prepare('SELECT enabled FROM project_follows WHERE project_id=?').bind('beta').first()).enabled, 1);
});

test('Telegram claim prints actual DNS name/value and can verify via the same private actor', async () => {
  const e = env(), source = assets(), bot = telegram(e, source);
  const claim = await bot.send('claim', 'alpha');
  const requestId = claim.text.match(/Claim request ([a-f0-9-]{36})/)?.[1];
  const name = claim.text.match(/^Name: (.+)$/m)?.[1];
  const value = claim.text.match(/^Value: (.+)$/m)?.[1];
  assert(requestId);
  assert.equal(name, '_hookline.alpha-hooks.org');
  assert.match(value, new RegExp(`^hookline-verification=alpha:${requestId}:[A-Za-z0-9_-]{43}$`));
  assert(claim.options.reply_markup.inline_keyboard.flat().some(button=>button.text==='Check DNS verification' && button.callback_data===`pr:verify:${requestId}`));
  assert.match(claim.text, /not a contract safety endorsement/);
  const row = await e.DB.prepare('SELECT * FROM project_submissions WHERE id=?').bind(requestId).first();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(row.challenge_hash, digest, 'Printed DNS value must be the challenge persisted by the contribution service.');
  assert.equal(row.telegram_user_id, '12345');
  await withDns(name,value,()=>handleProjectCallback(bot.client,{id:'verify-claim',data:`pr:verify:${requestId}`,from:{id:'12345'},message:{message_id:11,chat:{id:'12345'}}},bot.ctx,'12345'));
  const verified=bot.replies.at(-1);
  assert.match(verified.text, /verified_owner/);
  const status = await getContributionStatus(e, requestId, { telegramUserId: '12345', chatId: '12345' });
  assert.equal(status.proof.scope, 'project_metadata_only');
});

test('Telegram requests are isolated by private actor and duplicate deliveries do not duplicate submissions', async () => {
  const e = env(), source = assets(), bot = telegram(e, source);
  const submitted = await bot.send('submitproject', 'First project | https://first-project.org | A public mechanism description', '12345', '12345', 777);
  const firstId = submitted.text.match(/Project submitted: ([a-f0-9-]{36})/)?.[1];
  assert(firstId);
  const duplicate = await bot.send('submitproject', 'First project | https://first-project.org | A public mechanism description', '12345', '12345', 777);
  assert.match(duplicate.text, new RegExp(firstId));
  assert.equal(await count(e, 'project_submissions'), 1);
  const suggestion = await bot.send('suggest', 'alpha | Updated documentation at https://alpha-hooks.org/docs', '67890');
  const secondId = suggestion.text.match(/Suggestion received: ([a-f0-9-]{36})/)?.[1];
  assert(secondId);
  const firstUser = (await bot.send('myrequests', '', '12345')).text;
  assert(firstUser.includes(firstId)); assert(!firstUser.includes(secondId));
  const secondUser = (await bot.send('myrequests', '', '67890')).text;
  assert(secondUser.includes(secondId)); assert(!secondUser.includes(firstId));
  assert.match((await bot.send('myrequests', '', '99999')).text, /no project requests/);
  assert.doesNotMatch(firstUser + secondUser, /receiptToken|capability_hash|actor_key|@/);
});

test('Telegram group chats cannot create submissions, claims, follows, or inspect private requests', async () => {
  const e = env(), source = assets(), bot = telegram(e, source);
  const cases = [['submitproject', 'No group | https://no-group.org | Should never be persisted'], ['suggest', 'alpha | This must not be saved'], ['claim', 'alpha'], ['follow', 'alpha'], ['myrequests', ''], ['following', ''], ['verifyclaim', crypto.randomUUID()]];
  for (const [command, args] of cases) {
    const response = await bot.send(command, args, '12345', '-10098765');
    assert.match(response.text, /private chat|privately|private conversation/, `${command}: ${response.text}`);
  }
  assert.equal(await count(e, 'project_submissions'), 0);
  assert.equal(await count(e, 'project_follows'), 0);
  const callback = await handleProjectCallback(bot.client, { id: 'group-callback', data: 'project_follow:alpha', message: { chat: { id: '-10098765' } } }, bot.ctx, '12345');
  assert.equal(callback.handled, true);
  assert.equal(callback.reason,'private_chat_required');
  assert.equal(bot.answers.at(-1),'group-callback');
  assert.equal(await count(e, 'project_follows'), 0);
});

let failed = 0;
try {
  for (const [name, run] of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
} finally { globalThis.fetch = originalFetch; }
if (failed) { console.error(`${failed}/${tests.length} Projects API/Telegram integration tests failed.`); process.exitCode = 1; }
else console.log(`Projects API/Telegram: ${tests.length} real-SQLite integration tests passed without network access.`);
