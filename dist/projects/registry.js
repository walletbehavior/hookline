// Identity is explicit and chain-aware. Never infer affiliation from a name/hash.
const addressPattern = /^0x[0-9a-f]{40}$/i;
const aliases = { 'diamond-hook-arrakis': 'arrakis', bunny: 'bunni', stakehut: 'steakhut' };
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
  return {schemaVersion:1,generatedAt:seeds.generatedAt || board.generatedAt,projects};
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
  return {...registry,projects:projects.sort((a,b)=>a.name.localeCompare(b.name))};
}
