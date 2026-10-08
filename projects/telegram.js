import { latestProjectObservations,followProject,projectFollows } from './evidence.js';
import { submitContribution,listActorSubmissions,issueClaimChallenge,verifyClaim } from './contributions.js';
import { followRuntimeFamily,runtimeFamilyFollows } from './mechanisms.js';
import { navigationRows,menuButton,privateConversation,cleanLabel,alertHtml } from '../bot/navigation.js';

const commands=new Set(['projects','project','follow','unfollow','following','family','followfamily','unfollowfamily','submitproject','suggest','claim','verifyclaim','myrequests']);
function plain(value) {return typeof value==='string'?value:JSON.stringify(value);}
const projectUrl=id=>`https://hookline.world/#/projects/${encodeURIComponent(id)}`;
function privateOptions(parsed,userId,services) {
  if(String(parsed.chatId)!==String(userId) || !/^\d+$/.test(String(userId))) throw new Error('Open this bot in a private chat to submit or manage project requests.');
  return {actorId:`telegram:${userId}`,telegramUserId:String(userId),chatId:String(parsed.chatId),
    getProject:services.getCanonicalProject || services.getProject,
    requestId:parsed.messageId?`telegram:${parsed.chatId}:${parsed.messageId}`:undefined};
}
function challengeText(result) {
  const challenge=result?.verification || result?.challenge || result;
  const name=challenge.recordName || challenge.dnsName || challenge.name || challenge.host;
  const value=challenge.recordValue || challenge.value || challenge.txtValue || challenge.token;
  if(name && value) return `Add a DNS TXT record to the project's own domain.\nName: ${name}\nValue: ${value}`;
  return plain(challenge.instructions || challenge.message || 'Open your private receipt on Hookline for the domain verification instructions.');
}
export async function handleProjectMessage(client,parsed,ctx,userId) {
  let command=parsed.command?.toLowerCase().split('@')[0], args=String(parsed.args || '').trim();
  if(command==='start' && /^project_[a-z0-9-]{1,48}$/.test(args)) {command='project';args=args.slice(8);}
  if(command==='start' && /^fam_[0-9a-f]{16,48}$/i.test(args)) {command='family';args=args.slice(4).toLowerCase();}
  if(!commands.has(command)) return null;
  const services=ctx.services?.projects;
  const reply=async(text,buttons,htmlMode=false)=> {
    const response=await client.reply(parsed.chatId,text,{disable_web_page_preview:true,parse_mode:htmlMode?'HTML':undefined,reply_markup:{inline_keyboard:buttons || navigationRows()}});
    return {handled:true,messageId:response?.message_id};
  };
  if(!services) return reply('Project services are temporarily unavailable. https://hookline.world/#/projects');
  try {
    if(command==='projects') {
      const projects=await services.listProjects();
      const offset=Math.max(0,Math.min(Math.max(0,projects.length-1),Number.parseInt(args,10)||0));
      const page=projects.slice(offset,offset+8);
      const buttons=page.map(p=>[{text:cleanLabel(p.name,48),callback_data:`pr:view:${p.id}`}]);
      const paging=[];
      if(offset>0) paging.push({text:'Previous projects',callback_data:`pr:list:${Math.max(0,offset-8)}`});
      if(offset+8<projects.length) paging.push({text:'More projects',callback_data:`pr:list:${offset+8}`});
      if(paging.length) buttons.push(paging);
      buttons.push([{text:'Browse all projects',url:'https://hookline.world/#/projects'}],...navigationRows());
      return reply(['Hookline projects','',...page.map(p=>`${p.name}, ${p.category || 'Hook ecosystem'}`),'','Tap a project for details, follows, and profile updates.'].join('\n'),buttons);
    }
    if(command==='following') {
      privateOptions(parsed,userId,services);
      const ids=await projectFollows(ctx.env,userId);
      return reply(ids.length?`Following\n${ids.map(id=>`/project ${id}`).join('\n')}\n\n/unfollow <project> to stop.`:'No project follows yet. Use /projects to find one.');
    }
    if(command==='family' || command==='followfamily' || command==='unfollowfamily') {
      privateOptions(parsed,userId,services);
      const family=await services.getRuntimeFamily?.(args);
      if(!family) return reply('Runtime family not found. Open a project profile on Hookline and use Follow runtime family.');
      const fingerprint=family.runtimeFingerprint,prefix=fingerprint.slice(0,48);
      const label=cleanLabel(family.representativeName || `Runtime ${fingerprint.slice(0,12)}`,80);
      if(command!=='family') {
        const enabled=command==='followfamily';
        await followRuntimeFamily(ctx.env,{fingerprint,label,deployments:family.deployments,userId,chatId:parsed.chatId,enabled});
        return reply(alertHtml([enabled?`Following ${label}`:`Paused ${label}`,'Exact runtime bytecode family',{address:fingerprint},
          enabled?'You’ll get an alert when Hookline first observes this exact runtime on another monitored deployment.':'Resume it whenever you want from My alerts.',
          'A runtime match is not proof of project affiliation or deployment time.']),[[{text:'Family details',callback_data:`mf:view:${prefix}`},{text:enabled?'Pause':'Resume',callback_data:`mf:${enabled?'off':'on'}:${prefix}`}],...navigationRows()],true);
      }
      return reply(alertHtml([label,'Exact runtime bytecode family',{address:fingerprint},
        `${family.deploymentCount || family.deployments?.length || 0} indexed exact deployment${Number(family.deploymentCount || family.deployments?.length || 0)===1?'':'s'} across ${(family.chainIds || []).length} chain${(family.chainIds || []).length===1?'':'s'}.`,
        'Alerts fire on first Hookline observation of this runtime on another monitored deployment.']),[[{text:'Follow runtime family',callback_data:`mf:on:${prefix}`}],...navigationRows()],true);
    }
    if(command==='project' || command==='follow' || command==='unfollow') {
      const project=await services.getProject(args);
      if(!project) return reply('Project not found. Use /projects to see project IDs.');
      if(command!=='project') {
        privateOptions(parsed,userId,services);
        await followProject(ctx.env,{projectId:project.id,userId,chatId:parsed.chatId,enabled:command==='follow'});
        return reply(command==='follow'?`Following ${project.name}. You'll receive supported factory launches, implementation changes, fee configuration changes, and observed outcomes from its monitored deployments.\n${projectUrl(project.id)}`:`Paused ${project.name}. You can resume it below.`,[[{text:'Project details',callback_data:`pr:view:${project.id}`},{text:command==='follow'?'Pause alerts':'Resume alerts',callback_data:`pr:${command==='follow'?'off':'on'}:${project.id}`}],...navigationRows()]);
      }
      const observations=await latestProjectObservations(ctx.env,project.id);
      const lines=[project.name,project.summary || '',`${project.deployments?.length || 0} linked deployments, ${observations.length} with saved direct observations.`];
      if(observations[0]) lines.push(`Latest saved read: chain ${observations[0].chainId}, block ${observations[0].blockNumber}.`);
      lines.push(projectUrl(project.id));
      return reply(lines.filter(Boolean).join('\n'),[[{text:'Open project',url:projectUrl(project.id)}],[{text:'Follow changes',callback_data:`project_follow:${project.id}`}],[{text:'Claim profile',callback_data:`pr:claim:${project.id}`},{text:'Your requests',callback_data:'pr:requests'}],...navigationRows()]);
    }
    const options=privateOptions(parsed,userId,services);
    if(command==='myrequests') {
      const records=await listActorSubmissions(ctx.env,options);
      const items=Array.isArray(records)?records:records.submissions || records.requests || [];
      return reply(items.length?items.slice(0,10).map(r=>`${r.id}\n${r.kind || 'Request'}, ${r.status}`).join('\n\n'):'You have no project requests in this chat. Use /submitproject, /suggest, or /claim.');
    }
    if(command==='verifyclaim') {
      if(!args) return reply('Use /verifyclaim <request ID> after adding the DNS record.');
      const result=await verifyClaim(ctx.env,args,options);
      return reply(`Claim status: ${result.status}\n${result.message || 'Domain checks completed.'}`);
    }
    if(command==='claim') {
      const project=await services.getProject(args);
      if(!project) return reply('Use /claim <project ID>. Find IDs with /projects.');
      const result=await submitContribution(ctx.env,{kind:'claim',projectId:project.id,agreement:true},options);
      const proof=result.verification ? result : await issueClaimChallenge(ctx.env,result.id,options);
      return reply(`Claim request ${result.id}\n${challengeText(proof)}\n\nAfter adding the record, tap Check DNS verification.\nDomain control is not a contract safety endorsement.`,[[{text:'Check DNS verification',callback_data:`pr:verify:${result.id}`}],[{text:'Your requests',callback_data:'pr:requests'}],...navigationRows()]);
    }
    if(command==='suggest') {
      const [id,...parts]=args.split('|').map(v=>v.trim());
      const message=parts.join(' | ');
      if(!id || !message) return reply('Use /suggest project-id | the correction and a source link. No email needed.');
      const result=await submitContribution(ctx.env,{kind:'correction',projectId:id,message,agreement:true},options);
      return reply(`Suggestion received: ${result.id}\nStatus: ${result.status}\nUse /myrequests to check it. No email will be sent.`);
    }
    if(command==='submitproject') {
      const [name,website,description,contracts='']=args.split('|').map(v=>v.trim());
      if(!name || !website || !description) return reply('Use /submitproject Name | https://official-site | brief description | optional chain:contract\nOnly public project information. No keys or email required.');
      const result=await submitContribution(ctx.env,{kind:'project',name,website,description,contracts,agreement:true},options);
      return reply(`Project submitted: ${result.id}\nStatus: ${result.status}\nUse /myrequests to check progress. Submitted addresses aren't treated as proven affiliations.`);
    }
  } catch(error) {
    const safe=typeof error?.message==='string' && error.message.length<240 && !/SQL|D1_|SELECT|INSERT|stack|token=/i.test(error.message)
      ?error.message:'Project request temporarily unavailable. Retry shortly.';
    return reply(safe);
  }
  return null;
}
export async function handleProjectCallback(client,callback,ctx,userId) {
  const old=String(callback.data || '').match(/^project_follow:([a-z0-9-]{1,48})$/);
  const family=String(callback.data || '').match(/^mf:(view|on|off):([0-9a-f]{16,48})$/i);
  const match=String(callback.data || '').match(/^pr:(view|on|off|claim|verify|list)(?::([a-z0-9-]{1,48}))$|^pr:(requests)$/);
  if(!match && !old && !family) return null;
  if(!privateConversation(callback.message?.chat?.id,userId,callback.from?.id ?? userId)) {
    await client.answer(callback.id,{text:'Open Hookline in your private chat to manage projects.',show_alert:true});
    return {handled:true,reason:'private_chat_required'};
  }
  await client.answer(callback.id);
  if(family) {
    const commands={view:'family',on:'followfamily',off:'unfollowfamily'};
    return handleProjectMessage(client,{command:commands[family[1]],args:family[2],chatId:callback.message?.chat?.id,messageId:callback.message?.message_id?`${callback.message.message_id}:${family[1]}`:undefined},ctx,userId);
  }
  const action=old?'on':match[1]||match[3];
  const commands={view:'project',on:'follow',off:'unfollow',claim:'claim',verify:'verifyclaim',list:'projects',requests:'myrequests'};
  return handleProjectMessage(client,{command:commands[action],args:old?old[1]:match[2]||'',chatId:callback.message?.chat?.id,messageId:callback.message?.message_id?`${callback.message.message_id}:${action}`:undefined},ctx,userId);
}

/** All retained follows, including paused ones, so resuming never requires a command. */
export async function projectAlertSubscriptions(ctx,userId,chatId) {
  if(!privateConversation(chatId,userId)) throw new Error('Open Hookline in your private chat to manage projects.');
  if(typeof ctx.services?.projects?.listAlertSubscriptions==='function') return ctx.services.projects.listAlertSubscriptions(userId,chatId);
  if(!ctx.env?.DB) return [];
  const rows=await ctx.env.DB.prepare('SELECT project_id,enabled FROM project_follows WHERE telegram_user_id=? AND chat_id=? ORDER BY enabled DESC,created_at ASC LIMIT 40').bind(String(userId),String(chatId)).all();
  return rows.results || [];
}

export async function runtimeFamilyAlertSubscriptions(ctx,userId,chatId) {
  if(!privateConversation(chatId,userId)) throw new Error('Open Hookline in your private chat to manage projects.');
  return runtimeFamilyFollows(ctx.env,userId,chatId);
}
