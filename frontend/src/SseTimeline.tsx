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
  return <details className="sse-timeline" open><summary>SSE timeline</summary>
    <SseStatusStrip record={record} status={status} live={live}/>
    <dl><dt>Response headers</dt><dd>{elapsed(headers)}</dd><dt>First event</dt><dd>{elapsed(first)}</dd><dt>Events observed</dt><dd>{d.eventCount??record.eventCount??events.length}</dd><dt>Event frame bytes</dt><dd>{d.eventBytes?.toLocaleString()??'—'}</dd><dt>Event gap</dt><dd>{stats?`min ${formatMs(stats.minMs)} · avg ${formatMs(stats.avgMs)} · p95 ${formatMs(stats.p95Ms)} · max ${formatMs(stats.maxMs)}`:'—'}</dd><dt>Connection</dt><dd>{info.label}{detail&&<span className="muted"> · {detail}</span>}</dd></dl>
    {record.captureWarning&&<p className="muted">{record.captureWarning}</p>}
    <div className="timeline-scroll"><table><thead><tr><th>Event</th><th>Type</th><th>Received</th><th>Gap</th><th>Delivery</th></tr></thead><tbody>{events.slice(-100).map((event:any,index:number)=>{
      const absolute=Math.max(0,events.length-100)+index, received=startedAtMs(event.receivedAt), previous=absolute?startedAtMs(events[absolute-1].receivedAt):undefined;
      return <tr key={event.sequence??absolute}><td>{event.sequence??absolute+1}</td><td>{event.event??'message'}</td><td>{requestTime(event.receivedAt)}</td><td>{typeof event.gapMs==='number'?formatMs(event.gapMs):received!==undefined&&previous!==undefined?formatMs(Math.max(0,received-previous)):'—'}</td><td>{event.forwarded===false?'Suppressed':event.forwarded===true?'Forwarded':'Unknown'}</td></tr>;
    })}</tbody></table></div>{events.length>100&&<small>Showing the latest 100 retained events.</small>}
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
  return <div className="sse-status" role="status" aria-label={`Stream ${info.label}`}>
    <ol>{steps.map((step, index) => <li key={step.key} className={index < current ? (step.time === undefined ? 'skipped' : 'done') : index === current ? `current sse-${info.tone}` : 'future'}>
      {index === current ? <SseStatusDot status={status}/> : <i/>}<span>{step.label}</span><small>{index <= current ? offset(step.time) : ''}</small></li>)}</ol>
    <p className="muted">{info.description}{live && status !== 'connecting' && last !== undefined ? ` Idle ${formatMs(Math.max(0, now - last))} since the last ${status === 'open' ? 'header' : 'event'}.` : ''}</p>
  </div>;
}
