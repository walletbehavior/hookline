import { createProjectRegistry,mergeProjectOverrides } from './registry.js';
import { latestProjectObservations,listProjectEvents,projectMonitoring } from './evidence.js';
import { handleContributionRequest,readProjectOverrides,readProjectAuthority } from './contributions.js';

const sourceRegistries=new WeakMap(), publicRegistries=new WeakMap();
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
  const value={...merged,projects:merged.projects.map(p=>({...p,
    coverage:{...p.coverage,observedDeployments:Number(coverage.get(p.id)?.observations || 0)},
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
      return reply({schemaVersion:1,events:await listProjectEvents(env,id),generatedAt:new Date().toISOString(),
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
    const [observations,events,monitoring]=await Promise.all([latestProjectObservations(env,id),listProjectEvents(env,id),projectMonitoring(env,id)]);
    const related=registry.projects.filter(p=>p.id!==id && p.category===project.category).slice(0,8).map(p=>({...p,reason:'Shared mechanism category, not deployment affiliation'}));
    return reply({schemaVersion:1,project,observations,events,monitoring,related,generatedAt:new Date().toISOString()});
  } catch {
    return reply({error:'project_storage_temporarily_unavailable',message:'Project evidence is temporarily unavailable. Retry shortly.'},503,0);
  }
}
