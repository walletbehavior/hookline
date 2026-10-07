import { loadTradingPreferences, saveTradingPreferences, defaultTradingPreferences, validateTradingPreferencesPatch } from './trading-preferences.js';
import { navigationRows, menuButton, privateConversation, cleanLabel } from './navigation.js';

const button=(text,section)=>({text,callback_data:`tg:settings:${section}`});
const preset=(text,key,value)=>({text,callback_data:`tg:pref:${key}:${value}`});
const buySets={small:['0.005','0.01','0.025','0.05'],standard:['0.01','0.05','0.1','0.5'],large:['0.1','0.25','0.5','1']};
const sellSets={standard:[25,50,75,100],small:[10,25,50,100]};
const percent=(bps)=>`${(Number(bps)/100).toFixed(2).replace(/\.00$/,'')}%`;

export async function tradingPreferences(ctx,userId,chatId) {
  if(!privateConversation(chatId,userId)) throw new Error('Open Hookline privately to manage trading settings.');
  return typeof ctx.services?.tradingPreferences?.load==='function' ? ctx.services.tradingPreferences.load({userId,chatId}) : loadTradingPreferences(ctx.env,{userId,chatId});
}
async function save(ctx,userId,chatId,patch) {
  if(!privateConversation(chatId,userId)) throw new Error('Open Hookline privately to manage trading settings.');
  return typeof ctx.services?.tradingPreferences?.save==='function' ? ctx.services.tradingPreferences.save({userId,chatId,patch}) : saveTradingPreferences(ctx.env,{userId,chatId,patch});
}
export async function renderTradingSettings(ctx,userId,chatId,section='main',notice='') {
  let stored,unavailable=false;
  try {stored=await tradingPreferences(ctx,userId,chatId);} catch {stored={preferences:defaultTradingPreferences(),revision:0};unavailable=true;}
  const p=stored.preferences,lines=[],keyboard=[];
  if(notice) lines.push(notice,'');
  if(unavailable) lines.push('Saved settings are unavailable. Values below are defaults, not confirmed saved preferences.','');
  if(section==='main') {
    lines.push('Trading settings','',`Slippage: ${percent(p.slippageBps)}`,`Buy buttons: ${p.buyAmounts.join(', ')} native`,`Sell buttons: ${p.sellPercentages.map(n=>`${n}%`).join(', ')}`,'Priority fee: wallet-managed',`TP/SL profiles: ${p.tpSlProfiles.length} saved, not active`,'','Orders and signatures stay in your wallet. Saved profiles never place orders.');
    keyboard.push([button('Slippage','slippage'),button('Buy amounts','buy')],[button('Sell percentages','sell'),button('Priority fee','priority')],[button('TP/SL profiles','profiles'),button('Limit orders','limits')],[button('Wallets','wallets'),button('Transfer','transfer'),button('Bridge','bridge')]);
  } else if(section==='slippage') {
    lines.push('Slippage',`Current: ${percent(p.slippageBps)}`,'','The reviewed website quote applies this maximum slippage. A higher limit can produce a worse fill.');
    keyboard.push([50,100,200,500].map(n=>preset(percent(n),'slippage',n)),[preset('Custom percentage','custom','slippage')]);
  } else if(section==='buy') {
    lines.push('Buy button amounts',p.buyAmounts.join(', '),'','Native units: ETH on Ethereum, Base and Robinhood; BNB on BNB Chain. These are not dollar amounts.');
    keyboard.push([preset('Small','buy','small'),preset('Standard','buy','standard'),preset('Larger','buy','large')],[preset('Custom amounts','custom','buy')]);
  } else if(section==='sell') {
    lines.push('Sell button percentages',p.sellPercentages.map(n=>`${n}%`).join(', '),'','The website reads your connected wallet’s balance before preparing a review.');
    keyboard.push([preset('25 / 50 / 75 / 100','sell','standard')],[preset('10 / 25 / 50 / 100','sell','small')],[preset('Custom percentages','custom','sell')]);
  } else if(section==='priority') {
    lines.push('Priority fee',`Saved reference: ${p.priorityFeeGwei==null?'Wallet default':`${p.priorityFeeGwei} gwei`}`,'','Wallet-managed. This saved reference is not automatically applied to quotes or transactions. Review gas in your wallet before signing.');
    keyboard.push([preset('Wallet default','priority','auto'),preset('1 gwei','priority','1'),preset('3 gwei','priority','3')],[preset('Custom reference','custom','priority')]);
  } else if(section==='profiles') {
    lines.push('TP/SL profiles, saved only','','No trigger is active. Hookline does not monitor prices or submit automatic take-profit, stop-loss, or trailing-stop orders.');
    p.tpSlProfiles.forEach(profile=>lines.push('',`${cleanLabel(profile.name,32)}: TP ${profile.takeProfitPercent}%, SL ${profile.stopLossPercent}%${profile.trailingStopPercent?`, trailing ${profile.trailingStopPercent}%`:''}`));
    if(!p.tpSlProfiles.length) lines.push('','No saved profiles.');
    keyboard.push([preset('Save TP 50%, SL 20%','profile','balanced')],[preset('Custom profile','custom','profile')],[preset('Clear saved profiles','profile','clear')]);
  } else if(section==='limits') {
    lines.push('Limit orders','', 'Not active. This bot does not place or monitor limit orders. Market execution is available through a fresh website quote and your wallet confirmation.');
    keyboard.push([{text:'Open Hookline',url:'https://hookline.world/#/board'}]);
  } else if(['wallets','transfer','bridge'].includes(section)) {
    lines.push(({wallets:'Your wallets',transfer:'Transfer assets',bridge:'Bridge assets'})[section],'',section==='wallets'?'Connect an existing wallet on Hookline. Telegram never creates custodial wallets or stores keys.':section==='transfer'?'Transfers are not executed by this bot. Use your wallet’s send screen and verify the destination and chain.':'Bridging is not executed by this bot. Use your wallet’s supported bridge flow and review its fees and destination chain.','', 'Never paste a private key or seed phrase into this chat.');
    keyboard.push([{text:'Open wallet connection',url:'https://hookline.world/#/board'}]);
  } else return renderTradingSettings(ctx,userId,chatId,'main',notice);
  if(section!=='main') keyboard.push([button('Back to settings','main')]);
  keyboard.push(...navigationRows());
  return {text:lines.join('\n'),parse_mode:null,reply_markup:{inline_keyboard:keyboard}};
}

