import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Small DOM harness tests the production renderers without browser-only dependencies.
// Browser layout/accessibility are verified separately against the running preview.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.hidden = false;
    this.dataset = {}; this.attributes = new Map(); this.handlers = new Map();
    this.classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child?.textContent || '').join(''); }
  get options() { return this.children.filter((child) => child?.tagName === 'OPTION'); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => [id, new Element(tag)]));
const storage = new Map();
const document = { readyState: 'loading', body: new Element('body'), createElement: (tag) => new Element(tag), getElementById: (id) => nodes.get(id), addEventListener: () => {}, querySelectorAll: () => [] };
let fetcher = async () => { throw new Error('Unexpected network request'); };
const context = vm.createContext({ document, window: {}, location: { hash: '#/projects', origin: 'https://hookline.world' }, URL, URLSearchParams, AbortSignal, Date, setTimeout, clearTimeout, console,
  sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  fetch: (...args) => fetcher(...args),
});
const exports = ['state', 'projectExternalLink', 'projectValue', 'projectCount', 'projectTime', 'renderProjectsBoard', 'syncProjectFilters', 'renderProjectDetail', 'renderProjectObservations', 'renderProjectEvent', 'renderHookProjectLinks', 'renderProjectsRoute', 'renderProjectReceipts', 'loadProjectReceipts', 'saveProjectReceipts', 'updateProjectReceipt', 'projectApi', 'validProjectCompareIds', 'setProjectCompareIds', 'toggleProjectCompare', 'renderProjectCompareTray', 'renderProjectComparison', 'loadProjectComparison', 'renderProjectActivitySummary'];
vm.runInContext(source.replace('  window.Hookline = {', `  window.__ProjectsTest = {${exports.join(',')}};\n  window.Hookline = {`), context);
const ui = context.window.__ProjectsTest;
const address = '0x' + '1'.repeat(40);
const other = '0x' + '2'.repeat(40);
const tx = '0x' + 'a'.repeat(64);
const project = { id: 'alpha', name: 'Alpha Hooks', summary: 'A sourced ecosystem project', category: 'Dynamic fees', website: 'https://alpha.example', provenance: 'researched project record', sources: [{ label: 'Docs', url: 'https://alpha.example/docs' }], deployments: [{ chainId: 1, address, role: 'hook', name: 'Alpha hook', provenance: 'official deployment reference', sourceUrl: 'https://alpha.example/docs', pools: null, swaps: null }], coverage: { linkedDeployments: 1, monitoredDeployments: 1, observedDeployments: 0, runtimeFamilies: 1 }, evidenceCoverage: { level: 'source_bound', label: 'Source-bound reader', sourceBoundDeployments: 1, readTypes: 2, eventTypes: 3, readerVersion: 1 } };
const second = { ...project, id: 'beta', name: '<script>Beta</script>', category: 'Rewards', deployments: [{ ...project.deployments[0], chainId: 8453, address: other }], coverage: { linkedDeployments: 1, monitoredDeployments: 1, observedDeployments: 1 }, evidenceCoverage: { level: 'directory_only', label: 'Directory record', sourceBoundDeployments: 0, readTypes: 0, eventTypes: 0, readerVersion: null } };
ui.state.projects.registry = { schemaVersion: 1, generatedAt: new Date().toISOString(), projects: [project, second] };
for (const id of ['projects-category', 'projects-chain', 'projects-evidence', 'project-activity-filter', 'project-activity-signal']) nodes.get(id).value = 'all';
nodes.get('project-activity-focus').value='important';nodes.get('project-activity-history').value='all';
nodes.get('projects-sort').value = 'name';
ui.syncProjectFilters();

