import { startedAtMs, requestTime } from './TrafficTable';
import { gapSummary, formatMs } from './timing.mjs';
import { useEffect, useState } from 'react';
import { SSE_STATUS, sseStatus, SseStatusDot } from './sse-status';
import './timing.css';

export default function SseTimeline({record}:{record:any}) {
  const d=record.sseDiagnostics??{};
  const start=startedAtMs(record.startedAt), first=startedAtMs(d.firstEventAt), headers=startedAtMs(d.headersAt);
  const elapsed=(time:number|undefined)=>time!==undefined&&start!==undefined?`${Math.max(0,time-start).toFixed(0)} ms`:'—';
  const events=record.events??[];
  const retained=gapSummary(events.map((e:any)=>e.gapMs).filter((g:unknown)=>typeof g==='number'));
  const stats=d.gapStats?.count?d.gapStats:retained;
  const status=sseStatus(record), info=SSE_STATUS[status], live=info.tone==='pending'||info.tone==='live', detail=d.endDetail||(d.endReason in SSE_STATUS?'':d.endReason);
  const count=d.eventCount??record.eventCount??events.length, ended=startedAtMs(d.endedAt??record.endedAt);
  const tiles:[string,string][]=[['Headers',elapsed(headers)],['First event',elapsed(first)],['Events',String(count)],['Bytes',d.eventBytes?.toLocaleString()??'—'],['Total',live?'—':elapsed(ended)]];
  return <details className="sse-timeline" open><summary>SSE timeline</summary>
    <div className="sse-head"><span className={`sse-pill sse-${info.tone}`}><SseStatusDot status={status}/>{info.label}</span>{detail&&<span className="muted sse-detail">{detail}</span>}</div>
    <SseStatusStrip record={record} status={status} live={live}/>
    <dl className="sse-tiles">{tiles.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {stats&&<dl className="sse-gaps" aria-label="Gap between events"><dt>Gap between events</dt>{([['min',stats.minMs],['avg',stats.avgMs],['p95',stats.p95Ms],['max',stats.maxMs]] as [string,number][]).map(([label,value])=><dd key={label}><small>{label}</small>{formatMs(value)}</dd>)}</dl>}
    {record.captureWarning&&<p className="muted">{record.captureWarning}</p>}
    {events.length?<div className="timeline-scroll"><table className="sse-events"><thead><tr><th>#</th><th>Type</th><th className="sse-col-received">Received</th><th>Gap</th><th className="sse-col-delivery">Delivery</th></tr></thead><tbody>{events.slice(-100).map((event:any,index:number)=>{
      const absolute=Math.max(0,events.length-100)+index, received=startedAtMs(event.receivedAt), previous=absolute?startedAtMs(events[absolute-1].receivedAt):undefined;
      const delivery=event.forwarded===false?'Suppressed':event.forwarded===true?'Forwarded':'Unknown';
      return <tr key={event.sequence??absolute}><td>{event.sequence??absolute+1}</td><td>{event.event??'message'}</td><td className="sse-col-received">{requestTime(event.receivedAt)}</td><td>{typeof event.gapMs==='number'?formatMs(event.gapMs):received!==undefined&&previous!==undefined?formatMs(Math.max(0,received-previous)):'—'}</td><td className="sse-col-delivery"><span className={`sse-delivery ${delivery.toLowerCase()}`} title={delivery}><i aria-hidden="true"/><span>{delivery}</span></span></td></tr>;
    })}</tbody></table></div>:<p className="muted sse-empty">{live?'No events yet.':'The stream ended without sending an event.'}</p>}{events.length>100&&<small>Latest 100 shown</small>}
  </details>;
}

// Connecting -> Open -> Streaming -> how it ended, each with its offset from the request start.
function SseStatusStrip({record, status, live}: {record:any; status:keyof typeof SSE_STATUS; live:boolean}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!live) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [live]);
  const d = record.sseDiagnostics ?? {}, start = startedAtMs(record.startedAt), info = SSE_STATUS[status];
  const at = (value: unknown) => startedAtMs(value as any);
  const steps: {key:string; label:string; time?:number}[] = [
    {key:'connecting', label:'Connecting', time:start},
    {key:'open', label:'Open', time:at(d.headersAt)},
    {key:'streaming', label:'Streaming', time:at(d.firstEventAt)},
    {key:'end', label:live ? 'Ended' : info.label, time:at(d.endedAt ?? record.endedAt)},
  ];
  const current = live ? ['connecting', 'open', 'streaming'].indexOf(status) : 3;
  const offset = (time?: number) => time !== undefined && start !== undefined ? `+${formatMs(Math.max(0, time - start))}` : '';
  const last = at(d.lastEventAt) ?? at(d.headersAt);
  return <div className="sse-status" role="status" aria-label={`Stream ${info.label}`} title={info.description}>
    <ol>{steps.map((step, index) => { const skipped = index < current && step.time === undefined; return <li key={step.key} className={index < current ? (skipped ? 'skipped' : 'done') : index === current ? `current sse-${info.tone}` : 'future'} aria-current={index === current ? 'step' : undefined}>
      <i aria-hidden="true"/><span>{step.label}</span><small>{skipped ? 'not reached' : index <= current ? offset(step.time) : ''}</small></li>; })}</ol>
    {live && status !== 'connecting' && last !== undefined && <p className="muted" title={info.description}>Idle {formatMs(Math.max(0, now - last))}</p>}
  </div>;
}
