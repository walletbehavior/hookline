import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PrivyProvider,usePrivy,useLogin,useConnectWallet,useWallets,useCreateWallet,useExportWallet} from '@privy-io/react-auth';
import {defineChain} from 'viem';
import {base,mainnet,bsc,arbitrum} from 'viem/chains';

// Public application ID only. No app secret, server signer, session key,
// sponsorship, delegated signing, or transaction submission lives in this module.
const APP_ID='cmuypbaog002j0cl844ch92b3';
const robinhood=defineChain({id:4663,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
  rpcUrls:{default:{http:['https://rpc.mainnet.chain.robinhood.com']}},
  blockExplorers:{default:{name:'Robinhood Explorer',url:'https://explorer.mainnet.chain.robinhood.com'}}});
const addressPattern=/^0x[0-9a-f]{40}$/i;

function WalletPanel({bridge,control}) {
  const {ready,authenticated,logout}=usePrivy();
  const {wallets,ready:walletsReady}=useWallets();
  const {createWallet}=useCreateWallet();
  const {exportWallet}=useExportWallet();
  const [open,setOpen]=useState(true),[busy,setBusy]=useState(false),[sdkModal,setSdkModal]=useState(false),[message,setMessage]=useState('');
  const panel=useRef(null);
  const {login}=useLogin({onComplete:()=>{setBusy(false);setSdkModal(false);setMessage('Signed in. Choose a wallet below.');},
    onError:()=>{setBusy(false);setSdkModal(false);setMessage('Sign-in was not completed. You can try another method.');}});
  const {connectWallet}=useConnectWallet({onSuccess:()=>{setBusy(false);setSdkModal(false);setMessage('Wallet connected. Select it below.');},
    onError:()=>{setBusy(false);setSdkModal(false);setMessage('Wallet connection was not completed.');}});
  const available=wallets.filter(wallet=>addressPattern.test(wallet.address));
  const embedded=available.find(wallet=>wallet.walletClientType==='privy');
  control.open=()=>setOpen(true);control.isBusy=()=>busy;
  useEffect(()=>{
    if(!open || sdkModal) return;
    const previous=document.activeElement;
    const previousOverflow=document.body.style.overflow;
    const background=[...document.body.children].filter(node=>node.id!=='hookline-wallet-root').map(node=>[node,node.inert]);
    background.forEach(([node])=>{node.inert=true;});document.body.style.overflow='hidden';
    panel.current?.querySelector('button:not(:disabled)')?.focus();
    return ()=>{background.forEach(([node,inert])=>{node.inert=inert;});document.body.style.overflow=previousOverflow;if(previous?.isConnected)previous.focus();};
  },[open,sdkModal]);
  const blocked=()=>bridge.isBusy();
  async function act(action,{modal=false}={}) {
    if(busy) return;
    if(blocked()){setMessage('Finish the current wallet or account request first.');return;}
    setBusy(true);setSdkModal(modal);setMessage('');
    try {await action();} catch {setMessage('That wallet action did not finish. No trade was sent by this panel.');}
    finally {setBusy(false);setSdkModal(false);}
  }
  function startLogin() {
    if(!ready || busy || blocked()) return;
    setBusy(true);setSdkModal(true);setMessage('');
    // Only dashboard-enabled methods appear. Do not advertise unconfigured
    // Apple/Telegram credentials or treat login()'s void return as completion.
    login({walletChainType:'ethereum-only'});
  }
  function startWalletConnection() {
    if(!ready || busy || blocked()) return;
    setBusy(true);setSdkModal(true);setMessage('');
    connectWallet({walletChainType:'ethereum-only'});
  }
  async function select(wallet) {
    const provider=await wallet.getEthereumProvider();
    const accounts=await provider.request({method:'eth_accounts'});
    if(!accounts?.some(address=>String(address).toLowerCase()===wallet.address.toLowerCase())) throw new Error('Wallet mismatch.');
    await bridge.select({provider,address:wallet.address.toLowerCase(),embedded:wallet.walletClientType==='privy'});
    setOpen(false);
  }
  function keys(event) {
    if(sdkModal) return;
    if(event.key==='Escape'&&!busy){event.preventDefault();setOpen(false);}
    if(event.key!=='Tab')return;
    const buttons=[...panel.current.querySelectorAll('button:not(:disabled),a[href]')];
    if(!buttons.length)return;
    if(event.shiftKey&&document.activeElement===buttons[0]){event.preventDefault();buttons.at(-1).focus();}
    else if(!event.shiftKey&&document.activeElement===buttons.at(-1)){event.preventDefault();buttons[0].focus();}
  }
  if(!open || sdkModal)return null;
  return <div className="wallet-setup-overlay" onKeyDown={keys}>
    <section className="wallet-setup-panel" role="dialog" aria-modal="true" aria-labelledby="wallet-setup-title" ref={panel}>
      <header><div><p className="panel-kicker">YOUR WALLET</p><h2 id="wallet-setup-title">Sign in. Bring or create a wallet.</h2></div><button aria-label="Close wallet setup" disabled={busy} onClick={()=>setOpen(false)}>×</button></header>
      <p>Use a supported sign-in method or connect an existing wallet. Creating a wallet is optional.</p>
      {!authenticated&&<button className="btn btn-primary" disabled={!ready||busy} onClick={startLogin}>{ready?'Sign in or connect wallet':'Loading secure sign-in…'}</button>}
      {!authenticated&&<button disabled={busy} onClick={()=>void act(async()=>{await bridge.connectBrowser();setOpen(false);})}>Use browser wallet without social login</button>}
      {authenticated&&!walletsReady&&<p role="status">Loading your wallets…</p>}
      {walletsReady&&available.map(wallet=><div className="wallet-setup-card" key={wallet.address}>
        <strong>{wallet.walletClientType==='privy'?'Your embedded wallet':wallet.walletClientType || 'Connected wallet'}</strong>
        <code>{wallet.address}</code><div className="account-actions">
          <button disabled={busy} onClick={()=>void act(()=>select(wallet))}>Use this wallet</button>
          <button disabled={busy} onClick={()=>void act(async()=>{await navigator.clipboard.writeText(wallet.address);setMessage('Address copied.');})}>Copy address</button>
          {wallet.walletClientType==='privy'&&<button disabled={busy} onClick={()=>void act(()=>exportWallet({address:wallet.address}),{modal:true})}>Secure export</button>}
        </div>
      </div>)}
      {authenticated&&<button disabled={!ready||busy} onClick={startWalletConnection}>Connect another wallet</button>}
      {authenticated&&walletsReady&&!embedded&&<button disabled={busy} onClick={()=>void act(async()=>{await createWallet();setMessage('Wallet created. Select it above to use it.');},{modal:true})}>Create my wallet</button>}
      {authenticated&&<button disabled={busy} onClick={()=>void act(async()=>{
        await bridge.beforeLogout(available.map(wallet=>wallet.address.toLowerCase()));
        await logout();await bridge.disconnected();setMessage('Wallet login signed out. Your wallet still exists.');
      })}>Sign out of wallet login</button>}
      <p className="note">You confirm each signature. No automatic orders or sponsored gas. Embedded wallets are not smart accounts.</p>
      <p className="note">Return with the same login to recover the same embedded wallet. A different, unlinked login can create a separate account.</p>
      <p className="note">Export opens Privy's secure window. Never share a key or send it to the bot.</p>
      <p role="status">{message || (busy?'Working…':'')}</p>
    </section>
  </div>;
}

export function mountWallets(bridge) {
  const host=document.createElement('div');host.id='hookline-wallet-root';document.body.appendChild(host);
  const root=createRoot(host),control={open:()=>{},isBusy:()=>true};
  root.render(<PrivyProvider appId={APP_ID} config={{
    appearance:{theme:'dark',accentColor:'#bd8662',walletChainType:'ethereum-only'},
    embeddedWallets:{ethereum:{createOnLogin:'off'},showWalletUIs:true},
    defaultChain:base,supportedChains:[base,mainnet,bsc,arbitrum,robinhood],
  }}><WalletPanel bridge={bridge} control={control}/></PrivyProvider>);
  return control;
}
