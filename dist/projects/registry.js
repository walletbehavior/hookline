// Identity is explicit and chain-aware. Never infer affiliation from a name/hash.
const addressPattern = /^0x[0-9a-f]{40}$/i;
const aliases = { 'diamond-hook-arrakis': 'arrakis', bunny: 'bunni', stakehut: 'steakhut' };
// Discovery labels are a small editorial taxonomy, not project claims.  Adding a
// label requires a reviewed code change; submitted profile metadata cannot add one.
export const DISCOVERY_CATEGORIES = Object.freeze({
  quantum: Object.freeze({ id: 'quantum', label: 'Quantum', description: 'Projects with a primary-source-described post-quantum or quantum-security mechanism.' }),
});
const discoveryTagPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
const discoveryStatus = new Set(['research-backed', 'unverified']);
export function projectId(name) {
  const id = String(name || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,48).replace(/-$/,'');
  return aliases[id] || id;
}
export function publicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function discoveryMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const categories = [...new Set((Array.isArray(value.categories) ? value.categories : [])
    .map(category => String(category || '').toLowerCase()).filter(category => Object.hasOwn(DISCOVERY_CATEGORIES, category)))];
  const tags = [...new Set((Array.isArray(value.tags) ? value.tags : [])
    .map(tag => String(tag || '').trim().toLowerCase()).filter(tag => discoveryTagPattern.test(tag)))].slice(0, 12);
  const status = discoveryStatus.has(value.status) ? value.status : 'unverified';
  if (!categories.length && !tags.length) return null;
  return {
    categories,
    tags,
    status,
    // This disclosure is deliberately carried with each record so an API client
    // cannot mistake a discovery listing for a verified integration.
    scope: 'Discovery metadata identifies a documented project theme. It does not verify tokens, deployments, ownership, affiliation, or endorsement.',
  };
}
export function discoveryIndex(projects) {
  const categories = Object.values(DISCOVERY_CATEGORIES).map(category => ({ ...category,
    projectCount: projects.filter(project => project.discovery?.categories?.includes(category.id)).length,
  })).filter(category => category.projectCount > 0);
  const tagCounts = new Map();
  for (const project of projects) for (const tag of project.discovery?.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  const tags = [...tagCounts].map(([id, projectCount]) => ({ id, label: id, projectCount })).sort((a,b) => b.projectCount - a.projectCount || a.id.localeCompare(b.id));
  return { categories, tags,
    scope: 'Discovery filters group documented project themes; they are not verification of tokens, deployments, ownership, affiliation, or endorsement.' };
}
export function createProjectRegistry(board, seeds) {
  const byId = new Map();
  for (const item of board.projects || []) {
    if (!item.name || item.name === 'Andre Cronje') continue;
    const id = projectId(item.name);
    const match = String(item.hookId || '').match(/^(\d+)_(0x[0-9a-f]{40})$/i);
    const website = publicUrl(item.website);
    byId.set(id, {
      id, name: item.name, summary: String(item.description || '').slice(0,600),
      category: String(item.type || 'Ecosystem').split(',')[0].trim(), website,
      provenance: 'community directory record', sourceObservedAt: board.generatedAt || null,
      sources: [{ label: 'Community hook directory', url: 'https://www.v4.xyz/' }],
      deployments: match ? [{ chainId:Number(match[1]), address:match[2].toLowerCase(), role:'hook', name:item.name,
        provenance:'community directory relationship', sourceUrl:'https://www.v4.xyz/', monitor:false }] : [],
    });
  }
  for (const item of seeds.projects || []) {
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(item.id)) throw new Error('Invalid project ID');
    // Researched records replace legacy metadata, including unverified relationships.
    byId.set(item.id, structuredClone(item));
  }
  const hooks = new Map((board.hooks || []).map(h => [`${h.chainId}:${h.address.toLowerCase()}`,h]));
  const projects = [...byId.values()].map(project => {
    const seen = new Set();
    project.website = publicUrl(project.website);
    project.sources = (project.sources || []).filter(s => publicUrl(s.url)).map(s=>({label:String(s.label),url:publicUrl(s.url)}));
    project.discovery = discoveryMetadata(project.discovery);
    project.deployments = (project.deployments || []).filter(d=> {
      const key = `${d.chainId}:${String(d.address).toLowerCase()}`;
      if (!Number.isSafeInteger(d.chainId) || d.chainId<=0 || !addressPattern.test(d.address) || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(d=>{
      const address=d.address.toLowerCase(); const indexed=hooks.get(`${d.chainId}:${address}`);
      return { ...d, address, sourceUrl:publicUrl(d.sourceUrl), ...(indexed ? {
        pools:indexed.numberOfPools ?? null, swaps:indexed.numberOfSwaps ?? null,
        indexedAt:board.generatedAt || null, indexSource:'v4.xyz community snapshot',
      } : {}) };
    });
    project.coverage = { linkedDeployments:project.deployments.length,
      monitoredDeployments:project.deployments.filter(d=>d.monitor===true).length };
    return project;
  }).sort((a,b)=>a.name.localeCompare(b.name));
  return {schemaVersion:2,generatedAt:seeds.generatedAt || board.generatedAt,projects,
    discovery:discoveryIndex(projects)};
}

export function mergeProjectOverrides(registry, overrides) {
  const byId = new Map(registry.projects.map(p=>[p.id,p]));
  for (const [id,edit] of Object.entries(overrides || {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id) || !edit || !['domain-verified','community-reviewed'].includes(edit.metadataProvenance)) continue;
    // Only the approved contribution reader can supply this overlay. Contract
    // relationships and observations are never copied out of submitted fields.
    const base=byId.get(id) || {id,name:id,summary:'',website:null,category:'Ecosystem',
      provenance:'reviewed project submission',sources:[],deployments:[],
      coverage:{linkedDeployments:0,monitoredDeployments:0},affiliation:'unverified'};
    const source=publicUrl(edit.metadataSourceUrl);
    byId.set(id,{...base,
      name:typeof edit.name==='string' ? edit.name.slice(0,100) : base.name,
      summary:typeof edit.summary==='string' ? edit.summary.slice(0,600) : base.summary,
      website:publicUrl(edit.website) || base.website,
      metadataProvenance:edit.metadataProvenance,
      metadataSourceUrl:source,
      metadataUpdatedAt:edit.metadataUpdatedAt || null,
      metadataRevision:Number.isSafeInteger(edit.metadataRevision)?edit.metadataRevision:null,
      ...(!byId.has(id) && source ? {sources:[{label:'Reviewed submission source',url:source}]} : {}),
    });
  }
  const projects=[...byId.values()];
  const sorted=projects.sort((a,b)=>a.name.localeCompare(b.name));
  return {...registry,projects:sorted,discovery:discoveryIndex(sorted)};
}