assert.equal(ui.projectExternalLink('javascript:alert(1)', 'Unsafe'), null);
assert.equal(ui.projectExternalLink('http://alpha.example', 'Insecure'), null);
assert.equal(ui.projectExternalLink('https://user:pass@alpha.example', 'Credentials'), null);
assert.equal(ui.projectExternalLink('https://alpha.example', 'Safe').rel, 'noopener noreferrer');
assert.equal(ui.projectValue(null), 'Unavailable');
assert.equal(ui.projectValue(0), '0');
assert.equal(ui.projectValue('1500', {unit:'ppm',basis:'gross ETH'}), '0.15% (1500 ppm) · gross ETH');
assert.equal(ui.projectValue('0', {unit:'ppm'}), '0% (0 ppm)');
assert.equal(ui.projectValue('0x' + '0'.repeat(40), { zeroLabel: 'Default model' }), 'Default model');
assert.equal(ui.projectCount({ coverage: { monitoredDeployments: 10 } }, 'observedDeployments'), null, 'Scheduled targets must not masquerade as observed coverage.');
assert.equal(ui.projectTime(null), null);

ui.renderProjectsBoard();
assert.equal(nodes.get('projects-list').children.length, 2);
assert.match(nodes.get('projects-list').textContent, /Observed deployments/);
assert.match(nodes.get('projects-list').textContent, /Source-bound reader/);
nodes.get('projects-search').value = other;
ui.renderProjectsBoard();
assert.equal(nodes.get('projects-list').children.length, 1, 'Address search links back to the owning project record.');
assert.match(nodes.get('projects-list').textContent, /<script>Beta<\/script>/, 'Untrusted names remain literal text.');
nodes.get('projects-search').value = '';
nodes.get('projects-chain').value = '1';
ui.renderProjectsBoard();
assert.equal(nodes.get('projects-list').children.length, 1);
assert.match(nodes.get('projects-list').textContent, /Alpha Hooks/);
nodes.get('projects-chain').value = 'all';
nodes.get('projects-category').value = 'Rewards';
ui.renderProjectsBoard();
assert.equal(nodes.get('projects-list').children.length, 1);
nodes.get('projects-category').value = 'all';
nodes.get('projects-evidence').value = 'source_bound';
ui.renderProjectsBoard();
assert.equal(nodes.get('projects-list').children.length, 1);
assert.match(nodes.get('projects-list').textContent, /Alpha Hooks/);
nodes.get('projects-evidence').value = 'directory_only';
ui.renderProjectsBoard();
assert.equal(nodes.get('projects-list').children.length, 1);
assert.match(nodes.get('projects-list').textContent, /<script>Beta<\/script>/);
nodes.get('projects-evidence').value = 'all';

const observation = { chainId: 1, address, blockNumber: 100, blockHash: tx, observedAt: new Date().toISOString(), source: 'Hookline direct chain RPC', fields: { owner: null, implementation: '0x' + '0'.repeat(40), runtimeFingerprint: 'f'.repeat(64), fee: 0 }, probes: { owner: { status: 'unavailable' } }, fieldMeta: { implementation: { label: 'Implementation', zeroLabel: 'No implementation in slot' }, fee: { label: 'Configured fee', classification: 'configuration', unit: 'bps' } } };
const observed = ui.renderProjectObservations([observation]);
assert.match(observed.textContent, /Unavailable/);
assert.match(observed.textContent, /No implementation in slot/);
assert.match(observed.textContent, /0 bps/);
assert.match(observed.textContent, /Block 100/);
const event = { id: 'event1', projectId: 'alpha', projectName: 'Alpha', chainId: 1, address, observedAt: new Date().toISOString(), kind: 'observed_change', title: 'Fee changed', signalType:'fee_configuration_change', classification:'configuration', before: 0, after: 20, evidence: { scope: 'between pinned observations', fromBlock: 100, toBlock: 120, backfill:true } };
const change = ui.renderProjectEvent(event);
assert.match(change.textContent, /blocks 100 to 120/);
assert.match(change.textContent,/fee configuration/);
assert.match(change.textContent,/historical backfill/);
assert.doesNotMatch(change.textContent, /Transaction /);
const transaction = ui.renderProjectEvent({ ...event, transactionHash: tx, evidence: { scope: 'contract event' } });
assert.match(transaction.textContent, /Transaction /);
ui.state.projects.activitySummary={totalEvents:717,activeProjects:3,complete:true,signals:{factory_launch:696,implementation_change:5,fee_configuration_change:0,runtime_change:0,configuration_change:0,outcome:16},projects:[{projectId:'alpha',projectName:'Alpha Hooks',totalEvents:588},{projectId:'beta',projectName:'<script>Beta</script>',totalEvents:124}]};
ui.renderProjectActivitySummary();
assert.equal(nodes.get('project-activity-summary').hidden,false);
assert.match(nodes.get('project-activity-summary').textContent,/696Factory launches/);
assert.match(nodes.get('project-activity-summary').textContent,/5Implementation changes/);
assert.match(nodes.get('project-activity-summary').textContent,/717 monitored records/);
assert.match(nodes.get('project-activity-summary').textContent,/<script>Beta<\/script> 124/,'Untrusted summary names remain literal text.');

