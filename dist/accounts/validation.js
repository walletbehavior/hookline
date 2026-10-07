/** Data-only schemas. Nothing accepted here grants wallet or execution authority. */
export const WATCHLIST_MAX_BYTES=262144;
export const PREFERENCES_MAX_BYTES=8192;
export class AccountError extends Error {
  constructor(status,code,message,details={}) {super(message);this.name='AccountError';this.status=status;this.code=code;this.details=details;}
}
export function fail(status,code,message,details) {throw new AccountError(status,code,message,details);}
export function object(value,keys,label='Request') {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype) fail(422,'invalid_object',`${label} must be an ordinary JSON object.`);
  for(const key of Object.keys(value)) if(!keys.includes(key)) fail(422,'unsupported_field',`${label} contains an unsupported field.`);
  return value;
}
export function bytes(value,max,label) {
  let json;try {json=JSON.stringify(value);} catch {fail(422,'invalid_json',`${label} must contain JSON values.`);}
  if(typeof json!=='string'||new TextEncoder().encode(json).length>max) fail(413,'data_too_large',`${label} exceeds its storage limit.`);
  return json;
}
export function integer(value,min,max,code,label) {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) fail(422,code,`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
export function address(value) {
  if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value)||/^0x0{40}$/.test(value)) fail(422,'invalid_address','Enter a nonzero EVM wallet or contract address.');
  return value.toLowerCase();
}
function id(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) fail(422,'invalid_id','List and item IDs must be 1–120 plain identifier characters.');
  return value;
}
function label(value,max,field) {
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\u0000-\u001f\u007f<>\u202a-\u202e\u2066-\u2069]/u.test(value)) fail(422,'invalid_label',`${field} must be 1–${max} plain-text characters without markup, controls, or surrounding spaces.`);
  return value;
}
export function revision(value) {return integer(value,0,Number.MAX_SAFE_INTEGER-1,'invalid_revision','Revision');}

/** Explicit metadata projection of the website's v3 local model.
 * Callers omit local evidence/observations/errors, which are deliberately rejected.
 * No automatic local/cloud merge: PUT requires the last server revision.
 */
export function validateWatchlists(value) {
  bytes(value,WATCHLIST_MAX_BYTES,'Watchlists');object(value,['version','activeListId','lists'],'Watchlists');
  if(value.version!==3) fail(422,'invalid_watchlists_version','Watchlists must use version 3.');
  if(!Array.isArray(value.lists)||value.lists.length<1||value.lists.length>20) fail(422,'invalid_list_count','Save between one and twenty lists.');
  const listIds=new Set();let total=0;
  const lists=value.lists.map(list=>{
    object(list,['id','name','createdAt','items'],'List');const listId=id(list.id);
    if(listIds.has(listId)) fail(422,'duplicate_list','List IDs must be unique.');listIds.add(listId);
    if(!Array.isArray(list.items)||list.items.length>100) fail(422,'invalid_item_count','Each list can contain at most 100 items.');
    total+=list.items.length;if(total>500) fail(422,'too_many_items','Save at most 500 items across all lists.');
    const itemIds=new Set(),targets=new Set();
    const items=list.items.map(item=>{
      object(item,['id','chainId','address','label'],'Watchlist item');const itemId=id(item.id);
      const chainId=integer(item.chainId,1,4294967295,'invalid_chain','Chain ID');const target=address(item.address);
      if(itemIds.has(itemId)||targets.has(`${chainId}:${target}`)) fail(422,'duplicate_item','Each list must have unique item IDs and chain/address pairs.');
      itemIds.add(itemId);targets.add(`${chainId}:${target}`);
      return {id:itemId,chainId,address:target,label:item.label===null||item.label===undefined?null:label(item.label,80,'Item label')};
    });
    return {id:listId,name:label(list.name,60,'List name'),createdAt:integer(list.createdAt,0,8640000000000000,'invalid_timestamp','List creation time'),items};
  });
  const activeListId=id(value.activeListId);
  if(!listIds.has(activeListId)) fail(422,'invalid_active_list','The active list must exist in the saved lists.');
  return {version:3,activeListId,lists};
}

export function defaultAccountPreferences() {return {slippageBps:50,buyPresets:['0.01','0.05','0.1','1'],sellPresets:[25,50,75,100]};}
export function validatePreferencesPatch(value) {
  bytes(value,PREFERENCES_MAX_BYTES,'Preferences');object(value,['slippageBps','buyPresets','sellPresets'],'Preferences');
  if(!Object.keys(value).length) fail(422,'empty_patch','Choose a preference to update.');
  const result={};
  if(Object.hasOwn(value,'slippageBps')) result.slippageBps=integer(value.slippageBps,1,5000,'invalid_slippage','Slippage basis points');
  if(Object.hasOwn(value,'buyPresets')) {
    if(!Array.isArray(value.buyPresets)||value.buyPresets.length<1||value.buyPresets.length>6) fail(422,'invalid_buy_presets','Choose one to six buy amounts.');
    const seen=new Set();result.buyPresets=value.buyPresets.map(amount=>{
      if(typeof amount!=='string'||amount.length>80||!/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(amount)||!/[1-9]/.test(amount)) fail(422,'invalid_buy_amount','Buy amounts must be positive plain decimal strings, at most 80 characters with up to 36 decimal places.');
      const canonical=amount.includes('.')?amount.replace(/0+$/,'').replace(/\.$/,''):amount;
      if(seen.has(canonical)) fail(422,'duplicate_buy_amount','Buy amounts must be distinct.');seen.add(canonical);return amount;
    });
  }
  if(Object.hasOwn(value,'sellPresets')) {
    if(!Array.isArray(value.sellPresets)||value.sellPresets.length<1||value.sellPresets.length>6) fail(422,'invalid_sell_presets','Choose one to six sell percentages.');
    result.sellPresets=value.sellPresets.map(percent=>integer(percent,1,100,'invalid_sell_percentage','Sell percentage'));
    if(new Set(result.sellPresets).size!==result.sellPresets.length) fail(422,'duplicate_sell_percentage','Sell percentages must be distinct.');
  }
  return result;
}

/** Trusted bot context only: never construct these values from command text. */
export function privateTelegramIdentity({userId,chatId,fromId,chatType}={}) {
  const values=[userId,chatId,fromId];
  if(chatType!=='private'||values.some(v=>(typeof v!=='string'&&typeof v!=='number')||(typeof v==='number'&&!Number.isSafeInteger(v)))) fail(403,'private_chat_required','Link your account in a private conversation with the Hookline bot.');
  const [user,chat,from]=values.map(String);
  if(!/^[1-9][0-9]{0,19}$/.test(user)||user!==chat||user!==from) fail(403,'private_chat_required','Link your account in a private conversation with the Hookline bot.');
  return user;
}
