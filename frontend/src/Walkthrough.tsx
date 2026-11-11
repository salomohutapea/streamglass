import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { availableStops, placeTooltip, unionRect, walkthroughStops, type Box } from './walkthrough-steps.mjs';
import './walkthrough.css';

const visible = (element: Element) => { const rect = element.getBoundingClientRect(); return rect.width > 1 && rect.height > 1; };
const matches = (selector: string) => [...document.querySelectorAll(selector)].filter(visible);

/** Tooltip tour over the real interface: each stop highlights a control and explains it. Esc, Done or a click
 *  outside ends it. Runs in a modal dialog, so the page behind is inert and focus stays in the tooltip. */
export default function Walkthrough({ hasRecords, onClose }: { hasRecords: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), tip = useRef<HTMLDivElement>(null), next = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(0);
  const [layout, setLayout] = useState<{ box: Box; left: number; top: number; side: string } | null>(null);
  // Sidebar stops are measured with the sidebar expanded, so decide which stops exist while it is held open.
  const pinned = useRef(document.documentElement.hasAttribute('data-sidebar-pinned'));
  const holdSidebar = useCallback((open: boolean) => { document.documentElement.toggleAttribute('data-sidebar-pinned', open || pinned.current); }, []);
  const stops = useMemo(() => { holdSidebar(true); const found = availableStops(walkthroughStops, selector => matches(selector).length > 0); holdSidebar(false); return found; }, [holdSidebar]);
  const stop = stops[index];

  useEffect(() => { dialog.current?.showModal(); return () => holdSidebar(false); }, [holdSidebar]);
  useEffect(() => { if (!stops.length) onClose(); }, [stops.length, onClose]);
  useEffect(() => { if (stop) { holdSidebar(!!stop.sidebar); next.current?.focus(); } }, [stop, holdSidebar]);

  // Re-measure while open: the sidebar animates, panes resize, and zoom changes move the targets.
  useLayoutEffect(() => {
    if (!stop) return;
    const measure = () => {
      const elements = stop.targets.flatMap(matches);
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const box = unionRect(elements.map(element => element.getBoundingClientRect()), viewport);
      if (!box || !tip.current) return;
      const place = placeTooltip(box, { width: tip.current.offsetWidth, height: tip.current.offsetHeight }, viewport);
      setLayout(old => old && old.left === place.left && old.top === place.top && old.box.left === box.left && old.box.top === box.top && old.box.width === box.width && old.box.height === box.height ? old : { box, ...place });
    };
    stop.targets.flatMap(matches)[0]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
    const timer = setInterval(measure, 120);
    window.addEventListener('resize', measure);
    return () => { clearInterval(timer); window.removeEventListener('resize', measure); };
  }, [stop]);

  if (!stop) return null;
  const last = index === stops.length - 1;
  const go = (to: number) => setIndex(Math.max(0, Math.min(stops.length - 1, to)));
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); go(index + 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); }
  };
  return <dialog ref={dialog} className="walkthrough" aria-label="Walkthrough" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={onKeyDown} onClick={event => { if (!tip.current?.contains(event.target as Node)) onClose(); }}>
    <div className="walk-spot" aria-hidden="true" style={layout ? { left: layout.box.left, top: layout.box.top, width: layout.box.width, height: layout.box.height } : { opacity: 0 }}/>
    <div ref={tip} className="walk-tip" data-side={layout?.side} style={layout ? { left: layout.left, top: layout.top } : { visibility: 'hidden' }}>
      <div className="walk-text" aria-live="polite" key={stop.id}><h2>{stop.title}</h2><p>{!hasRecords && stop.emptyText || stop.text}</p></div>
      <div className="walk-foot"><span className="muted" role="img" aria-label={`Stop ${index + 1} of ${stops.length}`}>{index + 1} of {stops.length}</span>
        <button type="button" className="walk-skip" onClick={onClose}>{last ? 'Close' : 'End tour'}</button>
        {index > 0 && <button type="button" onClick={() => go(index - 1)}>Back</button>}
        <button ref={next} type="button" className="primary" onClick={() => last ? onClose() : go(index + 1)}>{last ? 'Done' : 'Next'}</button></div>
    </div>
  </dialog>;
}
