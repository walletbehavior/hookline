import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {
  defaultTradingPreferences, loadTradingPreferences, saveTradingPreferences,
  validateTradingPreferencesPatch, TradingPreferencesError, TRADING_PREFERENCES_MAX_BYTES,
} from '../bot/trading-preferences.js';

class D1 {
  constructor({migrate=true}={}) {
    this.sqlite=new DatabaseSync(':memory:');this.calls=0;
    if(migrate) this.sqlite.exec(readFileSync(new URL('../drizzle/0004_trading_preferences.sql',import.meta.url),'utf8'));
  }
  prepare(sql) {
    this.calls++;const db=this;let args=[];
    const statement={bind(...values){args=values;return statement;},
      async first(){return db.sqlite.prepare(sql).get(...args)||null;},
      async all(){return{results:db.sqlite.prepare(sql).all(...args)};},
      async run(){const result=db.sqlite.prepare(sql).run(...args);return{meta:{changes:Number(result.changes)}};},
    };return statement;
  }
}
const env=()=>({DB:new D1()});
const actor={userId:'12345',chatId:'12345'};
const other={userId:'99999',chatId:'99999'};
const NOW=Date.parse('2026-10-07T21:00:00Z');
const validProfile={name:'Balanced',takeProfitPercent:50,stopLossPercent:20,trailingStopPercent:10};
async function rejectsCode(fn,code){await assert.rejects(fn,error=>error instanceof TradingPreferencesError&&error.code===code,code);}
function count(e){return e.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM trading_preferences').get().n;}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('defaults are exact, unsaved, fresh copies with no implied active orders',async()=>{
  const e=env();const result=await loadTradingPreferences(e,actor);
  assert.deepEqual(result,{preferences:{slippageBps:50,buyAmounts:['0.01','0.05','0.1','0.5'],sellPercentages:[25,50,75,100],priorityFeeGwei:null,tpSlProfiles:[]},revision:0,updatedAt:null,configurationOnly:true});
  assert.equal(count(e),0);result.preferences.buyAmounts[0]='999';
  assert.equal(defaultTradingPreferences().buyAmounts[0],'0.01');assert.equal((await loadTradingPreferences(e,actor)).preferences.buyAmounts[0],'0.01');
});
test('identity requires a positive exact private-chat match before any DB access',async()=>{
  const e=env();
  for(const identity of [
    {},{userId:'12345',chatId:'99999'},{userId:'12345',chatId:'-100123'},{userId:0,chatId:0},
    {userId:'0123',chatId:'0123'},{userId:'-1',chatId:'-1'},{userId:'abc',chatId:'abc'},
    {userId:true,chatId:true},{userId:1.5,chatId:1.5},{userId:Number.MAX_SAFE_INTEGER+1,chatId:Number.MAX_SAFE_INTEGER+1},
    {userId:'1'.repeat(21),chatId:'1'.repeat(21)},
  ]) {
    await rejectsCode(()=>loadTradingPreferences(e,identity),'private_chat_required');
    await rejectsCode(()=>saveTradingPreferences(e,{...identity,patch:{slippageBps:100}}),'private_chat_required');
  }
  assert.equal(e.DB.calls,0);
  assert.equal((await loadTradingPreferences(e,{userId:12345,chatId:'12345'})).revision,0);
  assert.equal((await loadTradingPreferences(e,{userId:'9007199254740993',chatId:'9007199254740993'})).revision,0);
});
test('valid preferences persist exact decimals without credentials or active-order state',async()=>{
  const e=env();const patch={slippageBps:125,buyAmounts:['0.000000000000000001','0.1000','100000'],sellPercentages:[1,33,100],priorityFeeGwei:'0.000000000000000001',tpSlProfiles:[validProfile]};
  const saved=await saveTradingPreferences(e,{...actor,patch});const loaded=await loadTradingPreferences(e,actor);
  assert.deepEqual(saved.preferences,patch);assert.deepEqual(loaded,saved);assert.equal(saved.revision,1);assert.equal(saved.configurationOnly,true);
  const row=e.DB.sqlite.prepare('SELECT * FROM trading_preferences').get();assert.match(row.preferences_json,/"0\.1000"/);assert.equal(row.telegram_user_id,actor.userId);assert.equal(row.chat_id,actor.chatId);
  assert.deepEqual(Object.keys(JSON.parse(row.preferences_json)).sort(),Object.keys(defaultTradingPreferences()).sort());
});
test('user isolation and partial merges preserve unrelated fields',async()=>{
  const e=env();await saveTradingPreferences(e,{...actor,patch:{slippageBps:200,buyAmounts:['0.20']}});
  await saveTradingPreferences(e,{...other,patch:{priorityFeeGwei:'1.2500'}});
  const update=await saveTradingPreferences(e,{...actor,patch:{sellPercentages:[10,100]}});
  assert.equal(update.revision,2);assert.equal(update.preferences.slippageBps,200);assert.deepEqual(update.preferences.buyAmounts,['0.20']);assert.equal(update.preferences.priorityFeeGwei,null);
  const independent=await loadTradingPreferences(e,other);assert.equal(independent.revision,1);assert.equal(independent.preferences.slippageBps,50);assert.equal(independent.preferences.priorityFeeGwei,'1.2500');assert.equal(count(e),2);
});
test('parallel disjoint patches are atomically merged and revisions never collide',async()=>{
  const e=env();const updates=await Promise.all([
    saveTradingPreferences(e,{...actor,patch:{slippageBps:100}}),
    saveTradingPreferences(e,{...actor,patch:{buyAmounts:['0.33']}}),
    saveTradingPreferences(e,{...actor,patch:{sellPercentages:[30,100]}}),
    saveTradingPreferences(e,{...actor,patch:{priorityFeeGwei:'2.2500'}}),
    saveTradingPreferences(e,{...actor,patch:{tpSlProfiles:[validProfile]}}),
  ]);
  assert.deepEqual(updates.map(x=>x.revision).sort((a,b)=>a-b),[1,2,3,4,5]);
  const saved=await loadTradingPreferences(e,actor);assert.equal(saved.revision,5);assert.deepEqual(saved.preferences,{slippageBps:100,buyAmounts:['0.33'],sellPercentages:[30,100],priorityFeeGwei:'2.2500',tpSlProfiles:[validProfile]});
});
test('concurrent burst uses one bounded row and atomic monotonic revisions',async()=>{
  const e=env();const results=await Promise.all(Array.from({length:100},(_,i)=>saveTradingPreferences(e,{...actor,patch:{priorityFeeGwei:String(i)}})));
  assert.equal(new Set(results.map(r=>r.revision)).size,100);assert.equal((await loadTradingPreferences(e,actor)).revision,100);assert.equal(count(e),1);
});
test('updated timestamp is monotonic and creation timestamp stays unchanged',async()=>{
  const e=env();const originalNow=Date.now;
  try {
    Date.now=()=>NOW;await saveTradingPreferences(e,{...actor,patch:{slippageBps:100}});
    Date.now=()=>NOW+1000;const second=await saveTradingPreferences(e,{...actor,patch:{slippageBps:200}});assert.equal(second.updatedAt,new Date(NOW+1000).toISOString());
    Date.now=()=>NOW-1000;const third=await saveTradingPreferences(e,{...actor,patch:{slippageBps:300}});assert.equal(third.updatedAt,new Date(NOW+1000).toISOString());
    assert.equal(e.DB.sqlite.prepare('SELECT created_at FROM trading_preferences').get().created_at,NOW);
  } finally {Date.now=originalNow;}
});
test('slippage matches executable quote bounds of integer 1 through 5000 basis points',async()=>{
  for(const value of [-1,0,5001,0.5,'50',null,undefined,NaN,Infinity,true]) await rejectsCode(async()=>validateTradingPreferencesPatch({slippageBps:value}),'invalid_slippage');
  assert.equal(validateTradingPreferencesPatch({slippageBps:1}).slippageBps,1);assert.equal(validateTradingPreferencesPatch({slippageBps:5000}).slippageBps,5000);
});
test('buy amounts reject malformed, rounded, zero, out-of-range, and duplicate values',async()=>{
  for(const amount of ['0','0.000','-1','+1','.1','1.','01.2','1e-2',' 1','1 ','100000.000000000000000001','1000000','0.1234567890123456789',0.1,NaN,null]) await rejectsCode(async()=>validateTradingPreferencesPatch({buyAmounts:[amount]}),'invalid_buy_amount');
  await rejectsCode(async()=>validateTradingPreferencesPatch({buyAmounts:['1','2','3','4','5']}),'invalid_buy_amounts');
  await rejectsCode(async()=>validateTradingPreferencesPatch({buyAmounts:'0.1'}),'invalid_buy_amounts');
  await rejectsCode(async()=>validateTradingPreferencesPatch({buyAmounts:['0.1','0.100']}),'duplicate_buy_amount');
  assert.deepEqual(validateTradingPreferencesPatch({buyAmounts:['100000.000000000000000000']}).buyAmounts,['100000.000000000000000000']);
});
test('priority fee is nullable exact decimal, bounded to 1000 gwei',async()=>{
  assert.equal(validateTradingPreferencesPatch({priorityFeeGwei:'0.000'}).priorityFeeGwei,'0.000');assert.equal(validateTradingPreferencesPatch({priorityFeeGwei:'1000.000000000000000000'}).priorityFeeGwei,'1000.000000000000000000');assert.equal(validateTradingPreferencesPatch({priorityFeeGwei:null}).priorityFeeGwei,null);
  for(const fee of ['1000.000000000000000001','1001','-1','1e2',1,undefined,' 1','00.1']) await rejectsCode(async()=>validateTradingPreferencesPatch({priorityFeeGwei:fee}),'invalid_priority_fee');
  const e=env();await saveTradingPreferences(e,{...actor,patch:{priorityFeeGwei:'2.00'}});await saveTradingPreferences(e,{...actor,patch:{priorityFeeGwei:null}});
  const stored=JSON.parse(e.DB.sqlite.prepare('SELECT preferences_json FROM trading_preferences').get().preferences_json);assert.equal(Object.hasOwn(stored,'priorityFeeGwei'),true);assert.equal(stored.priorityFeeGwei,null);
});
test('sell presets require unique bounded integer percentages',async()=>{
  for(const value of [0,101,-1,12.5,'25',null,NaN]) await rejectsCode(async()=>validateTradingPreferencesPatch({sellPercentages:[value]}),'invalid_sell_percentage');
  await rejectsCode(async()=>validateTradingPreferencesPatch({sellPercentages:[1,2,3,4,5]}),'invalid_sell_percentages');
  await rejectsCode(async()=>validateTradingPreferencesPatch({sellPercentages:[25,25]}),'duplicate_sell_percentage');
  assert.deepEqual(validateTradingPreferencesPatch({sellPercentages:[1,100]}).sellPercentages,[1,100]);
});
test('presets and profiles can be explicitly cleared without changing other preferences',async()=>{
  const e=env();await saveTradingPreferences(e,{...actor,patch:{slippageBps:100,tpSlProfiles:[validProfile]}});
  const result=await saveTradingPreferences(e,{...actor,patch:{buyAmounts:[],sellPercentages:[],tpSlProfiles:[]}});
  assert.equal(result.preferences.slippageBps,100);assert.deepEqual(result.preferences.buyAmounts,[]);assert.deepEqual(result.preferences.sellPercentages,[]);assert.deepEqual(result.preferences.tpSlProfiles,[]);
});
test('up to three named TP/SL configurations are saved without activation fields',async()=>{
  const e=env();const profiles=[validProfile,{name:'Conservative',takeProfitPercent:1,stopLossPercent:1},{name:'Custom',takeProfitPercent:10000,stopLossPercent:99,trailingStopPercent:99}];
  const result=await saveTradingPreferences(e,{...actor,patch:{tpSlProfiles:profiles}});assert.deepEqual(result.preferences.tpSlProfiles,profiles);assert.equal(result.configurationOnly,true);
  assert.equal(Object.hasOwn(result.preferences.tpSlProfiles[1],'trailingStopPercent'),false);
  await rejectsCode(async()=>validateTradingPreferencesPatch({tpSlProfiles:[...profiles,{...validProfile,name:'Fourth'}]}),'invalid_tp_sl_profiles');
  await rejectsCode(async()=>validateTradingPreferencesPatch({tpSlProfiles:[validProfile,{...validProfile,name:'BALANCED'}]}),'duplicate_profile_name');
});
test('TP/SL names and percentage fields reject malformed or privileged content',async()=>{
  for(const name of ['', ' Name', 'Name ', 'a'.repeat(33), 'Two\nlines', '<script>',null]) await rejectsCode(async()=>validateTradingPreferencesPatch({tpSlProfiles:[{...validProfile,name}]}),'invalid_profile_name');
  for(const value of [0,10001,1.5,'50',null,NaN]) await rejectsCode(async()=>validateTradingPreferencesPatch({tpSlProfiles:[{...validProfile,takeProfitPercent:value}]}),'invalid_take_profit');
  for(const value of [0,100,1.5,'20',null]) {
    await rejectsCode(async()=>validateTradingPreferencesPatch({tpSlProfiles:[{...validProfile,stopLossPercent:value}]}),'invalid_stop_loss');
    await rejectsCode(async()=>validateTradingPreferencesPatch({tpSlProfiles:[{...validProfile,trailingStopPercent:value}]}),'invalid_trailing_stop');
  }
  for(const extra of [{active:true},{enabled:true},{walletAddress:'0x'+'a'.repeat(40)},{privateKey:'do-not-store'},{orderId:'order'}]) await rejectsCode(async()=>validateTradingPreferencesPatch({tpSlProfiles:[{...validProfile,...extra}]}),'unsupported_preference');
});
test('unknown keys, prototype pollution, and wallet secrets never reach storage',async()=>{
  const e=env();
  for(const patch of [{wallets:[]},{privateKey:'do-not-store'},{seedPhrase:'never store this'},{orders:[]},{autoTrade:true},{userId:'99999'},JSON.parse('{"__proto__":{"enabled":true}}')]) await rejectsCode(()=>saveTradingPreferences(e,{...actor,patch}),'unsupported_preference');
  for(const patch of [null,[],new Date(),Object.create(null)]) await rejectsCode(()=>saveTradingPreferences(e,{...actor,patch}),'invalid_preferences');
  await rejectsCode(()=>saveTradingPreferences(e,{...actor,patch:{}}),'empty_preferences_patch');assert.equal(count(e),0);assert.equal(e.DB.calls,0);
});
test('8 KiB UTF-8 cap applies before invalid oversized content can be persisted',async()=>{
  const e=env();assert.equal(TRADING_PREFERENCES_MAX_BYTES,8192);
  for(const name of ['x'.repeat(9000),'🎣'.repeat(3000)]) await rejectsCode(()=>saveTradingPreferences(e,{...actor,patch:{tpSlProfiles:[{...validProfile,name}]}}),'preferences_too_large');
  assert.equal(count(e),0);
});
test('validation errors do not change an existing preference revision',async()=>{
  const e=env();const saved=await saveTradingPreferences(e,{...actor,patch:{slippageBps:100}});
  await rejectsCode(()=>saveTradingPreferences(e,{...actor,patch:{slippageBps:9000}}),'invalid_slippage');assert.deepEqual(await loadTradingPreferences(e,actor),saved);
});
test('missing DB or migration fails closed without raw SQL errors or implicit defaults',async()=>{
  await rejectsCode(()=>loadTradingPreferences({},actor),'trading_preferences_unavailable');
  await rejectsCode(()=>saveTradingPreferences({},{...actor,patch:{slippageBps:100}}),'trading_preferences_unavailable');
  const e={DB:new D1({migrate:false})};await assert.rejects(()=>loadTradingPreferences(e,actor),error=>error.code==='trading_preferences_unavailable'&&!/no such table|SQLITE/.test(error.message));
});
test('corrupt stored schema is not exposed as a valid configuration or silently reset',async()=>{
  const e=env();await saveTradingPreferences(e,{...actor,patch:{slippageBps:100}});
  e.DB.sqlite.prepare('UPDATE trading_preferences SET preferences_json=?').run('{"privateKey":"do-not-expose"}');
  await assert.rejects(()=>loadTradingPreferences(e,actor),error=>error.code==='trading_preferences_unavailable'&&!error.message.includes('do-not-expose'));
  assert.equal(e.DB.sqlite.prepare('SELECT preferences_json FROM trading_preferences').get().preferences_json,'{"privateKey":"do-not-expose"}');
});
test('database constraints independently enforce private identity, JSON validity, and byte cap',async()=>{
  const e=env();const insert=e.DB.sqlite.prepare('INSERT INTO trading_preferences(telegram_user_id,chat_id,preferences_json,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)');
  assert.throws(()=>insert.run('123','456','{}',NOW,NOW));assert.throws(()=>insert.run('0','0','{}',NOW,NOW));assert.throws(()=>insert.run('abc','abc','{}',NOW,NOW));assert.throws(()=>insert.run('123','123','[]',NOW,NOW));assert.throws(()=>insert.run('123','123','not-json',NOW,NOW));assert.throws(()=>insert.run('123','123',JSON.stringify({x:'a'.repeat(9000)}),NOW,NOW));assert.equal(count(e),0);
});

let passed=0;
for(const [name,fn] of tests){try{await fn();passed++;console.log(`PASS ${name}`);}catch(error){console.error(`FAIL ${name}`);throw error;}}
console.log(`\n${passed} trading-preference tests passed.`);