export function settingsInputPrompt(field) {
  return ({slippage:'Send one slippage percentage, such as 0.5. Range: 0.01 to 50.',buy:'Send up to four native-coin amounts separated by commas, such as 0.01, 0.05, 0.1, 0.5. Do not use dollar signs.',sell:'Send up to four whole percentages separated by commas, such as 25, 50, 75, 100.',priority:'Send a gwei reference such as 1.5, or auto for wallet default. This is saved only, not automatically applied.',profile:'Send Name | take-profit % | stop-loss % | optional trailing %. Example: My profile | 50 | 20 | 10. Saved only, no automatic orders.'})[field] || null;
}
function exactPercent(raw) {
  if(!/^\d{1,2}(?:\.\d{1,2})?$/.test(raw)) throw new Error('Use a percentage with up to two decimal places, such as 0.5.');
  const bps=Math.round(Number(raw)*100);
  if(bps<1 || bps>5000) throw new Error('Slippage must be between 0.01% and 50%.');
  return bps;
}
export async function saveSettingsInput(ctx,userId,chatId,field,input) {
  const raw=String(input || '').trim();
  if(raw.length>180) throw new Error('That input is too long. Send only the requested numbers or profile.');
  let patch;
  if(field==='slippage') patch={slippageBps:exactPercent(raw.replace(/%$/,''))};
  else if(field==='buy') patch={buyAmounts:raw.split(',').map(v=>v.trim())};
  else if(field==='sell') {
    const values=raw.split(',').map(v=>v.trim().replace(/%$/,''));
    if(values.some(v=>!/^\d{1,3}$/.test(v))) throw new Error('Use whole percentages separated by commas.');
    patch={sellPercentages:values.map(Number)};
  } else if(field==='priority') patch={priorityFeeGwei:/^(auto|default)$/i.test(raw)?null:raw};
  else if(field==='profile') {
    const [name,tp,sl,trailing,...extra]=raw.split('|').map(v=>v.trim());
    if(extra.length || !/^\d+$/.test(tp || '') || !/^\d+$/.test(sl || '') || (trailing && !/^\d+$/.test(trailing))) throw new Error('Use Name | take-profit % | stop-loss % | optional trailing %, with whole percentages.');
    const current=(await tradingPreferences(ctx,userId,chatId)).preferences;
    const profile={name,takeProfitPercent:Number(tp),stopLossPercent:Number(sl),...(trailing?{trailingStopPercent:Number(trailing)}:{})};
    patch={tpSlProfiles:[...current.tpSlProfiles.filter(p=>p.name.toLowerCase()!==name.toLowerCase()),profile]};
  } else throw new Error('That setting is unavailable. Open Settings again.');
  return save(ctx,userId,chatId,patch);
}
export async function saveSettingsPreset(ctx,userId,chatId,key,value) {
  let patch;
  if(key==='slippage' && [50,100,200,500].includes(Number(value))) patch={slippageBps:Number(value)};
  else if(key==='buy' && buySets[value]) patch={buyAmounts:buySets[value]};
  else if(key==='sell' && sellSets[value]) patch={sellPercentages:sellSets[value]};
  else if(key==='priority' && ['auto','1','3'].includes(value)) patch={priorityFeeGwei:value==='auto'?null:value};
  else if(key==='profile' && value==='clear') patch={tpSlProfiles:[]};
  else if(key==='profile' && value==='balanced') {
    const current=(await tradingPreferences(ctx,userId,chatId)).preferences;
    patch={tpSlProfiles:[...current.tpSlProfiles.filter(p=>p.name!=='TP 50 / SL 20'),{name:'TP 50 / SL 20',takeProfitPercent:50,stopLossPercent:20}]};
  } else throw new Error('Invalid setting preset.');
  return save(ctx,userId,chatId,patch);
}

