import { createProjectRegistry,mergeProjectOverrides } from './registry.js';
import { latestProjectObservations,listProjectEvents,projectActivitySummary,projectMonitoring,PROJECT_SIGNAL_TYPES } from './evidence.js';
import { handleContributionRequest,readProjectOverrides,readProjectAuthority } from './contributions.js';
import { READERS,readerDefinitionsForDeployment } from './reader-definitions.js';

const sourceRegistries=new WeakMap(), publicRegistries=new WeakMap(), runtimeIndexes=new WeakMap();
const FINGERPRINT=/^[0-9a-f]{64}$/;
const DEPLOYMENT_ID=/^(\d+)_(0x[0-9a-f]{40})$/;

function runtimeIndex(assets) {
  if(runtimeIndexes.has(assets)) return runtimeIndexes.get(assets);
  let source={};try{source=JSON.parse(assets.runtimeFamilies || '{}');}catch{source={};}
  const deployments=new Map(),families=new Map(),familyByDeployment=new Map();
  for(const item of Array.isArray(source.deployments)?source.deployments:[]) {
    const id=String(item?.id || '').toLowerCase(),match=id.match(DEPLOYMENT_ID);
    if(!match || !FINGERPRINT.test(String(item.fingerprint || '').toLowerCase())) continue;
    deployments.set(id,{id,chainId:Number(match[1]),address:match[2],name:typeof item.name==='string'?item.name.slice(0,120):null});
  }
  for(const item of Array.isArray(source.families)?source.families:[]) {
    const fingerprint=String(item?.runtimeFingerprint || '').toLowerCase();
    if(!FINGERPRINT.test(fingerprint)) continue;
    const ids=[...new Set((Array.isArray(item.deployments)?item.deployments:[]).map(value=>String(value).toLowerCase()).filter(value=>DEPLOYMENT_ID.test(value)))];
    const family={runtimeFingerprint:fingerprint,codeByteLength:Number.isSafeInteger(item.codeByteLength)&&item.codeByteLength>=0?item.codeByteLength:null,
      deploymentCount:Number.isSafeInteger(item.deploymentCount)&&item.deploymentCount>=ids.length?item.deploymentCount:ids.length,
      chainIds:[...new Set(ids.map(id=>Number(id.split('_')[0])))],representativeName:typeof item.representativeName==='string'?item.representativeName.slice(0,120):null,
      deployments:ids};
    families.set(fingerprint,family);ids.forEach(id=>familyByDeployment.set(id,fingerprint));
  }
  const value={generatedAt:source.generatedAt || null,source:source.source || null,deployments,families,familyByDeployment};
  runtimeIndexes.set(assets,value);return value;
}

function runtimeCoverage(project,assets) {
  const index=runtimeIndex(assets),families=new Set();
  for(const deployment of project.deployments || []) {
    if(deployment.role!=='hook') continue;
    const fingerprint=index.familyByDeployment.get(`${deployment.chainId}_${deployment.address}`);
    if(fingerprint) families.add(fingerprint);
  }
  return {runtimeFamilies:families.size,repeatedRuntimeFamilies:[...families].filter(value=>(index.families.get(value)?.deploymentCount || 0)>1).length};
}

function evidenceCoverage(project) {
  const deployments=Array.isArray(project.deployments)?project.deployments:[];
  const monitored=deployments.filter(item=>item.monitor===true).length;
  const sourceBound=deployments.map(item=>readerDefinitionsForDeployment(project.id,item))
    .filter(definitions=>definitions.reads.length || definitions.events.length);
  const reader=READERS[project.id];
  const eventTypes=new Set(sourceBound.flatMap(definitions=>definitions.events.map(event=>event.key))).size;
  const readTypes=new Set(sourceBound.flatMap(definitions=>definitions.reads.map(read=>read.key))).size;
  if(sourceBound.length) return {level:'source_bound',label:'Source-bound reader',sourceBoundDeployments:sourceBound.length,
    readTypes,eventTypes,readerVersion:reader?.version || null};
  if(monitored) return {level:'pinned_state',label:'Pinned contract state',sourceBoundDeployments:0,readTypes:0,eventTypes:0,readerVersion:null};
  if(deployments.length) return {level:'linked_only',label:'Linked deployments',sourceBoundDeployments:0,readTypes:0,eventTypes:0,readerVersion:null};
  return {level:'directory_only',label:'Directory record',sourceBoundDeployments:0,readTypes:0,eventTypes:0,readerVersion:null};
}

