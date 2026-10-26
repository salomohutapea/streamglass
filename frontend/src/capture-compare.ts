import { useEffect, useRef, useState } from 'react';
import CompareWorker from './compare-worker.ts?worker';
import type { CaptureComparison } from './capture-tools.mjs';

export type CompareOptions = { section: 'request' | 'response' | 'events'; ignoreFields: string[]; eventKey: 'sequence' | 'id' };
export type ComparisonResult = { comparison: CaptureComparison; texts: { original: string; modified: string } | null };

// Compares two captures in a worker. A newer request terminates the busy worker instead of queueing behind it, and
// typing in the ignore list waits briefly so each keystroke doesn't start a full comparison.
export function useCaptureComparison(left: unknown, right: unknown, options: CompareOptions) {
  const [state, setState] = useState<{ result: ComparisonResult | null; pending: boolean; error: string }>({ result: null, pending: false, error: '' });
  const worker = useRef<Worker | null>(null), busy = useRef(false), request = useRef(0);
  const key = `${options.section}|${options.eventKey}|${options.ignoreFields.join(',')}`;
  useEffect(() => () => { worker.current?.terminate(); worker.current = null; }, []);
  useEffect(() => {
    if (!left || !right) { setState({ result: null, pending: false, error: '' }); return; }
    const id = ++request.current;
    setState(current => ({ ...current, pending: true, error: '' }));
    const timer = setTimeout(() => {
      if (busy.current) { worker.current?.terminate(); worker.current = null; }
      if (!worker.current) worker.current = new CompareWorker();
      const active = worker.current;
      busy.current = true;
      active.onmessage = (event: MessageEvent<{ id: number; error?: string } & ComparisonResult>) => {
        if (event.data.id !== request.current) return;
        busy.current = false;
        setState(event.data.error ? { result: null, pending: false, error: event.data.error } : { result: { comparison: event.data.comparison, texts: event.data.texts }, pending: false, error: '' });
      };
      active.onerror = event => { if (id === request.current) { busy.current = false; setState({ result: null, pending: false, error: event.message || 'Comparison failed' }); } };
      active.postMessage({ id, left, right, options });
    }, 200);
    return () => clearTimeout(timer);
  }, [left, right, key]);
  return state;
}