export const EXECUTION_CHAINS=new Set([1,56,4663,8453]);
export function validateTradeInput(side,input) {
  const raw=String(input || '').trim();
  if(raw.length>60) throw new Error('Send only the requested amount or percentage.');
  if(side==='sell') {
    const value=raw.replace(/%$/,'');
    if(!/^\d{1,3}$/.test(value)) throw new Error('Send a whole sell percentage from 1 to 100.');
    validateTradingPreferencesPatch({sellPercentages:[Number(value)]});
    return {sellPercent:Number(value)};
  }
  validateTradingPreferencesPatch({buyAmounts:[raw]});
  return {amount:raw};
}
export function tradeHandoffUrl({chainId,address,side='buy',slippageBps=50,amount,sellPercent}) {
  if(!EXECUTION_CHAINS.has(Number(chainId)) || !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('That chain or token is not supported for execution.');
  const params=new URLSearchParams({side:side==='sell'?'sell':'buy',slippage:String(slippageBps)});
  if(amount!=null) {params.set('amount',String(amount));if(side==='buy') params.set('inputAsset','native');}
  else if(sellPercent!=null && side==='sell') params.set('sellPercent',String(sellPercent));
  return `https://hookline.world/#/trade/${Number(chainId)}/${address.toLowerCase()}?${params}`;
}
export async function renderTradeHandoff(ctx,userId,chatId,{chainId,address,side='buy',amount,sellPercent,legacy=false}) {
  if(!EXECUTION_CHAINS.has(Number(chainId))) return {text:'Trading is not supported on this chain. You can still inspect its hooks and follow projects.',parse_mode:null,reply_markup:{inline_keyboard:navigationRows()}};
  let prefs,notice='';
  try {prefs=(await tradingPreferences(ctx,userId,chatId)).preferences;} catch {prefs=defaultTradingPreferences();notice='Saved settings unavailable. Default slippage shown; review it on the website.';}
  const native=Number(chainId)===56?'BNB':'ETH',url=tradeHandoffUrl({chainId,address,side,slippageBps:prefs.slippageBps,amount,sellPercent});
  const lines=[`${side==='sell'?'Sell':'Buy'} review`,address,`Slippage: ${percent(prefs.slippageBps)}`];
  if(amount!=null) lines.push(`Amount: ${amount} ${side==='buy'?native:'token units'}`);
  if(sellPercent!=null) lines.push(`Sell: ${sellPercent}% of the connected wallet’s balance`);
  if(legacy) lines.push('The old USD preset was not applied. Set an amount in the website review.');
  if(side==='buy') lines.push('Native-coin amounts only. If this market uses a different input asset, the website will stop and ask you to review it.');
  lines.push('','Open a fresh quote on Hookline. Your wallet signs and submits. This chat has not quoted, signed, or sent a trade.');
  if(notice) lines.push('',notice);
  const keyboard=[[{text:'Open trade review',url}]];
  if(amount==null && sellPercent==null && !legacy) {
    const presets=side==='sell'?prefs.sellPercentages.map(n=>({text:`${n}%`,url:tradeHandoffUrl({chainId,address,side,slippageBps:prefs.slippageBps,sellPercent:n})})):prefs.buyAmounts.map(n=>({text:`${n} ${native}`,url:tradeHandoffUrl({chainId,address,side,slippageBps:prefs.slippageBps,amount:n})}));
    if(presets.length) keyboard.unshift(presets);
    keyboard.push([{text:side==='buy'?'Custom buy amount':'Custom sell percentage',callback_data:`tg:${side==='buy'?'custombuy':'customsell'}:${chainId}:${address}`}]);
  }
  keyboard.push([button('Trading settings','main')],...navigationRows());
  return {text:lines.join('\n'),parse_mode:null,reply_markup:{inline_keyboard:keyboard}};
}
