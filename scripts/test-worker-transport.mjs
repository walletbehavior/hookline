import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';

// Run the real transport with workerd Request semantics, not Node's broader
// Fetch implementation. The injected service never makes an external call.
const source=readFileSync(new URL('../projects/rpc-pool.js',import.meta.url),'utf8');
const script=source+`
export default {async fetch(request) {
  let calls=0;
  const redirect=new URL(request.url).pathname==='/redirect';
  const pool=createProjectRpcPool({maxRequests:4,fetchImpl:async(url,options)=>{
    const req=new Request(url,options);calls++;
    if(req.redirect!=='manual')throw new Error('redirect_not_blocked');
    const input=await req.json();
    if(redirect)return new Response('',{status:302,headers:{location:'https://untrusted.example'}});
    return Response.json({jsonrpc:'2.0',id:input.id,result:'0x1'});
  }});
  try {return Response.json({result:await pool.rpc(1,'eth_chainId',[]),calls});}
  catch(error){return Response.json({error:error.message,calls});}
}}`;
const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-22',script});
try {
  assert.deepEqual(await (await mf.dispatchFetch('http://local/')).json(),{result:'0x1',calls:1});
  const redirected=await (await mf.dispatchFetch('http://local/redirect')).json();
  assert.equal(redirected.error,'rpc_provider_unavailable');assert.equal(redirected.calls,2);
  for(const path of ['../worker/index.js','../projects/contributions.js']) {
    const code=readFileSync(new URL(path,import.meta.url),'utf8');
    assert.doesNotMatch(code,/redirect:\s*['"]error['"]/);
    assert.match(code,/redirect:\s*['"]manual['"]/);
  }
  console.log('Worker transport: real edge Request semantics accepted; redirects are not followed.');
} finally {await mf.dispose();}
