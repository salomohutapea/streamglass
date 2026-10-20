import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import './traffic-rules.css';

export type RuleKind = 'mapRemoteRules' | 'rewriteRules' | 'blockRules';
type HeaderOp = {op:'set'|'remove';name:string;value?:string};
type Rule = {id:string;name:string;enabled:boolean;method:string;pattern:string;group?:string;[key:string]:any};
type Props = {api:(path:string,method?:string,body?:any)=>Promise<any>;onChanged:()=>Promise<void>;kind:RuleKind;active:boolean};

const META:Record<RuleKind,{title:string;noun:string;intro:string;hint:string;fresh:()=>Record<string,any>;empty:string}> = {
  mapRemoteRules:{title:'Map Remote',noun:'redirect',empty:'No Map Remote rules yet. Add one to send matching requests to another host.',
    intro:'The first matching enabled rule sends the request to another scheme, host and port. The rest of the path and the query are preserved; an optional path prefix can be replaced.',
    hint:'Staging and production usually need different session IDs and tokens. Header overrides apply only to requests redirected by that rule, so keep one rule per environment, give each a group such as Staging or Production, and switch whole groups on or off. Map Local wins over Map Remote. Rules do nothing while capture is paused.',
    fresh:()=>({name:'Redirect to staging',pattern:'https://api.example.com/*',scheme:'https',host:'staging.example.com',port:0,pathFrom:'',pathTo:'',keepHost:false,headerOps:[]})},
  rewriteRules:{title:'Rewrite',noun:'rewrite',empty:'No Rewrite rules yet. Add one to change headers, status or body text.',
    intro:'Request rules change request headers before they are sent. Response rules change response headers and status code, and can replace literal text in complete UTF-8 bodies.',
    hint:'Body replacement is plain text, not a regular expression. Streamed, SSE, binary and bodies over 8 MiB are forwarded unchanged and the capture notes it. Rules do nothing while capture is paused.',
    fresh:()=>({name:'Rewrite response',pattern:'https://api.example.com/*',phase:'response',headerOps:[],statusCode:0,bodyFind:'',bodyReplace:''})},
  blockRules:{title:'Block',noun:'block',empty:'No Block rules yet. Add one to stop matching requests from reaching the server.',
    intro:'Matching requests get a synthetic response or a closed connection, without contacting the server. Block runs before every other rule.',
    hint:'While a Block rule matches, uploads are buffered up to 8 MiB; larger uploads are rejected. Rules do nothing while capture is paused.',
    fresh:()=>({name:'Block tracker',pattern:'https://tracker.example.com/*',action:'respond',statusCode:403,body:''})},
};
const summary=(kind:RuleKind,r:Rule)=>kind==='mapRemoteRules'
  ? `→ ${r.scheme}://${r.host}${r.port?`:${r.port}`:''}${r.pathFrom?` · ${r.pathFrom}→${r.pathTo||'/'}`:''}${r.headerOps?.length?` · ${r.headerOps.length} header${r.headerOps.length===1?'':'s'}`:''}`
  : kind==='rewriteRules'
    ? `${r.phase}${r.headerOps?.length?` · ${r.headerOps.length} header${r.headerOps.length===1?'':'s'}`:''}${r.statusCode?` · status ${r.statusCode}`:''}${r.bodyFind?' · body text':''}`
    : r.action==='close'?'close connection':`respond ${r.statusCode}`;

function HeaderOps({ops,onChange,label}:{ops:HeaderOp[];onChange:(ops:HeaderOp[])=>void;label:string}) {
  const patch=(index:number,change:Partial<HeaderOp>)=>onChange(ops.map((op,i)=>i===index?{...op,...change}:op));
  return <div className="tr-ops" role="group" aria-label={label}>
    {ops.map((op,index)=><div className="tr-op" key={index}>
      <select aria-label={`Header action ${index+1}`} value={op.op} onChange={e=>patch(index,{op:e.target.value as HeaderOp['op']})}><option value="set">Set</option><option value="remove">Remove</option></select>
      <input aria-label={`Header name ${index+1}`} placeholder="Authorization" maxLength={256} value={op.name} onChange={e=>patch(index,{name:e.target.value})}/>
      <input aria-label={`Header value ${index+1}`} placeholder={op.op==='remove'?'(removed)':'value'} disabled={op.op==='remove'} maxLength={8192} value={op.op==='remove'?'':op.value??''} onChange={e=>patch(index,{value:e.target.value})}/>
      <button className="icon-button" title="Remove header override" aria-label={`Remove header override ${index+1}`} onClick={()=>onChange(ops.filter((_,i)=>i!==index))}><Trash2 size={14}/></button>
    </div>)}
    <div><button onClick={()=>onChange([...ops,{op:'set',name:'',value:''}])}><Plus size={12} aria-hidden="true"/> Add header</button></div>
  </div>;
}

