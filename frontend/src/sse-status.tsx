// SSE connection status. The engine sends `sseStatus` on capture rows; full records carry the same facts in
// sseDiagnostics, so this mirrors backend/sse_status.py for the inspector.
export type SseStatus = 'connecting'|'open'|'streaming'|'server-closed'|'client-closed'|'server-dropped'|'stream-reset'|'proxy-closed'|'error';
export type SseTone = 'pending'|'live'|'done'|'warn'|'bad';

export const SSE_STATUS: Record<SseStatus, {label:string; tone:SseTone; description:string}> = {
  connecting: {label:'Connecting', tone:'pending', description:'Request sent; waiting for response headers.'},
  open: {label:'Open', tone:'live', description:'Response headers received; waiting for the first event.'},
  streaming: {label:'Streaming', tone:'live', description:'Events are arriving.'},
  'server-closed': {label:'Finished by server', tone:'done', description:'The server ended the stream cleanly.'},
  'client-closed': {label:'Disconnected by client', tone:'warn', description:'The client closed or cancelled the stream.'},
  'server-dropped': {label:'Dropped by server', tone:'bad', description:'The server closed the connection before the response completed.'},
  'stream-reset': {label:'Stream reset', tone:'warn', description:'The HTTP/2 stream was reset.'},
  'proxy-closed': {label:'Closed by Streamglass', tone:'warn', description:'A rule, scenario or proxy error ended the stream.'},
  error: {label:'Transport error', tone:'bad', description:'The stream ended with an error.'},
};
const ended = ['complete', 'error', 'interrupted'];

export function sseStatus(record: any): SseStatus {
  if (record.sseStatus in SSE_STATUS) return record.sseStatus;
  const d = record.sseDiagnostics ?? {};
  if (ended.includes(record.state)) {
    if (d.endReason in SSE_STATUS && !['connecting', 'open', 'streaming'].includes(d.endReason)) return d.endReason;
    // Captures from before structured end reasons kept mitmproxy's message instead.
    if (record.state === 'interrupted') return 'proxy-closed';
    if (record.state === 'complete' || d.endReason === 'upstream-eof') return 'server-closed';
    return /client disconnected|reset by client \(cancel\)/i.test(record.error ?? d.endReason ?? '') ? 'client-closed' : 'error';
  }
  return d.firstEventAt || record.eventCount ? 'streaming' : d.headersAt ? 'open' : 'connecting';
}

export function SseStatusDot({status}: {status: SseStatus}) {
  const info = SSE_STATUS[status];
  return <span className={`sse-dot sse-${info.tone}`} role="img" aria-label={info.label} title={`${info.label}. ${info.description}`}/>;
}
