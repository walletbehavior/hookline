const FINGERPRINT=/^[0-9a-f]{64}$/;
const ADDRESS=/^0x[0-9a-f]{40}$/;
const HASH=/^0x[0-9a-f]{64}$/;
const DAY=86400000;
const MAX_FOLLOWS=20;

const html=value=>String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const short=value=>`${String(value).slice(0,12)}...${String(value).slice(-10)}`;

async function digest(value) {
  const bytes=new TextEncoder().encode(String(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function normalizeRuntimeFingerprint(value) {
  const fingerprint=String(value || '').trim().toLowerCase();
  return FINGERPRINT.test(fingerprint)?fingerprint:null;
}

export async function followRuntimeFamily(env,{fingerprint,label,deployments=[],userId,chatId,enabled=true,now=Date.now()}) {
  if(!env?.DB) throw new Error('Runtime-family follows are temporarily unavailable.');
  fingerprint=normalizeRuntimeFingerprint(fingerprint);
  if(!fingerprint) throw new Error('Runtime fingerprint is invalid.');
  if(!/^[1-9][0-9]{0,19}$/.test(String(userId)) || String(userId)!==String(chatId)) throw new Error('Open the bot privately to manage follows.');
  const id=await digest(`${userId}:${chatId}:runtime:${fingerprint}`),safeLabel=String(label || '').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120) || null;
  const baseline=JSON.stringify([...new Set((Array.isArray(deployments)?deployments:[]).map(value=>String(value).toLowerCase())
    .filter(value=>/^[0-9]+_0x[0-9a-f]{40}$/.test(value)))].slice(0,2000));
  const row=await env.DB.prepare(`INSERT INTO runtime_family_follows(id,telegram_user_id,chat_id,fingerprint,label,baseline_deployments_json,created_at,enabled)
    SELECT ?,?,?,?,?,?,?,? WHERE ?=0
      OR EXISTS(SELECT 1 FROM runtime_family_follows WHERE telegram_user_id=? AND chat_id=? AND fingerprint=? AND enabled=1)
      OR (SELECT COUNT(*) FROM runtime_family_follows WHERE telegram_user_id=? AND enabled=1)<?
    ON CONFLICT(telegram_user_id,chat_id,fingerprint) DO UPDATE SET enabled=excluded.enabled,label=COALESCE(excluded.label,runtime_family_follows.label),
      baseline_deployments_json=CASE WHEN runtime_family_follows.enabled=0 AND excluded.enabled=1 THEN excluded.baseline_deployments_json ELSE runtime_family_follows.baseline_deployments_json END,
      created_at=CASE WHEN runtime_family_follows.enabled=0 AND excluded.enabled=1 THEN excluded.created_at ELSE runtime_family_follows.created_at END
    RETURNING fingerprint`).bind(id,String(userId),String(chatId),fingerprint,safeLabel,baseline,now,enabled?1:0,enabled?1:0,
      String(userId),String(chatId),fingerprint,String(userId),MAX_FOLLOWS).first();
  if(!row) throw new Error(`Runtime-family follow limit reached (${MAX_FOLLOWS}). Pause one first.`);
  return {fingerprint,enabled};
}

export async function runtimeFamilyFollows(env,userId,chatId=userId) {
  if(!env?.DB) return [];
  const rows=await env.DB.prepare(`SELECT fingerprint,label,enabled,created_at FROM runtime_family_follows
    WHERE telegram_user_id=? AND chat_id=? ORDER BY enabled DESC,created_at ASC LIMIT 40`).bind(String(userId),String(chatId)).all();
  return rows.results || [];
}

export async function recordRuntimeFamilyAppearances(env,{registry,now=Date.now()}={}) {
  if(!env?.DB) return {recorded:0};
  const projects=new Map((registry?.projects || []).map(project=>[project.id,project]));
  const rows=(await env.DB.prepare(`SELECT o.payload_json FROM project_observations o
    WHERE o.canonical=1 AND NOT EXISTS (SELECT 1 FROM project_observations n
      WHERE n.project_id=o.project_id AND n.chain_id=o.chain_id AND n.address=o.address AND n.canonical=1 AND n.block_number>o.block_number)
      AND NOT EXISTS (SELECT 1 FROM runtime_family_appearances a
        WHERE a.fingerprint=lower(json_extract(o.payload_json,'$.fields.runtimeFingerprint'))
          AND a.chain_id=o.chain_id AND a.address=o.address)
    ORDER BY o.observed_at ASC LIMIT 160`).all()).results || [];
  const statements=[];
  for(const row of rows) {
    let observation;try{observation=JSON.parse(row.payload_json);}catch{continue;}
    const fingerprint=normalizeRuntimeFingerprint(observation?.fields?.runtimeFingerprint),address=String(observation?.address || '').toLowerCase();
    const blockHash=String(observation?.blockHash || '').toLowerCase(),project=projects.get(observation?.projectId);
    if(!fingerprint || !ADDRESS.test(address) || !HASH.test(blockHash) || !project || !Number.isSafeInteger(Number(observation.blockNumber))) continue;
    const observedAt=Number.isFinite(Date.parse(observation.observedAt))?Date.parse(observation.observedAt):now;
    const id=await digest(`${fingerprint}:${observation.chainId}:${address}`);
    const evidence={kind:'first Hookline observation of exact runtime on monitored deployment',observationId:observation.id,
      readerVersion:observation.readerVersion || null,source:observation.source || null,scope:'Exact runtime bytecode only; not proof of affiliation or deployment time.'};
    statements.push(env.DB.prepare(`INSERT INTO runtime_family_appearances
      (id,fingerprint,chain_id,address,project_id,project_name,block_number,block_hash,observed_at,evidence_json)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint,chain_id,address) DO NOTHING`)
      .bind(id,fingerprint,Number(observation.chainId),address,project.id,String(project.name).slice(0,120),Number(observation.blockNumber),blockHash,observedAt,JSON.stringify(evidence)));
  }
  if(!statements.length) return {recorded:0};
  const results=await env.DB.batch(statements);
  return {recorded:results.reduce((sum,result)=>sum+Number(result?.meta?.changes || 0),0)};
}

export async function deliverRuntimeFamilyAppearances(env,{send,now=Date.now()}={}) {
  if(!env?.DB || typeof send!=='function') return {sent:0};
  const rows=(await env.DB.prepare(`SELECT f.id AS follow_id,f.chat_id,f.label,a.* FROM runtime_family_follows f
    JOIN runtime_family_appearances a ON a.fingerprint=f.fingerprint
    LEFT JOIN runtime_family_deliveries d ON d.follow_id=f.id AND d.appearance_id=a.id
    WHERE f.enabled=1 AND a.observed_at>f.created_at AND a.observed_at>? AND d.appearance_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(f.baseline_deployments_json) known
        WHERE known.value=CAST(a.chain_id AS TEXT)||'_'||a.address)
    ORDER BY a.observed_at ASC LIMIT 25`).bind(now-DAY).all()).results || [];
  let sent=0;
  for(const row of rows) {
    const claimed=await env.DB.prepare(`INSERT INTO runtime_family_deliveries(follow_id,appearance_id,status,attempted_at)
      VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING follow_id`).bind(row.follow_id,row.id,'sending',now).first();
    if(!claimed) continue;
    const name=String(row.label || '').trim() || `Runtime ${short(row.fingerprint)}`;
    const url=`https://hookline.world/#/board/${Number(row.chain_id)}/${encodeURIComponent(row.address)}`;
    const text=[`<b>${html(name)}</b>`,`New Hookline-observed runtime-family appearance`,`${html(row.project_name)} · chain ${Number(row.chain_id)} · block ${Number(row.block_number)}`,
      `<code>${html(row.address)}</code>`,`Runtime <code>${html(short(row.fingerprint))}</code>`,`This is first observation by Hookline, not proof of deployment time.`,html(url)].join('\n');
    try {
      await send(String(row.chat_id),text,{parse_mode:'HTML',disable_web_page_preview:true,
        reply_markup:{inline_keyboard:[[{text:'Open evidence',url},{text:'Pause family',callback_data:`mf:off:${row.fingerprint.slice(0,48)}`}]]}});
      await env.DB.prepare(`UPDATE runtime_family_deliveries SET status='delivered',delivered_at=? WHERE follow_id=? AND appearance_id=?`)
        .bind(now,row.follow_id,row.id).run();sent++;
    } catch {
      await env.DB.prepare(`UPDATE runtime_family_deliveries SET status='delivery_uncertain' WHERE follow_id=? AND appearance_id=?`)
        .bind(row.follow_id,row.id).run();
    }
  }
  await env.DB.prepare('DELETE FROM runtime_family_deliveries WHERE attempted_at<?').bind(now-30*DAY).run();
  return {sent};
}
