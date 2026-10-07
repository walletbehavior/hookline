/**
 * Private Telegram trading preferences, not orders or signing authority.
 * TP/SL profiles are saved configuration only: this module never quotes,
 * signs, schedules, submits, bridges, or transfers anything.
 */
export const TRADING_PREFERENCES_MAX_BYTES = 8192;
const DECIMAL_PLACES = 18;
const SCALE = 10n ** BigInt(DECIMAL_PLACES);
const KEYS = new Set(['slippageBps','buyAmounts','sellPercentages','priorityFeeGwei','tpSlProfiles']);
const PROFILE_KEYS = new Set(['name','takeProfitPercent','stopLossPercent','trailingStopPercent']);
const USER_ID = /^[1-9][0-9]{0,19}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,18})?$/;

export class TradingPreferencesError extends Error {
  constructor(status,code,message) { super(message);this.name='TradingPreferencesError';this.status=status;this.code=code; }
}
function fail(status,code,message) { throw new TradingPreferencesError(status,code,message); }
function unavailable() { return new TradingPreferencesError(503,'trading_preferences_unavailable','Trading preferences are temporarily unavailable. Check your saved settings before retrying.'); }
function database(env) { if(!env?.DB?.prepare) throw unavailable();return env.DB; }

/** A fresh value on every call, so callers cannot mutate shared defaults. */
export function defaultTradingPreferences() {
  return {
    slippageBps:50,
    buyAmounts:['0.01','0.05','0.1','0.5'],
    sellPercentages:[25,50,75,100],
    priorityFeeGwei:null,
    tpSlProfiles:[],
  };
}
function identity({userId,chatId}={}) {
  for(const value of [userId,chatId]) {
    if((typeof value!=='string'&&typeof value!=='number') || (typeof value==='number'&&!Number.isSafeInteger(value))) fail(403,'private_chat_required','Open the Hookline bot privately to manage trading preferences.');
  }
  const user=String(userId),chat=String(chatId);
  if(!USER_ID.test(user)||user!==chat) fail(403,'private_chat_required','Open the Hookline bot privately to manage trading preferences.');
  return {user,chat};
}
function boundedObject(value,allowed) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype) fail(422,'invalid_preferences','Preferences must be an object.');
  for(const key of Object.keys(value)) if(!allowed.has(key)) fail(422,'unsupported_preference','Unsupported trading preference. Wallet credentials, orders, and execution authority cannot be saved here.');
  let serialized;
  try {serialized=JSON.stringify(value);} catch {fail(422,'invalid_preferences','Preferences must contain ordinary JSON values.');}
  if(new TextEncoder().encode(serialized).byteLength>TRADING_PREFERENCES_MAX_BYTES) fail(413,'preferences_too_large','Trading preferences must be under 8 KiB.');
}
function integer(value,min,max,code,label) {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) fail(422,code,`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
function decimal(value,{max,positive,code,label}) {
  if(typeof value!=='string'||!DECIMAL.test(value)) fail(422,code,`${label} must be a plain decimal string with at most 18 decimal places, without signs or exponents.`);
  const [whole,fraction='']=value.split('.');
  const scaled=BigInt(whole)*SCALE+BigInt(fraction.padEnd(DECIMAL_PLACES,'0'));
  if(scaled>BigInt(max)*SCALE || (positive&&scaled===0n)) fail(422,code,`${label} must be ${positive?'greater than zero and ':''}no more than ${max}.`);
  return {exact:value,scaled};
}
function profiles(value) {
  if(!Array.isArray(value)||value.length>3) fail(422,'invalid_tp_sl_profiles','Save at most three TP/SL configuration profiles.');
  const names=new Set();
  return value.map(profile=>{
    boundedObject(profile,PROFILE_KEYS);
    if(typeof profile.name!=='string'||!profile.name.trim()||profile.name!==profile.name.trim()||profile.name.length>32||/[\u0000-\u001F\u007F<>]/.test(profile.name)) fail(422,'invalid_profile_name','Profile names must be 1–32 characters, on one line without markup or surrounding spaces.');
    const key=profile.name.toLowerCase();
    if(names.has(key)) fail(422,'duplicate_profile_name','Give each TP/SL configuration profile a distinct name.');
    names.add(key);
    const result={
      name:profile.name,
      takeProfitPercent:integer(profile.takeProfitPercent,1,10000,'invalid_take_profit','Take-profit percent'),
      stopLossPercent:integer(profile.stopLossPercent,1,99,'invalid_stop_loss','Stop-loss percent'),
    };
    if(Object.hasOwn(profile,'trailingStopPercent')) result.trailingStopPercent=integer(profile.trailingStopPercent,1,99,'invalid_trailing_stop','Trailing-stop percent');
    return result;
  });
}

/** Exported for trusted UI helpers only; do not expose an unauthenticated API. */
export function validateTradingPreferencesPatch(patch) {
  boundedObject(patch,KEYS);
  if(Object.keys(patch).length===0) fail(422,'empty_preferences_patch','Choose a preference to update.');
  const validated={};
  for(const key of Object.keys(patch)) {
    const value=patch[key];
    if(key==='slippageBps') validated[key]=integer(value,1,5000,'invalid_slippage','Slippage basis points');
    else if(key==='buyAmounts') {
      if(!Array.isArray(value)||value.length>4) fail(422,'invalid_buy_amounts','Choose at most four native-token buy amounts.');
      const seen=new Set();
      validated[key]=value.map(amount=>{
        const parsed=decimal(amount,{max:100000,positive:true,code:'invalid_buy_amount',label:'Buy amount'});
        if(seen.has(parsed.scaled.toString())) fail(422,'duplicate_buy_amount','Buy amounts must be distinct.');
        seen.add(parsed.scaled.toString());return parsed.exact;
      });
    } else if(key==='sellPercentages') {
      if(!Array.isArray(value)||value.length>4) fail(422,'invalid_sell_percentages','Choose at most four sell percentages.');
      validated[key]=value.map(percent=>integer(percent,1,100,'invalid_sell_percentage','Sell percentage'));
      if(new Set(validated[key]).size!==validated[key].length) fail(422,'duplicate_sell_percentage','Sell percentages must be distinct.');
    } else if(key==='priorityFeeGwei') {
      validated[key]=value===null ? null : decimal(value,{max:1000,positive:false,code:'invalid_priority_fee',label:'Priority fee in gwei'}).exact;
    } else if(key==='tpSlProfiles') validated[key]=profiles(value);
  }
  return validated;
}
function decode(row) {
  if(!row) return {preferences:defaultTradingPreferences(),revision:0,updatedAt:null,configurationOnly:true};
  let preferences;
  try {
    const stored=JSON.parse(row.preferences_json);
    const cleaned=validateTradingPreferencesPatch(stored);
    preferences={...defaultTradingPreferences(),...cleaned};
    if(!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.updated_at)) throw new Error('invalid stored revision');
  } catch {throw unavailable();}
  return {preferences,revision:row.revision,updatedAt:new Date(row.updated_at).toISOString(),configurationOnly:true};
}

/** userId/chatId must come from the authenticated Telegram update, not user text. */
export async function loadTradingPreferences(env,options={}) {
  const {user,chat}=identity(options);const db=database(env);
  try {return decode(await db.prepare('SELECT preferences_json,revision,updated_at FROM trading_preferences WHERE telegram_user_id=? AND chat_id=?').bind(user,chat).first());}
  catch(error) {if(error instanceof TradingPreferencesError) throw error;throw unavailable();}
}

/** Atomic partial merge: parallel updates to unrelated settings cannot clobber. */
export async function saveTradingPreferences(env,options={}) {
  const {user,chat}=identity(options);const patch=validateTradingPreferencesPatch(options.patch);const db=database(env);
  const now=Date.now();const keys=Object.keys(patch);
  const initial=JSON.stringify({...defaultTradingPreferences(),...patch});
  // Every path is from the fixed whitelist above; all values are bound JSON.
  const assignments=keys.map(key=>`,'$.${key}',json(?)`).join('');
  const sql=`INSERT INTO trading_preferences(telegram_user_id,chat_id,preferences_json,revision,created_at,updated_at)
    VALUES(?,?,?,1,?,?) ON CONFLICT(telegram_user_id,chat_id) DO UPDATE SET
    preferences_json=json_set(trading_preferences.preferences_json${assignments}),
    revision=trading_preferences.revision+1,updated_at=MAX(trading_preferences.updated_at,excluded.updated_at)
    RETURNING preferences_json,revision,updated_at`;
  try {
    const row=await db.prepare(sql).bind(user,chat,initial,now,now,...keys.map(key=>JSON.stringify(patch[key]))).first();
    if(!row) throw unavailable();return decode(row);
  } catch(error) {if(error instanceof TradingPreferencesError) throw error;throw unavailable();}
}
