/** Signed-in data only. This module never prepares or submits a transaction. */
export function watchlistMetadata(model) {
  return {version:3,activeListId:model.activeListId,lists:model.lists.map(list=>({
    id:list.id,name:list.name,createdAt:list.createdAt,
    items:list.items.map(item=>({id:item.id,chainId:item.chainId,address:item.address,label:item.label || null})),
  }))};
}

export function restoreWatchlistMetadata(remote,local) {
  const observations=new Map();
  for(const list of local.lists) for(const item of list.items) {
    const key=`${item.chainId}:${item.address.toLowerCase()}`;
    const prior=observations.get(key);
    const history=[...new Map([...(prior?.observations || []),...(item.observations || [])]
      .map(entry=>[JSON.stringify(entry),entry])).values()]
      .sort((a,b)=>(Number(a.observedAt)||0)-(Number(b.observedAt)||0)).slice(-100);
    const evidenceTime=value=>Math.max(0,...(value?.observations || []).map(entry=>Number(entry.observedAt)||0));
    const newest=!prior || (item.evidence && (!prior.evidence || evidenceTime(item)>=prior.evidenceTime));
    const lastAttempt=!prior || (item.lastAttemptAt || 0)>=(prior.lastAttemptAt || 0)?item:prior;
    observations.set(key,{evidence:newest?item.evidence:prior.evidence,evidenceTime:newest?evidenceTime(item):prior.evidenceTime,
      observations:history,lastError:lastAttempt.lastError,lastAttemptAt:lastAttempt.lastAttemptAt});
  }
  const clean=watchlistMetadata(remote);
  return {...clean,lists:clean.lists.map(list=>({...list,items:list.items.map(item=>{
    const saved=observations.get(`${item.chainId}:${item.address.toLowerCase()}`);
    return {...item,evidence:saved?.evidence || null,observations:saved?.observations || [],
      lastError:saved?.lastError || null,lastAttemptAt:saved?.lastAttemptAt || null};
  })}))};
}

const countItems=model=>model?.lists?.reduce((sum,list)=>sum+list.items.length,0) || 0;
const hexText=text=>'0x'+Array.from(new TextEncoder().encode(text),byte=>byte.toString(16).padStart(2,'0')).join('');

