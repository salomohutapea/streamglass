import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Search, Trash2, ArrowUp, ArrowDown } from 'lucide-react';

type Rule = {id:string;name:string;enabled:boolean;pattern:string;method:string;statusCode:number;headers:[string,string][];bodyBase64:string;fileName?:string};
type Settings = {mapRemoteRules?:unknown[];rewriteRules?:unknown[];blockRules?:unknown[];mapLocalRules:Rule[];network:{enabled:boolean;delayMs:number;downloadKbps:number;uploadKbps:number;hostPattern:string;deviceId:string}};
type Props = {api:(path:string,method?:string,body?:any)=>Promise<any>;onChanged:()=>Promise<void>;section:'map-local'|'network';active:boolean};
const PRESETS=[{id:'offline',label:'Offline',delayMs:30000,downloadKbps:1,uploadKbps:1},{id:'2g',label:'2G',delayMs:300,downloadKbps:50,uploadKbps:20},{id:'slow-3g',label:'Slow 3G',delayMs:400,downloadKbps:400,uploadKbps:100},{id:'fast-3g',label:'Fast 3G',delayMs:150,downloadKbps:1600,uploadKbps:750},{id:'4g',label:'4G/LTE',delayMs:50,downloadKbps:12000,uploadKbps:5000},{id:'wifi',label:'Wi-Fi',delayMs:10,downloadKbps:30000,uploadKbps:15000},{id:'none',label:'No limit',delayMs:0,downloadKbps:0,uploadKbps:0}];
const freshRule = ():Rule => ({id:crypto.randomUUID(),name:'Local response',enabled:true,pattern:'*',method:'*',statusCode:200,headers:[],bodyBase64:''});
export default function TrafficTools({api,onChanged,section:tab,active}:Props) {
  const baseline=useRef<Settings|null>(null);
  const [settings,setSettings]=useState<Settings|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[headers,setHeaders]=useState<Record<string,string>>({}),[query,setQuery]=useState('');
  const dirty=!!settings&&(JSON.stringify(settings)!==JSON.stringify(baseline.current)||Object.keys(headers).length>0);
  useEffect(()=>{if(!active||dirty)return;let current=true;api('/api/traffic-tools').then(value=>{if(current){baseline.current=value.config;setSettings(value.config);}}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[active]);
  const rule=settings?.mapLocalRules.find(item=>item.id===selected);
  function choose(item:Rule){setSelected(item.id);}
  function update(patch:Partial<Rule>){setSettings(value=>value&&({...value,mapLocalRules:value.mapLocalRules.map(item=>item.id===selected?{...item,...patch}:item)}));}
  async function save(){if(!settings)return;setBusy(true);setError('');try{const value={...settings,mapLocalRules:settings.mapLocalRules.map(item=>{const parsed=JSON.parse(headers[item.id]??JSON.stringify(item.headers));if(!Array.isArray(parsed)||parsed.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string')))throw new Error('Headers must be a JSON array of [name, value] pairs');return {...item,headers:parsed};})};const latest:{config:Settings;revision:number}=await api('/api/traffic-tools');
    for(const section of ['mapLocalRules','network'] as const){
      const original=JSON.stringify(baseline.current?.[section]);
      if(JSON.stringify(value[section])===original){Object.assign(value,{[section]:latest.config[section]});}
      else if(JSON.stringify(latest.config[section])!==original){throw new Error(`${section==='network'?'Network profile':'Map Local rules'} changed in another window or MCP session. Close and reopen Tools before saving.`);}
    }
    for(const key of ['mapRemoteRules','rewriteRules','blockRules'] as const)Object.assign(value,{[key]:(latest.config as any)[key]??[]});
    const saved=await api('/api/traffic-tools','PUT',{revision:latest.revision,config:value});baseline.current=saved.config;setSettings(saved.config);setHeaders({});await onChanged();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  async function pick(){setError('');try{const file=await window.streamglass?.pickMapLocalFile();if(file)update(file);}catch(e:any){setError(e.message);}}
  function move(index:number,amount:number){setSettings(value=>{if(!value)return value;const rules=[...value.mapLocalRules];const target=index+amount;if(target<0||target>=rules.length)return value;[rules[index],rules[target]]=[rules[target],rules[index]];return{...value,mapLocalRules:rules};});}
  if(!active)return null;
  const net=settings?.network;
  const activePreset=net?PRESETS.find(p=>p.delayMs===net.delayMs&&p.downloadKbps===net.downloadKbps&&p.uploadKbps===net.uploadKbps):undefined;
  const needle=query.trim().toLowerCase();
  const visible=settings?settings.mapLocalRules.map((item,index)=>({item,index})).filter(({item})=>!needle||[item.name,item.pattern,item.method,item.fileName||'',String(item.statusCode)].some(v=>v.toLowerCase().includes(needle))):[];
  const patchNet=(patch:Partial<Settings['network']>)=>setSettings(value=>value&&({...value,network:{...value.network,...patch}}));
  return <section className="traffic-tools" aria-label={tab==='map-local'?'Map Local settings':'Network Conditioner settings'}><h3>{tab==='map-local'?'Map Local':'Network Conditioner'}</h3><div className="traffic-tools-body">
    {error&&<p className="error-text" role="alert">{error}</p>}
    {!settings?<p>Loading traffic settings…</p>:tab==='map-local'?<>
      <p>First matching enabled rule supplies the response. Rules run from top to bottom.</p><p className="hint">Files are imported snapshots; later file changes are not reloaded. Response fixtures share a 32 MiB total budget. While Map Local is enabled, uploads are buffered up to 8 MiB; larger uploads are rejected.</p>
      <div className="tt-toolbar"><label className="tt-search"><Search size={13} aria-hidden="true"/><input type="search" aria-label="Search rules" placeholder="Search rules" value={query} onChange={e=>setQuery(e.target.value)}/></label><button onClick={()=>{const item=freshRule();setSettings({...settings,mapLocalRules:[...settings.mapLocalRules,item]});setQuery('');choose(item);}}>Add rule</button></div>
      <div className="tt-rule-list">{visible.map(({item,index})=>{const open=selected===item.id;const method=item.method||'*';const bytes=Math.floor(item.bodyBase64.length*3/4);return <div className="tt-rule" data-open={open} data-enabled={item.enabled} key={item.id}>
        <div className="tt-rule-row">
          <input type="checkbox" aria-label={`Enable ${item.name}`} checked={item.enabled} onChange={e=>setSettings({...settings,mapLocalRules:settings.mapLocalRules.map(r=>r.id===item.id?{...r,enabled:e.target.checked}:r)})}/>
          <button className="tt-rule-detail" aria-expanded={open} aria-label={`Edit ${item.name}`} onClick={()=>setSelected(open?'':item.id)}>
            <ChevronRight size={13} className="tt-chevron" aria-hidden="true"/>
            <strong className="tt-rule-name" title={item.name}>{item.name}</strong>
            <span className="compact-rule-method">{method==='*'?'ANY':method}</span>
            <code className="tt-rule-pattern" title={item.pattern}>{item.pattern}</code>
            <span className="tt-rule-summary">{item.statusCode} · {item.fileName||(bytes?`${bytes.toLocaleString()} bytes`:'empty body')}</span>
          </button>
          <button className="icon-button" title="Move up" aria-label={`Move ${item.name} up`} disabled={!!needle||!index} onClick={()=>move(index,-1)}><ArrowUp size={14}/></button>
          <button className="icon-button" title="Move down" aria-label={`Move ${item.name} down`} disabled={!!needle||index===settings.mapLocalRules.length-1} onClick={()=>move(index,1)}><ArrowDown size={14}/></button>
          <button className="icon-button compact-rule-delete" title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`} onClick={()=>{setSettings({...settings,mapLocalRules:settings.mapLocalRules.filter(r=>r.id!==item.id)});if(selected===item.id)setSelected('');}}><Trash2 size={14}/></button>
        </div>
        {open&&rule&&<fieldset className="tt-rule-editor"><legend>Edit local response</legend><label>Name<input maxLength={256} value={rule.name} onChange={e=>update({name:e.target.value})}/></label><label>URL pattern<input maxLength={4096} value={rule.pattern} onChange={e=>update({pattern:e.target.value})}/></label><div className="tt-pair"><label>Method<input maxLength={64} value={rule.method} onChange={e=>update({method:e.target.value})}/></label><label>Status code<input type="number" min={200} max={599} value={rule.statusCode} onChange={e=>update({statusCode:Number(e.target.value)})}/></label></div><details><summary>Response headers</summary><label>JSON pairs, e.g. [["Content-Type","application/json"]]<textarea value={headers[rule.id]??JSON.stringify(rule.headers,null,2)} onChange={e=>setHeaders({...headers,[rule.id]:e.target.value})} spellCheck={false}/></label></details><div className="tt-file"><button disabled={!window.streamglass||busy} onClick={pick}>Choose response file…</button><span className="muted">{rule.fileName||'Empty response body'} · {Math.floor(rule.bodyBase64.length*3/4).toLocaleString()} bytes</span></div></fieldset>}
      </div>;})}
      {!visible.length&&<p className="muted tt-empty">{settings.mapLocalRules.length?'No rules match your search.':'No Map Local rules yet. Add one to serve a local response.'}</p>}</div>
    </>:<fieldset><legend>Network profile</legend>
      <div className="tt-status" data-active={net!.enabled}><span className="tt-dot" aria-hidden="true"/><strong>{net!.enabled?'Active':'Inactive'}</strong><span className="muted">{net!.enabled?`Throttling ${net!.hostPattern||'all hosts'} · ${activePreset?.label??'Custom'}`:'Traffic is not throttled'}</span></div>
      <p className="hint">Rates apply per flow. Delay applies once per request. Opaque TLS connections are excluded. Packet loss is not supported; Offline is approximated with an extreme delay and 1 Kbps.</p>
      <div className="tt-presets" role="group" aria-label="Network presets">{PRESETS.map(p=><button key={p.id} className="tt-chip" aria-pressed={activePreset?.id===p.id} title={`${p.delayMs} ms · ${p.downloadKbps||'unlimited'} / ${p.uploadKbps||'unlimited'} Kbps`} onClick={()=>patchNet({delayMs:p.delayMs,downloadKbps:p.downloadKbps,uploadKbps:p.uploadKbps,enabled:p.id!=='none'})}>{p.label}</button>)}{!activePreset&&<span className="tt-chip tt-chip-custom" aria-pressed="true">Custom</span>}</div>
      <label><input type="checkbox" checked={net!.enabled} onChange={e=>patchNet({enabled:e.target.checked})}/>Enable network profile</label>{(['delayMs','downloadKbps','uploadKbps'] as const).map(key=><label key={key}>{({delayMs:'Delay (ms)',downloadKbps:'Download (Kbps; 0 = unlimited)',uploadKbps:'Upload (Kbps; 0 = unlimited)'})[key]}<input type="number" min={0} value={net![key]} onChange={e=>patchNet({[key]:Number(e.target.value)})}/></label>)}<label>Host pattern<input value={net!.hostPattern} onChange={e=>patchNet({hostPattern:e.target.value})}/></label><label>Device ID (empty = all devices)<input value={net!.deviceId} onChange={e=>patchNet({deviceId:e.target.value})}/></label></fieldset>}
  </div><div className="lab-actions"><button disabled={!settings||busy} onClick={()=>void save()}>{busy?'Saving…':'Save traffic settings'}</button>{dirty&&<span className="muted">Unsaved changes</span>}</div></section>;
}
