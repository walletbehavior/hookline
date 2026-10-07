// Trusted operator bridge. The review credential never enters command output,
// a source file, a URL, or a public browser. Decisions use the production API.
import { execFileSync,spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root=resolve(import.meta.dirname,'..');
const origin='https://hookline.world';
const service='world.hookline.project-review';
const account='hookline-review-agent';
function keychainToken() {
  if(process.env.HOOKLINE_PROJECT_REVIEW_TOKEN) return process.env.HOOKLINE_PROJECT_REVIEW_TOKEN;
  try {return execFileSync('/usr/bin/security',['find-generic-password','-a',account,'-s',service,'-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}
  catch {throw new Error('Project review credential is not configured on this host.');}
}
export async function reviewApi(path,{method='GET',body,token=keychainToken(),fetcher=fetch}={}) {
  if(!/^\/api\/project-submissions(?:\/review-queue|\/[a-f0-9-]{36}\/review)$/.test(path) && !['/api/project-maintenance/scan','/api/project-maintenance/bot-status'].includes(path)) throw new Error('Review endpoint not allowed.');
  if(typeof token!=='string'||token.length<32) throw new Error('Review credential is unavailable.');
  const response=await fetcher(`${origin}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(path.endsWith('/scan')?55000:15000),
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok) throw new Error(`Review API ${response.status}: ${data?.error?.code || 'request_failed'}`);
  return data;
}
async function setup() {
  // Setup is intentionally explicit, never performed by a scheduled review.
  let token;try{token=keychainToken();}catch{token=randomBytes(32).toString('base64url');}
  const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
  await new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,[wrangler,'secret','put','PROJECT_REVIEW_TOKEN','--config','wrangler.jsonc'],{cwd:root,stdio:['pipe','ignore','pipe']});
    let failed='';child.stderr.on('data',chunk=>{failed+=String(chunk).slice(0,1000);});
    child.once('error',()=>reject(new Error('Unable to start Wrangler.')));
    child.once('close',code=>code===0?resolveRun():reject(new Error('Cloudflare review-secret configuration failed. Check account access.')));
    child.stdin.end(`${token}\n`);
  });
  // macOS stores the operator secret encrypted rather than in the checkout.
  try {execFileSync('/usr/bin/security',['add-generic-password','-U','-a',account,'-s',service,'-w',token],{stdio:'ignore'});}
  catch {throw new Error('Cloudflare was configured, but local credential storage failed. Re-run setup before enabling the review schedule.');}
  console.log(JSON.stringify({configured:true,credentialStore:'macOS Keychain',origin}));
}
export async function main(args=process.argv.slice(2)) {
  const [command,id,decisionFile]=args;
  if(command==='setup'&&id==='--configure-hookline') return setup();
  if(command==='scan') {console.log(JSON.stringify(await reviewApi('/api/project-maintenance/scan',{method:'POST'})));return;}
  if(command==='bot-status') {console.log(JSON.stringify(await reviewApi('/api/project-maintenance/bot-status')));return;}
  if(command==='queue') {
    const result=await reviewApi('/api/project-submissions/review-queue');
    const submissions=(result.submissions || []).slice(0,5).map(({id,kind,projectId,createdAt,payload})=>({
      id,kind,projectId,createdAt,payload:{name:payload.name,website:payload.website,description:payload.description,
        contracts:payload.contracts,proofUrl:payload.proofUrl,message:payload.message}}));
    console.log(JSON.stringify({submissions,remainingAfterThisBatch:Math.max(0,(result.submissions || []).length-submissions.length)},null,2));return;
  }
  if(command==='review'&&/^[a-f0-9-]{36}$/.test(id || '')&&decisionFile) {
    const raw=readFileSync(resolve(decisionFile),'utf8');
    if(Buffer.byteLength(raw)>16*1024) throw new Error('Decision exceeds the request limit.');
    const decision=JSON.parse(raw);
    console.log(JSON.stringify(await reviewApi(`/api/project-submissions/${id}/review`,{method:'POST',body:decision}),null,2));return;
  }
  throw new Error('Use: node scripts/project-review.mjs queue | review <id> <decision.json> | setup --configure-hookline');
}
if(import.meta.url===pathToFileURL(process.argv[1] || '').href) main().catch(error=>{
  console.error(error?.message?.startsWith('Review API')?error.message:'Project review command failed. Check configuration or arguments.');
  process.exitCode=1;
});