export function mountAccounts(bridge) {
  const $=id=>document.getElementById(id);
  let session={authenticated:false},watchlists=null,preferences=null,telegram=null,busy=false,generation=0;
  function clearPrivateState() {
    watchlists=preferences=telegram=null;
    $('account-telegram-open').hidden=true;
    $('account-telegram-open').removeAttribute('href');
  }
  function notice(text,error=false) {
    $('account-status').textContent=text;
    $('account-status').classList.toggle('error',error);
  }
  async function api(path,options={}) {
    const requestedGeneration=generation;
    const response=await fetch(`/api/account/${path}`,{credentials:'same-origin',cache:'no-store',...options,
      headers:{'Content-Type':'application/json',...(session.csrfToken?{'X-Hookline-CSRF':session.csrfToken}:{}),...options.headers}});
    const body=await response.json();
    if(requestedGeneration!==generation) throw Object.assign(new Error('Account request superseded.'),{stale:true});
    if(!response.ok || body.ok===false) {
      const error=new Error(response.status===409?'The account changed in another tab or device. Refresh before choosing which copy to keep.':body.error?.message || 'Account request unavailable.');
      error.status=response.status;
      if(response.status===401) {generation++;session={authenticated:false};clearPrivateState();render();}
      throw error;
    }
    return body;
  }
  function render() {
    const signed=session.authenticated===true;
    $('top-account').textContent=signed?'Account':'Sign in';
    $('account-identity').textContent=signed?session.account.address:'Sync your desk';
    $('account-signin-section').hidden=signed;
    $('account-data-section').hidden=!signed;
    $('account-signout').hidden=!signed;
    $('account-signout-all').hidden=!signed;
    $('account-local-summary').textContent=`This device: ${bridge.getWatchlists().lists.length} lists, ${countItems(bridge.getWatchlists())} contracts.`;
    $('account-cloud-summary').textContent=watchlists?.watchlists
      ?`Account: ${watchlists.watchlists.lists.length} lists, ${countItems(watchlists.watchlists)} contracts. Revision ${watchlists.revision}.`
      :'No watchlists saved to this account yet.';
    $('account-save-lists').disabled=busy || !watchlists;
    $('account-load-lists').disabled=busy || !watchlists?.watchlists;
    $('account-save-preferences').disabled=busy || !preferences;
    $('account-load-preferences').disabled=busy || !preferences?.preferences;
    $('account-prefs-summary').textContent=preferences?.preferences
      ?`Account settings: ${preferences.preferences.slippageBps/100}% slippage, ${preferences.preferences.buyPresets.length} buy buttons, ${preferences.preferences.sellPresets.length} sell buttons.`
      :'No trade preferences saved to this account yet.';
    $('account-telegram-status').textContent=telegram?.linked?'Telegram linked. Trading authority is unchanged.':'Telegram is not linked.';
    $('account-telegram-link').hidden=Boolean(telegram?.linked);
    $('account-telegram-unlink').hidden=!telegram?.linked;
    for(const id of ['account-signin','account-refresh','account-signout','account-signout-all','account-telegram-link','account-telegram-unlink']) $(id).disabled=busy;
  }
  async function refresh() {
    clearPrivateState();
    session=await api('session');
    if(session.authenticated) [watchlists,preferences,telegram]=await Promise.all([api('watchlists'),api('preferences'),api('telegram-link')]);
    render();
  }
  async function perform(action) {
    if(busy) return;
    generation++;
    busy=true;render();
    try {await action();}
    catch(error) {if(!error.stale) notice(error.message || 'This action could not be completed.',true);}
    finally {busy=false;render();}
  }
  async function signIn() {
    if(bridge.isBusy()) throw new Error('Finish the current inspection or wallet request before signing in.');
    const {provider,account}=await bridge.connectWallet();
    const chainId=Number(BigInt(await provider.request({method:'eth_chainId'})));
    const challenge=await api('challenge',{method:'POST',body:JSON.stringify({address:account,chainId})});
    if(challenge.domain!=='hookline.world' || challenge.uri!=='https://hookline.world/' || challenge.chainId!==chainId
      || !/^https:\/\/hookline\.world wants you to sign in with your Ethereum account:\n/.test(challenge.message)
      || !challenge.message.toLowerCase().includes(account.toLowerCase())) throw new Error('The sign-in challenge did not match this site and wallet.');
    notice('Review the sign-in message in your wallet. This grants no spending permission.');
    // SDK confirmations render in a body portal. A native top-layer dialog
    // would cover them, so restore the account panel after the wallet finishes.
    const wasOpen=$('account-dialog').open;
    if(wasOpen) $('account-dialog').close();
    let signature;
    try {signature=await provider.request({method:'personal_sign',params:[hexText(challenge.message),account]});}
    finally {if(wasOpen&&!$('account-dialog').open) $('account-dialog').showModal();}
    const [accounts,currentChain]=await Promise.all([provider.request({method:'eth_accounts'}),provider.request({method:'eth_chainId'})]);
    if(!accounts?.some(value=>String(value).toLowerCase()===account.toLowerCase()) || Number(BigInt(currentChain))!==chainId) throw new Error('The wallet changed during sign-in. Start again.');
    await api('login',{method:'POST',body:JSON.stringify({challengeId:challenge.challengeId,signature})});
    await refresh();
    notice('Signed in. Choose Save or Load below. Nothing was overwritten.');
  }
  $('top-account').addEventListener('click',()=>{
    if(!$('account-dialog').open) $('account-dialog').showModal();
    void perform(async()=>{await refresh();notice('Your account and this device stay separate until you choose Save or Load.');});
  });
  $('account-close').addEventListener('click',()=>$('account-dialog').close());
  $('account-signin').addEventListener('click',()=>void perform(signIn));
  $('account-refresh').addEventListener('click',()=>void perform(async()=>{await refresh();notice('Account data refreshed.');}));
  for(const [id,path] of [['account-signout','logout'],['account-signout-all','logout-all']]) {
    $(id).addEventListener('click',()=>void perform(async()=>{
      await api(path,{method:'POST',body:'{}'});
      session={authenticated:false};clearPrivateState();
      notice('Signed out. The device copy is unchanged. Use Clear device copy if this is a shared browser.');
    }));
  }
  $('account-save-lists').addEventListener('click',()=>void perform(async()=>{
    watchlists=await api('watchlists',{method:'PUT',body:JSON.stringify({revision:watchlists.revision,watchlists:watchlistMetadata(bridge.getWatchlists())})});
    notice('Watchlist names and addresses saved to your account. Evidence stays on this device.');
  }));
  $('account-load-lists').addEventListener('click',()=>void perform(async()=>{
    if(bridge.isBusy()) throw new Error('Wait for the current inspection or wallet request to finish.');
    // A device-local backup protects against an accidental explicit Load. It is
    // never uploaded, and can be downloaded before clearing the device copy.
    localStorage.setItem('hookline:watchlists:before-account-load',JSON.stringify(bridge.getWatchlists()));
    bridge.setWatchlists(restoreWatchlistMetadata(watchlists.watchlists,bridge.getWatchlists()));
    notice('Account watchlists loaded. Matching local observations were kept, and the previous device copy was backed up.');
  }));
  $('account-save-preferences').addEventListener('click',()=>void perform(async()=>{
    preferences=await api('preferences',{method:'PUT',body:JSON.stringify({revision:preferences.revision,patch:bridge.getPreferences()})});
    notice('Slippage and buy/sell buttons saved. This does not place orders or grant permissions.');
  }));
  $('account-load-preferences').addEventListener('click',()=>void perform(async()=>{
    if(bridge.isBusy()) throw new Error('Finish the current wallet request first.');
    bridge.setPreferences(preferences.preferences);
    notice('Account trade preferences loaded on this device. Any open quote was invalidated.');
  }));
  $('account-telegram-link').addEventListener('click',()=>void perform(async()=>{
    const link=await api('telegram-link',{method:'POST',body:'{}'});
    if(!/^[A-Za-z0-9_-]{20,60}$/.test(link.token)) throw new Error('Invalid Telegram link.');
    $('account-telegram-open').href=`https://t.me/HooklineTradeBot?start=account_${encodeURIComponent(link.token)}`;
    $('account-telegram-open').hidden=false;
    notice('Open Telegram and tap Start in your private bot chat. Then refresh this panel. The link is single-use and expires shortly.');
  }));
  $('account-telegram-unlink').addEventListener('click',()=>void perform(async()=>{
    await api('telegram-link',{method:'DELETE'});telegram={linked:false};
    $('account-telegram-open').hidden=true;
    $('account-telegram-open').removeAttribute('href');
    notice('Telegram unlinked. Its existing alerts were not deleted.');
  }));
  $('account-clear-device').addEventListener('click',()=>{
    $('account-clear-confirm').hidden=false;
  });
  $('account-clear-cancel').addEventListener('click',()=>{$('account-clear-confirm').hidden=true;});
  $('account-clear-confirm-button').addEventListener('click',()=>void perform(async()=>{
    if(bridge.isBusy()) throw new Error('Finish the current inspection or wallet request first.');
    bridge.clearDevice();localStorage.removeItem('hookline:watchlists:before-account-load');
    $('account-clear-confirm').hidden=true;
    notice('Watchlists, local observations, market cache and trade preferences were removed from this browser. Account data and alerts were not deleted.');
  }));
  $('account-download-backup').addEventListener('click',()=>void perform(async()=>{
    const backup=localStorage.getItem('hookline:watchlists:before-account-load');
    if(!backup) throw new Error('No previous device copy is available.');
    const href=URL.createObjectURL(new Blob([backup],{type:'application/json'}));
    const a=document.createElement('a');a.href=href;a.download='hookline-watchlists-before-account-load.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(href),1000);
  }));
  // Read-only restoration. Opening the site never prompts a wallet signature.
  void api('session').then(result=>{session=result;render();}).catch(()=>{});
  render();
  return {localChanged(){render();},isBusy:()=>busy,
    async signOutMatching(addresses) {
      if(busy) throw new Error('Finish the current account request first.');
      generation++;busy=true;render();
      try {
        session=await api('session');
        if(session.authenticated && addresses.includes(session.account.address.toLowerCase())) {
          await api('logout',{method:'POST',body:'{}'});
          session={authenticated:false};clearPrivateState();
          notice('Signed out. The device copy is unchanged.');
        }
      } finally {busy=false;render();}
    },
  };
}