function projectRuntimeFamilies(project,observations,registry,assets) {
  const index=runtimeIndex(assets),hookIds=new Set((project.deployments || []).filter(item=>item.role==='hook').map(item=>`${item.chainId}_${item.address}`));
  const fingerprints=new Set([...hookIds].map(id=>index.familyByDeployment.get(id)).filter(Boolean));
  for(const observation of observations || []) {
    const id=`${observation.chainId}_${String(observation.address || '').toLowerCase()}`,fingerprint=String(observation.fields?.runtimeFingerprint || '').toLowerCase();
    if(hookIds.has(id)&&FINGERPRINT.test(fingerprint)&&index.families.has(fingerprint)) fingerprints.add(fingerprint);
  }
  return [...fingerprints].map(fingerprint=>{
    const family=index.families.get(fingerprint),familyIds=new Set(family.deployments);
    const current=[...hookIds].filter(id=>familyIds.has(id)).map(id=>index.deployments.get(id) || deploymentFromId(id)).filter(Boolean);
    const relatedProjects=(registry.projects || []).filter(other=>other.id!==project.id).map(other=>{
      const matches=(other.deployments || []).filter(item=>item.role==='hook'&&familyIds.has(`${item.chainId}_${item.address}`));
      return matches.length?{id:other.id,name:other.name,deployments:matches.map(item=>({chainId:item.chainId,address:item.address,name:item.name || null}))}:null;
    }).filter(Boolean).slice(0,12);
    const other=family.deployments.filter(id=>!hookIds.has(id)).slice(0,20).map(id=>index.deployments.get(id) || deploymentFromId(id)).filter(Boolean);
    return {...family,projectDeployments:current,relatedProjects,otherDeployments:other,
      additionalDeploymentCount:Math.max(0,family.deploymentCount-current.length-other.length),
      evidence:{kind:'exact runtime bytecode family',generatedAt:index.generatedAt,source:index.source || '/data/runtime-families.json',scope:'Byte-identical deployed runtime only; not proof of affiliation, ownership, or identical configuration.'}};
  }).sort((a,b)=>b.deploymentCount-a.deploymentCount || a.runtimeFingerprint.localeCompare(b.runtimeFingerprint));
}