ui.state.board = { items: [{ chainId: 1, address }] };
ui.renderProjectDetail({ project, observations: [observation], events: [event], runtimeFamilies:[{runtimeFingerprint:'f'.repeat(64),codeByteLength:42,deploymentCount:2,chainIds:[1,8453],projectDeployments:[{chainId:1,address,name:'Alpha hook'}],otherDeployments:[{chainId:8453,address:other,name:'Second hook'}],relatedProjects:[{id:'beta',name:'Beta Hooks'}],evidence:{generatedAt:new Date().toISOString()}}], related: [{ ...second, reason: 'Shared mechanism category' }] });
assert.match(nodes.get('project-detail').textContent, /not proof of affiliation/);
assert.match(nodes.get('project-detail').textContent,/2 exact deployments/);
assert.match(nodes.get('project-detail').textContent,/Follow runtime family/);
assert.match(nodes.get('project-detail').textContent,/Also linked toBeta Hooks/);
assert.match(nodes.get('project-detail').textContent, /Open hook profile/);
assert.match(nodes.get('project-detail').textContent, /2 read types · 3 event types/);
assert.doesNotMatch(nodes.get('project-detail').textContent, /0 pools|0 swaps/, 'Null counts must not become zero.');
ui.renderHookProjectLinks({ chainId: 1, address });
assert.equal(nodes.get('hook-profile-project-directory').hidden, false);
ui.renderHookProjectLinks({ chainId: 8453, address });
assert.equal(nodes.get('hook-profile-project-directory').hidden, true, 'Project relationships must be chain-aware.');

// Rapid navigation must not let a slow prior response overwrite the next profile.
let releaseFirst;
fetcher = async (url) => url.endsWith('/alpha') ? new Promise((resolve) => { releaseFirst = resolve; }) : { ok: true, json: async () => ({ project: second, observations: [], events: [], related: [] }) };
context.location.hash = '#/projects/alpha';
const slow = ui.renderProjectsRoute();
context.location.hash = '#/projects/beta';
await ui.renderProjectsRoute();
releaseFirst({ ok: true, json: async () => ({ project, observations: [], events: [], related: [] }) });
await slow;
assert.match(nodes.get('project-detail').textContent, /<script>Beta<\/script>/);
assert.doesNotMatch(nodes.get('project-detail').textContent, /Alpha Hooks/);

// Comparison selection is bounded, restores from shareable routes, preserves
// unavailable values, and never lets an older response overwrite a newer one.
const third = { ...project, id: 'gamma', name: 'Gamma', category: 'Auctions', deployments: [], coverage: { linkedDeployments: 0, monitoredDeployments: null, observedDeployments: null, runtimeFamilies: null, repeatedRuntimeFamilies: null }, evidenceCoverage: { level: 'directory_only', label: 'Directory record', sourceBoundDeployments: 0, readTypes: null, eventTypes: null, readerVersion: null } };
const fourth = { ...third, id: 'delta', name: 'Delta' };
const fifth = { ...third, id: 'epsilon', name: 'Epsilon' };
ui.state.projects.registry.projects = [project, second, third, fourth, fifth];
assert.equal(ui.validProjectCompareIds(['alpha', 'beta', 'gamma', 'delta', 'epsilon']).join(','), 'alpha,beta,gamma,delta', 'Comparison selection is capped at four known projects.');
ui.setProjectCompareIds(['alpha', 'beta']);
assert.equal(nodes.get('projects-compare-tray').hidden, false);
assert.match(nodes.get('projects-compare-chips').textContent, /Alpha Hooks/);
assert.match(nodes.get('projects-compare-chips').textContent, /<script>Beta<\/script>/, 'Untrusted project names stay literal in comparison controls.');
assert.equal(nodes.get('projects-compare-open').disabled, false);

