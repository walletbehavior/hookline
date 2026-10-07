import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleUpdate} from '../index.js';
import {makeD1AlertStore} from '../alerts-store.js';
import {alertIdentities} from '../alert-identity.js';
import {defaultTradingPreferences,loadTradingPreferences} from '../trading-preferences.js';
import {renderTradeHandoff,renderTradingSettings,tradeHandoffUrl} from '../trading-settings.js';
import {renderTokenCard} from '../token-view.js';
import {renderHookView} from '../hook-view.js';

const HOOK='0x'+'1'.repeat(40),TOKEN='0x'+'2'.repeat(40),UNKNOWN='0x'+'3'.repeat(40);
const BOT_TOKEN='123456789:abcdefghijklmnopqrstuvwxyzABCDE';
class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec('PRAGMA foreign_keys=ON');for(const name of ['0000_fearless_silver_samurai.sql','0002_project_contributions.sql','0003_project_evidence.sql','0004_trading_preferences.sql'])this.sqlite.exec(readFileSync(new URL(`../../drizzle/${name}`,import.meta.url),'utf8'));}
  prepare(sql){const db=this;let values=[];const statement={bind(...v){values=v;return statement;},async first(){return db.sqlite.prepare(sql).get(...values)||null;},async all(){return {results:db.sqlite.prepare(sql).all(...values)};},async run(){return statement._run();},_run(){const result=db.sqlite.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};return statement;}
  async batch(statements){this.sqlite.exec('BEGIN');try{const results=statements.map(s=>s._run());this.sqlite.exec('COMMIT');return results;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
class Client {
  static calls=[];
  async sendMessage(chatId,text,options={}){Client.calls.push({kind:'send',chatId,text,options});return {message_id:10};}
  async editMessageText(chatId,messageId,text,options={}){Client.calls.push({kind:'edit',chatId,messageId,text,options});return {message_id:messageId};}
  async answerCallbackQuery(id,options={}){Client.calls.push({kind:'answer',id,options});return true;}
}
const project={id:'alpha',name:'Alpha Project',summary:'A source-linked project.',category:'Liquidity',deployments:[{chainId:8453,address:HOOK,name:'Alpha Market Hook',provenance:'official deployment reference'}]};
function context(){return {env:{DB:new D1(),TELEGRAM_BOT_TOKEN:BOT_TOKEN},services:{projects:{listProjects:async()=>[project],getProject:async(id)=>id==='alpha'?project:null},resolveAlertIdentity:async(chainId,address,type)=>address===TOKEN?{name:'Token Two',kind:'token',symbol:'TWO',source:'Token index'}:address===HOOK?{name:'Indexed Alpha Hook',source:'Verified-source name'}:null,resolveTokenHooks:async()=>({relationships:[]})}};}
function command(text,userId=71,chatId=userId){return {update_id:1,message:{message_id:1,from:{id:userId},chat:{id:chatId},text}};}
function callback(data,userId=71,chatId=userId){return {update_id:2,callback_query:{id:'callback',from:{id:userId},data,message:{message_id:10,chat:{id:chatId}}}};}
function card(){return Client.calls.findLast(c=>c.kind==='send'||c.kind==='edit');}
function buttons(message=card()){return message.options.reply_markup.inline_keyboard.flat();}
test.beforeEach(()=>{Client.calls=[];globalThis.TelegramClient=Client;});
test.after(()=>{delete globalThis.TelegramClient;});

test('start/help/wallet/settings have button-first navigation and truthful capability labels',async()=>{
  const ctx=context();
  for(const name of ['start','help','wallet','settings']){
    await handleUpdate(command(`/${name}`),ctx);
    assert(buttons().some(b=>b.text==='Projects'),name);
    assert(buttons().some(b=>b.text==='My alerts'),name);
  }
  assert(buttons().some(b=>b.text==='Slippage'));
  assert(buttons().some(b=>b.text==='TP/SL profiles'));
  assert.match(card().text,/not active/);
  await handleUpdate(callback('tg:settings:limits'),ctx);
  assert.match(card().text,/Not active/);
  assert.doesNotMatch(card().text,/order placed|order active/i);
});
test('empty alerts offer Add alert, Projects and Main menu without command typing',async()=>{
  const ctx=context();await handleUpdate(command('/alerts'),ctx);
  assert.match(card().text,/Nothing followed yet/);
  assert.deepEqual(buttons().map(b=>b.text),['Add alert','Projects','Main menu']);
  await handleUpdate(callback('tg:menu:add'),ctx);
  assert.match(card().text,/Paste a hook or token address/);
  await handleUpdate(command(UNKNOWN),ctx);
  assert.match(card().text,/Choose the hook’s chain/);
  assert(buttons().some(b=>b.text==='Base'&&b.callback_data===`tg:as:8453:${UNKNOWN}`));
});
test('project, hook and token alert cards use sourced names, explicit states and address-secondary layouts',async()=>{
  const ctx=context(),store=makeD1AlertStore(ctx.env);
  await store.createOrEnableAlert({userId:71,chatId:71,chainId:8453,address:HOOK});
  await store.createOrEnableAlert({userId:71,chatId:71,chainId:1,address:TOKEN});
  await ctx.env.DB.prepare("UPDATE alerts SET target_type='token' WHERE target_address=?").bind(TOKEN).run();
  await ctx.env.DB.prepare('INSERT INTO project_follows(id,telegram_user_id,chat_id,project_id,created_at,enabled) VALUES(?,?,?,?,?,1)').bind('p1','71','71','alpha',Date.now()).run();
  await handleUpdate(command('/alerts'),ctx);
  const text=card().text;
  assert.match(text,/Alpha Project\nProject · Active · Base/);
  assert.match(text,/Alpha Market Hook\nBase · Hook · Active/);
  assert.match(text,/Token Two\nEthereum · Token · Active/);
  assert.equal(card().options.parse_mode,'HTML');
  assert(text.includes(`<code>${HOOK}</code>`));
  assert(text.includes(`<code>${TOKEN}</code>`));
  assert(text.indexOf('Alpha Market Hook')<text.indexOf(HOOK));
  assert(buttons().some(b=>b.callback_data==='pr:off:alpha'));
  assert(buttons().some(b=>b.callback_data===`tg:ad:8453:${HOOK}`));
});
test('unknown hook identities stay honest and fallback market calls are bounded and cached',async()=>{
  let calls=0;
  const resolver=async()=>{calls++;return null;};
  const ctx={services:{projects:{listProjects:async()=>[]},resolveHookMarkets:resolver}};
  const rows=Array.from({length:9},(_,i)=>({chain_id:8453,target_address:'0x'+String(i+1).repeat(40),target_type:'hook'}));
  const result=await alertIdentities(ctx,rows,[]);
  assert.equal(calls,3);
  rows.forEach(row=>assert.equal(result.get(row).name,'Unnamed hook'));
  await alertIdentities(ctx,rows.slice(0,3),[]);
  assert.equal(calls,3,'Cached names must avoid repeated market lookups.');
});
test('pause and resume persist, remain visible, and repeated callbacks do not toggle state',async()=>{
  const ctx=context();
  await handleUpdate(callback(`tg:ae:8453:${HOOK}`),ctx);
  assert.equal(card().options.parse_mode,'HTML');
  assert(card().text.includes(`<code>${HOOK}</code>`));
  const before=await ctx.env.DB.prepare('SELECT * FROM alerts').first();
  await handleUpdate(callback(`tg:ae:8453:${HOOK}`),ctx);
  assert.equal((await ctx.env.DB.prepare('SELECT * FROM alerts').first()).next_check_at,before.next_check_at,'Repeated enable must not reschedule a running alert.');
  await handleUpdate(callback(`tg:ad:8453:${HOOK}`),ctx);
  assert(card().text.includes(`<code>${HOOK}</code>`));
  await handleUpdate(callback(`tg:ad:8453:${HOOK}`),ctx);
  assert.equal((await ctx.env.DB.prepare('SELECT enabled FROM alerts').first()).enabled,0);
  await handleUpdate(command('/alerts'),ctx);
  assert.match(card().text,/Alpha Market Hook\nBase · Hook · Paused/);
  assert(buttons().some(b=>b.text==='Resume'));
  await handleUpdate(callback(`tg:av:8453:${HOOK}`),ctx);
  assert.equal(card().options.parse_mode,'HTML');
  assert(card().text.includes(`<code>${HOOK}</code>`));
  await handleUpdate(callback(`tg:ae:8453:${HOOK}`),ctx);
  assert.equal((await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM alerts').first()).n,1);
  assert.equal((await ctx.env.DB.prepare('SELECT enabled FROM alerts').first()).enabled,1);
});
test('callbacks and alert reads cannot operate on another private user or a group',async()=>{
  const ctx=context();await handleUpdate(callback(`tg:ae:8453:${HOOK}`),ctx);
  for(const data of [`tg:ad:8453:${HOOK}`,`tg:ae:1:${TOKEN}`,'tg:pref:slippage:200','pr:on:alpha']){
    for(const chatId of [71,-10012]){
      Client.calls=[];await handleUpdate(callback(data,72,chatId),ctx);
      assert.equal(Client.calls.length,1);
      assert.equal(Client.calls[0].kind,'answer');
      assert.equal(Client.calls[0].options.show_alert,true);
    }
  }
  assert.equal((await ctx.env.DB.prepare('SELECT enabled FROM alerts').first()).enabled,1);
  await handleUpdate(command('/alerts',72,-10012),ctx);
  assert.match(card().text,/private chat/);
  assert.doesNotMatch(card().text,/Alpha Market Hook/);
  const result=await handleUpdate(callback(`tg:av:8453:${HOOK}`,72,72),ctx);
  assert.equal(result.reason,'invalid_callback');
});
test('resume obeys active alert capacity and the D1 store enforces private chat scope',async()=>{
  const ctx=context(),store=makeD1AlertStore(ctx.env);
  await assert.rejects(()=>store.createOrEnableAlert({userId:71,chatId:-100,chainId:1,address:HOOK}),/private chat/);
  await store.createOrEnableAlert({userId:71,chatId:71,chainId:1,address:HOOK});
  await store.disableAlert({userId:71,chainId:1,address:HOOK});
  for(let i=2;i<12;i++)await store.createOrEnableAlert({userId:71,chatId:71,chainId:1,address:'0x'+i.toString(16).padStart(40,'0')});
  await assert.rejects(()=>store.createOrEnableAlert({userId:71,chatId:71,chainId:1,address:HOOK}),/up to 10/);
  assert.equal((await store.listUserAlerts(71,{includePaused:true})).length,11);
});
test('settings presets and custom inputs persist; cancel navigation prevents accidental later mutation',async()=>{
  const ctx=context();
  await handleUpdate(callback('tg:pref:slippage:200'),ctx);
  assert.equal((await loadTradingPreferences(ctx.env,{userId:71,chatId:71})).preferences.slippageBps,200);
  await handleUpdate(callback('tg:pref:custom:buy'),ctx);
  await handleUpdate(command('0.02, 0.2'),ctx);
  assert.deepEqual((await loadTradingPreferences(ctx.env,{userId:71,chatId:71})).preferences.buyAmounts,['0.02','0.2']);
  await handleUpdate(callback('tg:pref:custom:slippage'),ctx);
  await handleUpdate(callback('tg:menu:settings'),ctx);
  await handleUpdate(command('5'),ctx);
  assert.equal((await loadTradingPreferences(ctx.env,{userId:71,chatId:71})).preferences.slippageBps,200);
  await handleUpdate(callback('tg:pref:custom:slippage'),ctx);
  await handleUpdate(callback('tg:pref:slippage:100'),ctx);
  await handleUpdate(command('5'),ctx);
  assert.equal((await loadTradingPreferences(ctx.env,{userId:71,chatId:71})).preferences.slippageBps,100,'A preset also cancels any previous custom prompt.');
  await handleUpdate(callback('tg:pref:custom:slippage'),ctx);
  await handleUpdate(callback(`tg:buy:8453:${TOKEN}`),ctx);
  await handleUpdate(command('5'),ctx);
  assert.equal((await loadTradingPreferences(ctx.env,{userId:71,chatId:71})).preferences.slippageBps,100,'Opening a trade cannot leave a settings prompt armed.');
  await handleUpdate(callback('tg:pref:profile:balanced'),ctx);
  assert.match(card().text,/saved only/);
  assert.match(card().text,/No trigger is active/);
  assert.equal((await loadTradingPreferences(ctx.env,{userId:71,chatId:71})).preferences.tpSlProfiles.length,1);
});
test('real trade handoffs bind chain, token, saved slippage and native asset without quotes or signatures',async()=>{
  const ctx=context();await handleUpdate(callback('tg:pref:slippage:100'),ctx);
  await handleUpdate(callback(`tg:buy:8453:${TOKEN}`),ctx);
  const native=buttons().find(b=>b.text==='0.01 ETH');
  assert(native);
  assert.match(native.url,new RegExp(`#/trade/8453/${TOKEN}`));
  assert.match(native.url,/amount=0.01/);assert.match(native.url,/slippage=100/);assert.match(native.url,/inputAsset=native/);
  assert.doesNotMatch(card().text,/minimum received|guaranteed|fill price/i);
  await handleUpdate(callback(`tg:customsell:8453:${TOKEN}`),ctx);
  await handleUpdate(command('65'),ctx);
  assert.match(buttons().find(b=>b.text==='Open trade review').url,/sellPercent=65/);
  await handleUpdate(callback(`tg:bp:1:${TOKEN}:100`),ctx);
  assert.match(card().text,/old USD preset was not applied/);
  assert(buttons().filter(b=>b.url).every(b=>!b.url.includes('amount=100')));
  assert.doesNotMatch(card().text,/minimum received|minimum output/i);
});
test('untrusted labels cannot create Markdown links in token/hook/sibling cards',()=>{
  const malicious='[Claim rewards](https://evil.org) *bold* `code`';
  const token={address:TOKEN,symbol:malicious,name:malicious};
  const hook={hookAddress:HOOK,hookName:malicious,hookNamed:true};
  const a=renderTokenCard(token,1,hook,[]);
  const b=renderHookView(token,1,hook,[{baseToken:{address:TOKEN,symbol:malicious},liquidityUsd:'12.3'}]);
  assert.doesNotMatch(a.text,/\[Claim rewards\]\(/);
  assert.doesNotMatch(b.text,/\[Claim rewards\]\(/);
  assert.doesNotMatch(b.text,/verified contract/);
  assert.doesNotMatch(a.text,/https?:\/\/|evil\.org/);
  assert.doesNotMatch(b.text,/https?:\/\/|evil\.org/);
});
test('copyable alert CAs use escaped HTML even when indexed names contain markup',async()=>{
  const ctx=context();
  ctx.services.projects.listProjects=async()=>[];
  ctx.services.resolveAlertIdentity=async()=>({name:'<b>Untrusted</b> & hook',source:'<source>'});
  await makeD1AlertStore(ctx.env).createOrEnableAlert({userId:71,chatId:71,chainId:8453,address:HOOK});
  await handleUpdate(command('/alerts'),ctx);
  assert.equal(card().options.parse_mode,'HTML');
  assert(card().text.includes('&lt;b&gt;Untrusted&lt;/b&gt; &amp; hook'));
  assert(card().text.includes('&lt;source&gt;'));
  assert(card().text.includes(`<code>${HOOK}</code>`));
  assert.doesNotMatch(card().text,/<b>|<source>/);
  await handleUpdate(callback(`tg:as:8453:${HOOK}`),ctx);
  assert(card().text.includes(`<code>${HOOK}</code>`));
});
test('all new button payloads fit64 bytes and custom-only preference arrays make no empty button rows',async()=>{
  const ctx=context();
  for(const section of ['main','slippage','buy','sell','priority','profiles','limits','wallets','transfer','bridge']){
    const message=await renderTradingSettings(ctx,71,71,section);
    for(const b of message.reply_markup.inline_keyboard.flat())if(b.callback_data)assert(Buffer.byteLength(b.callback_data)<=64,b.callback_data);
  }
  const defaults=defaultTradingPreferences();
  ctx.services.tradingPreferences={load:async()=>({preferences:{...defaults,buyAmounts:[],sellPercentages:[]},revision:1})};
  for(const side of ['buy','sell']){
    const message=await renderTradeHandoff(ctx,71,71,{chainId:8453,address:TOKEN,side});
    assert(message.reply_markup.inline_keyboard.every(row=>row.length>0));
    for(const b of message.reply_markup.inline_keyboard.flat())if(b.callback_data)assert(Buffer.byteLength(b.callback_data)<=64,b.callback_data);
  }
  assert.throws(()=>tradeHandoffUrl({chainId:42161,address:TOKEN}),/not supported/);
});