export default function TrafficRules({api,onChanged,kind,active}:Props) {
  const meta=META[kind];
  const baseline=useRef('');
  const [rules,setRules]=useState<Rule[]|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState('');
  const dirty=rules!==null&&JSON.stringify(rules)!==baseline.current;
  useEffect(()=>{if(!active||dirty)return;let current=true;api('/api/traffic-tools').then(value=>{if(current){const list=value.config[kind]??[];baseline.current=JSON.stringify(list);setRules(list);}}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[active,kind]);
  if(!active)return null;
  const update=(id:string,patch:Record<string,any>)=>setRules(list=>list&&list.map(r=>r.id===id?{...r,...patch}:r));
  const move=(index:number,amount:number)=>setRules(list=>{if(!list)return list;const next=[...list],target=index+amount;if(target<0||target>=next.length)return list;[next[index],next[target]]=[next[target],next[index]];return next;});
  async function save(){
    if(!rules)return;setBusy(true);setError('');
    try{
      const latest:{config:any;revision:number}=await api('/api/traffic-tools');
      if(JSON.stringify(latest.config[kind]??[])!==baseline.current)throw new Error(`${meta.title} rules changed in another window or MCP session. Close and reopen Tools before saving.`);
      const clean=rules.map(rule=>({...rule,...(rule.headerOps?{headerOps:rule.headerOps.map((op:HeaderOp)=>op.op==='remove'?{op:op.op,name:op.name}:op)}:{}),...(rule.group?{}:{group:undefined})}));
      const saved=await api('/api/traffic-tools','PUT',{revision:latest.revision,config:{...latest.config,[kind]:JSON.parse(JSON.stringify(clean))}});
      const list=saved.config[kind]??[];baseline.current=JSON.stringify(list);setRules(list);await onChanged();
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  const needle=query.trim().toLowerCase();
  const visible=(rules??[]).map((item,index)=>({item,index})).filter(({item})=>!needle||[item.name,item.pattern,item.method,item.group??'',summary(kind,item)].some(v=>v.toLowerCase().includes(needle)));
  const groups=[...new Set((rules??[]).map(r=>r.group).filter((g):g is string=>!!g))];
  const setGroup=(group:string,enabled:boolean)=>setRules(list=>list&&list.map(r=>r.group===group?{...r,enabled}:r));
  return <section className="traffic-tools" aria-label={`${meta.title} settings`}><h3>{meta.title}</h3><div className="traffic-tools-body">
    {error&&<p className="error-text" role="alert">{error}</p>}
    {!rules?<p>Loading {meta.title} rules…</p>:<>
      <p>{meta.intro} Rules run from top to bottom.</p><p className="hint">{meta.hint}</p>
      {groups.length>0&&<div className="tr-groups" role="group" aria-label="Environment groups"><span className="muted">Groups</span>{groups.map(group=>{const members=rules.filter(r=>r.group===group),on=members.filter(r=>r.enabled).length;return <button key={group} className="tt-chip" aria-pressed={on===members.length} title={`${on} of ${members.length} enabled. Click to ${on===members.length?'disable':'enable'} all.`} aria-label={`Toggle group ${group}`} onClick={()=>setGroup(group,on!==members.length)}>{group} · {on}/{members.length}</button>;})}</div>}
      <div className="tt-toolbar"><label className="tt-search"><Search size={13} aria-hidden="true"/><input type="search" aria-label="Search rules" placeholder="Search rules" value={query} onChange={e=>setQuery(e.target.value)}/></label><button onClick={()=>{const item:Rule={id:crypto.randomUUID(),enabled:true,method:'*',...meta.fresh()} as Rule;setRules([...rules,item]);setQuery('');setSelected(item.id);}}>Add rule</button></div>
      <datalist id={`groups-${kind}`}>{groups.map(g=><option key={g} value={g}/>)}</datalist>
      <div className="tt-rule-list">{visible.map(({item,index})=>{const open=selected===item.id;const method=item.method||'*';return <div className="tt-rule" data-open={open} data-enabled={item.enabled} key={item.id}>
        <div className="tt-rule-row">
          <input type="checkbox" aria-label={`Enable ${item.name}`} checked={item.enabled} onChange={e=>update(item.id,{enabled:e.target.checked})}/>
          <button className="tt-rule-detail" aria-expanded={open} aria-label={`Edit ${item.name}`} onClick={()=>setSelected(open?'':item.id)}>
            <ChevronRight size={13} className="tt-chevron" aria-hidden="true"/>
            <strong className="tt-rule-name" title={item.name}>{item.name}</strong>
            {item.group&&<span className="badge">{item.group}</span>}
            <span className="compact-rule-method">{method==='*'?'ANY':method}</span>
            <code className="tt-rule-pattern" title={item.pattern}>{item.pattern}</code>
            <span className="tt-rule-summary">{summary(kind,item)}</span>
          </button>
          <button className="icon-button" title="Move up" aria-label={`Move ${item.name} up`} disabled={!!needle||!index} onClick={()=>move(index,-1)}><ArrowUp size={14}/></button>
          <button className="icon-button" title="Move down" aria-label={`Move ${item.name} down`} disabled={!!needle||index===rules.length-1} onClick={()=>move(index,1)}><ArrowDown size={14}/></button>
          <button className="icon-button compact-rule-delete" title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`} onClick={()=>{setRules(rules.filter(r=>r.id!==item.id));if(selected===item.id)setSelected('');}}><Trash2 size={14}/></button>
        </div>
        {open&&<fieldset className="tt-rule-editor"><legend>Edit {meta.noun} rule</legend>
          <div className="tt-pair"><label>Name<input maxLength={256} value={item.name} onChange={e=>update(item.id,{name:e.target.value})}/></label><label>Group (optional, e.g. Staging)<input maxLength={64} list={`groups-${kind}`} value={item.group??''} onChange={e=>update(item.id,{group:e.target.value})}/></label></div>
          <label>URL pattern<input maxLength={4096} value={item.pattern} onChange={e=>update(item.id,{pattern:e.target.value})}/></label>
          <label>Method (* for any)<input maxLength={64} value={item.method} onChange={e=>update(item.id,{method:e.target.value})}/></label>
          {kind==='mapRemoteRules'&&<>
            <div className="tt-pair"><label>Scheme<select value={item.scheme} onChange={e=>update(item.id,{scheme:e.target.value})}><option value="https">https</option><option value="http">http</option></select></label><label>Port (0 = scheme default)<input type="number" min={0} max={65535} value={item.port} onChange={e=>update(item.id,{port:Number(e.target.value)})}/></label></div>
            <label>Host<input maxLength={253} placeholder="staging.example.com" value={item.host} onChange={e=>update(item.id,{host:e.target.value})}/></label>
            <div className="tt-pair"><label>Replace path prefix<input maxLength={2048} placeholder="/v1" value={item.pathFrom} onChange={e=>update(item.id,{pathFrom:e.target.value})}/></label><label>With<input maxLength={2048} placeholder="/staging/v1" value={item.pathTo} onChange={e=>update(item.id,{pathTo:e.target.value})}/></label></div>
            <label className="tr-check"><input type="checkbox" checked={item.keepHost} onChange={e=>update(item.id,{keepHost:e.target.checked})}/>Keep the original Host header</label>
            <p className="tr-note">Header overrides apply only to requests redirected by this rule. Use them for the Authorization, Cookie or X-Session-Id your staging or production server expects.</p>
            <HeaderOps label="Header overrides" ops={item.headerOps} onChange={headerOps=>update(item.id,{headerOps})}/>
          </>}
          {kind==='rewriteRules'&&<>
            <label>Apply to<select value={item.phase} onChange={e=>update(item.id,e.target.value==='request'?{phase:'request',statusCode:0,bodyFind:'',bodyReplace:''}:{phase:'response'})}><option value="request">Requests (headers)</option><option value="response">Responses (headers, status, body text)</option></select></label>
            <HeaderOps label="Header changes" ops={item.headerOps} onChange={headerOps=>update(item.id,{headerOps})}/>
            {item.phase==='response'&&<>
              <label>Replace status code (0 = keep)<input type="number" min={0} max={599} value={item.statusCode} onChange={e=>update(item.id,{statusCode:Number(e.target.value)})}/></label>
              <div className="tt-pair"><label>Find text in body<input maxLength={4096} value={item.bodyFind} onChange={e=>update(item.id,{bodyFind:e.target.value})}/></label><label>Replace with<input maxLength={65536} value={item.bodyReplace} onChange={e=>update(item.id,{bodyReplace:e.target.value})}/></label></div>
            </>}
          </>}
          {kind==='blockRules'&&<>
            <div className="tt-pair"><label>Action<select value={item.action} onChange={e=>update(item.id,{action:e.target.value})}><option value="respond">Respond with status</option><option value="close">Close connection</option></select></label><label>Status code<input type="number" min={400} max={599} value={item.statusCode} disabled={item.action==='close'} onChange={e=>update(item.id,{statusCode:Number(e.target.value)})}/></label></div>
            <label>Response text (optional)<textarea maxLength={4096} value={item.body??''} disabled={item.action==='close'} onChange={e=>update(item.id,{body:e.target.value})}/></label>
          </>}
        </fieldset>}
      </div>;})}
      {!visible.length&&<p className="muted tt-empty">{rules.length?'No rules match your search.':meta.empty}</p>}</div>
    </>}
  </div><div className="lab-actions"><button disabled={!rules||busy} onClick={()=>void save()}>{busy?'Saving…':`Save ${meta.title} rules`}</button>{dirty&&<span className="muted">Unsaved changes</span>}</div></section>;
}