ui.renderProjectComparison({ projects: [{ project, observations: [observation] }, { project: third, observations: [] }] });
assert.match(nodes.get('projects-comparison-grid').textContent, /Alpha Hooks/);
assert.match(nodes.get('projects-comparison-grid').textContent, /Block 100/);
assert.match(nodes.get('projects-comparison-grid').textContent, /Hookline direct chain RPC/);
assert.match(nodes.get('projects-comparison-grid').textContent, /Unavailable/, 'Missing comparison metrics remain unavailable rather than becoming zero.');

fetcher = async (url) => {
  assert.match(url, /\/api\/project-comparison\?ids=alpha%2Cbeta/);
  return { ok: true, json: async () => ({ projects: [{ project, observations: [observation] }, { project: second, observations: [] }] }) };
};
context.location.hash = '#/projects/compare/alpha,beta,unknown';
await ui.renderProjectsRoute();
assert.equal(ui.state.projects.compareIds.join(','), 'alpha,beta', 'Unknown route IDs are ignored without breaking the board.');
assert.equal(nodes.get('projects-comparison').hidden, false);

let releaseComparison;
fetcher = async (url) => url.includes('alpha%2Cbeta')
  ? new Promise((resolve) => { releaseComparison = resolve; })
  : { ok: true, json: async () => ({ projects: [{ project: second, observations: [] }, { project: third, observations: [] }] }) };
const slowComparison = ui.loadProjectComparison(['alpha', 'beta']);
await ui.loadProjectComparison(['beta', 'gamma']);
releaseComparison({ ok: true, json: async () => ({ projects: [{ project, observations: [observation] }, { project: second, observations: [] }] }) });
await slowComparison;
assert.match(nodes.get('projects-comparison-grid').textContent, /Gamma/);
assert.doesNotMatch(nodes.get('projects-comparison-grid').textContent, /Alpha Hooks/, 'A stale comparison cannot replace the newer selection.');
context.location.hash = '#/projects/beta';

// Receipt capabilities stay in headers/session storage, never public URLs or text.
const receipt = { id: 'request-1', kind: 'claim', projectId: 'alpha', title: 'Alpha', status: 'awaiting_proof', receiptToken: 'PRIVATE-CAPABILITY', verification: { name: '_hookline.alpha.example', value: 'proof-value', expiresAt: '2026-10-07T22:00:00Z' } };
ui.state.projects.receipts = [receipt];
fetcher = async (url, options) => {
  assert.equal(url, '/api/project-submissions/request-1');
  assert.equal(options.headers.Authorization, 'Bearer PRIVATE-CAPABILITY');
  return { ok: true, json: async () => ({ id: receipt.id, status: 'awaiting_proof', verification: { name: receipt.verification.name, expiresAt: receipt.verification.expiresAt } }) };
};
await ui.updateProjectReceipt(receipt);
assert.equal(receipt.verification.value, 'proof-value', 'Private status reads must preserve the current challenge value.');
assert.doesNotMatch(nodes.get('project-request-receipts').textContent, /PRIVATE-CAPABILITY/);
receipt.busy = true;
ui.saveProjectReceipts();
ui.loadProjectReceipts();
assert.equal(ui.state.projects.receipts[0].busy, undefined, 'Do not persist transient loading locks.');
assert.equal(context.location.hash, '#/projects/beta');
assert.equal(storage.size, 1);

for (const id of [...source.matchAll(/\$\('(project[^']*)'\)/g)].map((match) => match[1])) assert(nodes.has(id), `Missing HTML mount: ${id}`);
assert.doesNotMatch(source.slice(source.indexOf('// Project metadata,'), source.indexOf('  function viewFromHash()')), /\.innerHTML\s*=/, 'Projects must render untrusted metadata with text nodes.');
console.log('Projects UI: safe rendering, filters, chain-aware relationships, evidence semantics, stale responses, and private receipts passed.');