function deploymentFromId(id) {
  const match=String(id).match(DEPLOYMENT_ID);return match?{id,chainId:Number(match[1]),address:match[2],name:null}:null;
}
export function canonicalProjectRegistry(assets) {
  if (!sourceRegistries.has(assets)) sourceRegistries.set(assets,createProjectRegistry(JSON.parse(assets.hooks),JSON.parse(assets.projects)));
  return sourceRegistries.get(assets);
}
export function projectContext(assets,env) {
  const registry=canonicalProjectRegistry(assets);
  return {getCanonicalProject:async id=>{
      const base=registry.projects.find(p=>p.id===id) || null;
      const authority=env?await readProjectAuthority(env,id):null;
      return authority?{...base,...authority}:base;
    },
    getProject:async id=>(env?await publicProjectRegistry(env,assets):registry).projects.find(p=>p.id===id) || null,
    getRuntimeFamily:async value=>{
      const prefix=String(value || '').trim().toLowerCase();
      if(!/^[0-9a-f]{16,64}$/.test(prefix)) return null;
      const matches=[...runtimeIndex(assets).families.values()].filter(family=>family.runtimeFingerprint.startsWith(prefix));
      return matches.length===1?matches[0]:null;
    },
    listProjects:async()=>(env?await publicProjectRegistry(env,assets):registry).projects};
}
function reply(body,status=200,cache=30) {
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':cache>0?`public, max-age=${cache}`:'no-store','X-Content-Type-Options':'nosniff',
    'Access-Control-Allow-Origin':'*'}});
}
export async function publicProjectRegistry(env,assets) {
  const registry=canonicalProjectRegistry(assets);
  if (!env.DB) return registry;
  const cache=publicRegistries.get(env.DB);
  if(cache?.assets===assets && cache.until>Date.now()) return cache.value;
  const [overrides,counts]=await Promise.all([Promise.resolve().then(()=>readProjectOverrides(env)),Promise.resolve().then(()=>env.DB.prepare(`SELECT project_id,
    COUNT(DISTINCT chain_id || ':' || address) AS observations, MAX(observed_at) AS latest
    FROM project_observations WHERE canonical=1 GROUP BY project_id`).all())]);
  const coverage=new Map((counts.results || []).map(r=>[r.project_id,r]));
  const merged=mergeProjectOverrides(registry,overrides);
  const value={...merged,projects:merged.projects.map(p=>({...p,evidenceCoverage:evidenceCoverage(p),
    coverage:{...p.coverage,...runtimeCoverage(p,assets),observedDeployments:Number(coverage.get(p.id)?.observations || 0)},
    latestObservedAt:coverage.get(p.id)?.latest?new Date(coverage.get(p.id).latest).toISOString():null}))};
  publicRegistries.set(env.DB,{assets,value,until:Date.now()+60000});
  return value;
}
export async function handleProjectsApi(request,env,assets) {
  const url=new URL(request.url), path=url.pathname;
  if (path.startsWith('/api/project-submissions')) {
    const context=projectContext(assets,env);
    return handleContributionRequest(request,env,{...context,getProject:context.getCanonicalProject});
  }
  if (!['/api/projects','/api/project-activity','/api/project-comparison'].includes(path) && !/^\/api\/projects\/[a-z0-9-]{1,60}$/.test(path)) return null;
  if (request.method!=='GET') return reply({error:'method_not_allowed'},405,0);
  try {
    const registry=await publicProjectRegistry(env,assets);
    if (path==='/api/projects') return reply(registry,200,60);
    if (path==='/api/project-activity') {
      const id=url.searchParams.get('project');
      if (id && !registry.projects.some(p=>p.id===id)) return reply({error:'project_not_found'},404,0);
      const focus=String(url.searchParams.get('focus') || 'important'),history=String(url.searchParams.get('history') || 'all');
      const signal=String(url.searchParams.get('signal') || 'all');
      if(!['all','important','configuration','outcome','accrual'].includes(focus) || !['all','current'].includes(history) || !PROJECT_SIGNAL_TYPES.includes(signal)) return reply({error:'invalid_activity_filter'},400,0);
      const now=Date.now();
      const [events,summary24h]=await Promise.all([listProjectEvents(env,id,60,{focus,history,signal}),projectActivitySummary(env,id,{now})]);
      return reply({schemaVersion:4,events,summary24h,filters:{project:id || null,focus,history,signal},generatedAt:new Date(now).toISOString(),
        coverage:'Monitored deployments and decoded event types only. Historical coverage begins at each retained scan window.'});
    }
    if (path==='/api/project-comparison') {
      const ids=[...new Set(String(url.searchParams.get('ids') || '').split(','))];
      if(ids.length<2 || ids.length>4 || ids.some(id=>!registry.projects.some(p=>p.id===id))) return reply({error:'provide_two_to_four_known_project_ids'},400,0);
      const projects=await Promise.all(ids.map(async id=>({project:registry.projects.find(p=>p.id===id),observations:await latestProjectObservations(env,id)})));
      return reply({schemaVersion:1,projects,comparisonScope:'Configuration and observed state at each named chain/block. Not normalized performance or risk rankings.'});
    }
    const id=path.split('/').pop(), project=registry.projects.find(p=>p.id===id);
    if (!project) return reply({error:'project_not_found'},404,0);
    const [observations,events,monitoring]=await Promise.all([latestProjectObservations(env,id),listProjectEvents(env,id),projectMonitoring(env,id,project.deployments)]);
    const related=registry.projects.filter(p=>p.id!==id && p.category===project.category).slice(0,8).map(p=>({...p,reason:'Shared mechanism category, not deployment affiliation'}));
    return reply({schemaVersion:2,project,observations,events,monitoring,runtimeFamilies:projectRuntimeFamilies(project,observations,registry,assets),related,generatedAt:new Date().toISOString()});
  } catch {
    return reply({error:'project_storage_temporarily_unavailable',message:'Project evidence is temporarily unavailable. Retry shortly.'},503,0);
  }
}
