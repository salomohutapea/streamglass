import { startedAtMs, requestTime } from './TrafficTable';

export default function SseTimeline({record}:{record:any}) {
  const d=record.sseDiagnostics??{};
  const start=startedAtMs(record.startedAt), first=startedAtMs(d.firstEventAt), headers=startedAtMs(d.headersAt);
  const elapsed=(time:number|undefined)=>time!==undefined&&start!==undefined?`${Math.max(0,time-start).toFixed(0)} ms`:'—';
  const events=record.events??[];
  return <details className="sse-timeline" open><summary>SSE timeline</summary>
    <dl><dt>Response headers</dt><dd>{elapsed(headers)}</dd><dt>First event</dt><dd>{elapsed(first)}</dd><dt>Events observed</dt><dd>{d.eventCount??record.eventCount??events.length}</dd><dt>Event frame bytes</dt><dd>{d.eventBytes?.toLocaleString()??'—'}</dd><dt>Connection</dt><dd>{d.endReason??(record.state==='complete'?'Completed':record.state==='error'?record.error??'Transport error':'Open')}</dd></dl>
    {record.captureWarning&&<p className="muted">{record.captureWarning}</p>}
    <div className="timeline-scroll"><table><thead><tr><th>Event</th><th>Type</th><th>Received</th><th>Gap</th><th>Delivery</th></tr></thead><tbody>{events.slice(-100).map((event:any,index:number)=>{
      const absolute=Math.max(0,events.length-100)+index, received=startedAtMs(event.receivedAt), previous=absolute?startedAtMs(events[absolute-1].receivedAt):undefined;
      return <tr key={event.sequence??absolute}><td>{event.sequence??absolute+1}</td><td>{event.event??'message'}</td><td>{requestTime(event.receivedAt)}</td><td>{received!==undefined&&previous!==undefined?`${Math.max(0,received-previous).toFixed(0)} ms`:'—'}</td><td>{event.forwarded===false?'Suppressed':event.forwarded===true?'Forwarded':'Unknown'}</td></tr>;
    })}</tbody></table></div>{events.length>100&&<small>Showing the latest 100 retained events.</small>}
  </details>;
}
