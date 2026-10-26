import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import JsonViewer from './JsonViewer';
import { eventGaps, longGapThreshold, formatMs } from './timing.mjs';
import './timing.css';

type SseEvent = { event?: string; type?: string; data?: unknown; timestamp?: number; receivedAt?: number };

const PAGE = 500;
const PREVIEW = 600;

// Long streams stay responsive: each event is a short text preview, and only expanded events mount an editor.
// The list shows the newest PAGE events and loads earlier ones on request; off-screen rows skip layout.
export default function SseEventList({ events, headersAt }: { events: SseEvent[]; headersAt?: number }) {
  const [shown, setShown] = useState(PAGE);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const { gaps, limit } = useMemo(() => {
    const gaps = eventGaps(events, typeof headersAt === 'number' ? headersAt * 1000 : undefined);
    return { gaps, limit: longGapThreshold(gaps.filter((g): g is number => g !== undefined && Number.isFinite(g))) };
  }, [events, headersAt]);
  const first = Math.max(0, events.length - shown);
  const toggle = (index: number) => setExpanded(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  return <>
    {first > 0 && <button type="button" className="events-earlier" onClick={() => setShown(value => value + PAGE)}>Show {Math.min(PAGE, first)} earlier events ({first} hidden)</button>}
    {events.slice(first).map((event, offset) => {
      const index = first + offset, open = expanded.has(index), gap = gaps[index];
      const text = typeof event.data === 'string' ? event.data : JSON.stringify(event.data) ?? '';
      return <div className={`event${open ? ' open' : ''}`} key={index}>
        <div>
          <button type="button" className="event-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} event ${index + 1}`} onClick={() => toggle(index)}><ChevronRight size={12} /></button>
          <span className="event-number">{String(index + 1).padStart(3, '0')}</span>
          <strong>{event.event ?? event.type ?? 'message'}</strong>
          {gap !== undefined && Number.isFinite(gap) && <span className={(gap as number) > limit ? 'event-gap long' : 'event-gap'} title={(gap as number) > limit ? 'More than 3x the median gap' : 'Time since the previous event'}>+{formatMs(gap as number)}</span>}
          <time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''}</time>
        </div>
        {open ? <JsonViewer value={event.data} /> : <pre className="event-preview" onClick={() => toggle(index)}>{text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text}</pre>}
      </div>;
    })}
  </>;
}
