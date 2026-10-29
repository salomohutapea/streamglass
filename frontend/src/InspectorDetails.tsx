import {Fragment, useState, type ReactNode} from 'react';
import './inspector-details.css';
import {formatSize, headerValue, imageDataUrl, parseSetCookie, headerValues, requestStructure, type Pair} from './http-structure.mjs';

type Message = {url?:string; headers?:[string,string][]; body?:string; bodyBase64?:string; bodyUnavailable?:boolean; size?:number|null; encodedSize?:number};

function PairTable({title, rows, columns=['Name','Value']}: {title:string; rows:ReactNode[][]; columns?:string[]}) {
  if (!rows.length) return null;
  return <section className="structured-section"><h3>{title} ({rows.length})</h3><div className="structured-scroll"><table className="structured-table" aria-label={title}><thead><tr>{columns.map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div></section>;
}

const pairRows = (pairs: Pair[]) => pairs.map(p=>[<code>{p.name}</code>, <code>{p.value}</code>]);

function ViewToggle({mode, onChange}: {mode:'structured'|'raw'; onChange:(m:'structured'|'raw')=>void}) {
  return <div className="structured-toggle" role="group" aria-label="Body view">{(['structured','raw'] as const).map(m=><button key={m} aria-pressed={mode===m} onClick={()=>onChange(m)}>{m==='structured'?'Structured':'Raw'}</button>)}</div>;
}

/** Read-only structured view of a request; `raw` is the existing raw body/headers view. */
export function RequestStructured({request, raw}: {request?:Message; raw:ReactNode}) {
  const [mode,setMode]=useState<'structured'|'raw'>('structured');
  if (!request) return <>{raw}</>;
  const s = requestStructure(request);
  const hasStructure = !!(s.query.length||s.form.length||s.parts.length);
  // Cookies sit below the body as a collapsed disclosure, like Headers, in both views.
  const cookies = s.cookies.length>0 && <details className="headers-disclosure"><summary>Cookies ({s.cookies.length})</summary><div className="structured-scroll"><table className="structured-table" aria-label="Cookies"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>{pairRows(s.cookies).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div></details>;
  if (!hasStructure) return <>{raw}{cookies}</>;
  return <>
    <ViewToggle mode={mode} onChange={setMode}/>
    {mode==='raw' ? raw : <>
      <PairTable title="Query" rows={pairRows(s.query)}/>
      <PairTable title="Form" rows={pairRows(s.form)}/>
      {s.parts.length>0 && <section className="structured-section"><h3>Multipart parts ({s.parts.length})</h3><div className="structured-scroll"><table className="structured-table" aria-label="Multipart parts"><thead><tr><th>Name</th><th>Filename</th><th>Type</th><th>Size</th></tr></thead><tbody>{s.parts.map((p,i)=><tr key={i}><td><code>{p.name}</code></td><td><code>{p.filename||'—'}</code></td><td><code>{p.contentType||'—'}</code></td><td>{formatSize(p.size)}</td></tr>)}</tbody></table></div>{s.parts.map((p,i)=>p.text!==undefined&&p.text!==''&&<details key={i} className="part-preview"><summary>{p.name||`Part ${i+1}`}{p.truncated?' (truncated)':''}</summary><pre className="body-code">{p.text}</pre></details>)}</section>}
      {!s.form.length && !s.parts.length && raw}
    </>}
    {cookies}
  </>;
}

/** Read-only structured view of a response: image preview and Set-Cookie. */
export function ResponseStructured({response, raw}: {response?:Message; raw:ReactNode}) {
  const [mode,setMode]=useState<'structured'|'raw'>('structured');
  if (!response) return <>{raw}</>;
  const cookies = parseSetCookie(headerValues(response.headers,'set-cookie'));
  const image = imageDataUrl(response.headers, response.bodyUnavailable ? '' : response.bodyBase64);
  if (!cookies.length && !image) return <>{raw}</>;
  return <>
    <ViewToggle mode={mode} onChange={setMode}/>
    {mode==='raw' ? raw : <>
      {image && <section className="structured-section"><h3>Image</h3><div className="image-preview"><img src={image} alt="Response body preview" loading="lazy"/></div></section>}
      <PairTable title="Set-Cookie" columns={['Name','Value','Domain','Path','Expires','Flags']} rows={cookies.map(c=>[<code>{c.name}</code>,<code>{c.value}</code>,c.domain||'—',c.path||'—',c.expires||'—',c.flags.join(', ')||'—'])}/>
      {!image && raw}
    </>}
  </>;
}

/** Request headers and sizes for the Overview tab. */
export function OverviewDetails({record}: {record:{request?:Message; response?:Message & {headers?:[string,string][]}; appliedRules?:{type:string;id:string;name:string;detail?:string}[]}}) {
  const req=record.request, res=record.response;
  const encoding = headerValue(res?.headers,'content-encoding');
  const length = headerValue(res?.headers,'content-length');
  const transfer = res?.encodedSize ?? (length!==undefined&&/^\d+$/.test(length)?Number(length):undefined);
  const sized = (m?:Message) => m ? (m.size ?? (m.bodyUnavailable?undefined:m.body?new TextEncoder().encode(m.body).length:undefined)) : undefined;
  const ruleLabel:Record<string,string> = {'map-remote':'Map Remote','rewrite':'Rewrite','block':'Block'};
  return <>
    {!!record.appliedRules?.length && <><h3>Applied rules</h3>
      <dl className="size-list" aria-label="Applied rules">{record.appliedRules.map((rule,i)=><Fragment key={i}><dt>{ruleLabel[rule.type]??rule.type}</dt><dd>{rule.name}{rule.detail?` — ${rule.detail}`:''}</dd></Fragment>)}</dl></>}
    <h3>Sizes</h3>
    <dl className="size-list"><dt>Request body</dt><dd>{req?formatSize(sized(req)):'—'}</dd><dt>Response body</dt><dd>{res?formatSize(sized(res)):'—'}{encoding&&encoding!=='identity'?` (${encoding})`:''}</dd>{res&&transfer!==undefined&&<><dt>Transfer</dt><dd>{formatSize(transfer)}</dd></>}</dl>
    {!!req?.headers?.length && <details className="headers-disclosure"><summary>Request headers ({req.headers.length})</summary><div className="header-list">{req.headers.map(([k,v],i)=><div key={i}><span>{k}</span><code>{v}</code></div>)}</div></details>}
  </>;
}
