import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor() { this.children = []; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map((value) => typeof value === 'string' ? value : value.textContent).join(' '); }
  addEventListener() {}
}
const nodes = new Map(['hook-profile-markets', 'hook-profile-market-list', 'hook-profile-market-status'].map((id) => [id, new Element()]));
const source = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
const context = vm.createContext({ document: { readyState: 'loading', addEventListener() {}, getElementById: (id) => nodes.get(id), createElement: () => new Element() }, window: {}, Date, URL });
vm.runInContext(source.replace('  window.Hookline = {', '  window.__FeeTest = {poolFeePresentation,poolDisplayName,renderBoardMarkets,state};\n  window.Hookline = {'), context);
const ui = context.window.__FeeTest;
for (const input of [{ poolKey: { fee: 0x800000 } }, { feeTier: '0x800000' }, { advertisedFeeUnits: 8388608 },
  { advertisedFeePercent: 838.8608 }, { poolName: 'ETH / ASSET - 838.8608%' }, { feeMode: 'dynamic', advertisedFeePercent: null }]) {
  const fee = ui.poolFeePresentation(input); assert.equal(fee.kind, 'dynamic'); assert.equal(fee.label, 'Dynamic'); assert.match(fee.detail, /current LP fee has not been measured/);
}
for (const [units, label] of [[0, '0% advertised'], [1, '0.0001% advertised'], [100, '0.01% advertised'], [500, '0.05% advertised'], [3000, '0.3% advertised'], [10000, '1% advertised'], [999999, '99.9999% advertised'], [1000000, '100% advertised']]) {
  const fee = ui.poolFeePresentation({ feeTier: units }); assert.equal(fee.kind, 'static'); assert.equal(fee.label, label);
}
assert.equal(ui.poolFeePresentation({ feeMode: 'static', advertisedFeePercent: 0 }).label, '0% advertised');
assert.equal(ui.poolFeePresentation({ advertisedFeePercent: 0.3 }).label, '0.3% advertised');
assert.equal(ui.poolFeePresentation({ poolName: 'ETH / ASSET - 0.3%' }).label, '0.3% advertised');
for (const input of [{ feeTier: 0x400000 }, { feeTier: 0x800001 }, { feeTier: 0xc00000 }, { feeTier: 1000001 },
  { feeTier: 0x1000000 }, { feeTier: -1 }, { feeTier: 1.5 }, { feeTier: 'bogus' }, { feeTier: false },
  { advertisedFeePercent: 838.8609 }, { advertisedFeePercent: 838.86080000001 }, { advertisedFeePercent: 101 },
  { advertisedFeePercent: -1 }, { advertisedFeePercent: '' }, { advertisedFeePercent: false }, { advertisedFeePercent: Infinity },
  { feeMode: 'static', advertisedFeePercent: 838.8608 }, { feeMode: 'invalid', advertisedFeePercent: null }]) assert.equal(ui.poolFeePresentation(input).kind, 'invalid', JSON.stringify(input));
for (const input of [null, {}, { advertisedFeePercent: null }, { feeMode: 'unavailable', advertisedFeePercent: null }]) assert.equal(ui.poolFeePresentation(input).kind, 'unavailable');
assert.equal(ui.poolDisplayName('ETH / ASSET - 838.8608%'), 'ETH / ASSET');
assert.equal(ui.poolDisplayName('ETH / ASSET - 999%'), 'ETH / ASSET');
assert.equal(ui.poolDisplayName('ETH / ASSET'), 'ETH / ASSET');

const item = { id: '8453_hook', chainId: 8453, address: '0x' + '1'.repeat(40) };
ui.state.boardEvidence.set(item.id, { marketObservedAt: Date.now(), markets: [
  { poolName: 'ETH / DYNAMIC - 838.8608%', advertisedFeePercent: 838.8608 },
  { poolName: 'ETH / STATIC - 0.3%', advertisedFeePercent: 0.3 },
  { poolName: 'ETH / INVALID - 999%', advertisedFeePercent: 999 },
  { poolName: 'ETH / UNKNOWN', advertisedFeePercent: null },
] });
ui.renderBoardMarkets(item);
const rendered = nodes.get('hook-profile-market-list').textContent;
assert.doesNotMatch(rendered, /838\.8608%|999%/);
assert.match(rendered, /POOL FEE Dynamic/); assert.match(rendered, /0\.3% advertised/); assert.match(rendered, /POOL FEE Invalid/); assert.match(rendered, /POOL FEE Unavailable/);
console.log('Pool fee UI: exact dynamic sentinel, valid static units, invalid flags/ranges, unavailable versus zero, canonical metadata, legacy cache, and rendered card titles passed.');
