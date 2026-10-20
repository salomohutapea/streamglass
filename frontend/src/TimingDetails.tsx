import { Fragment } from 'react';
import './timing.css';
import { waterfallSegments, formatMs } from './timing.mjs';

/** Overview "Timing" section: a proportional waterfall bar plus the exact values. Hidden when the engine recorded none. */
export default function TimingDetails({timings}:{timings?:Record<string,number>}) {
  const segments = waterfallSegments(timings);
  if (!segments.length) return null;
  const total = segments.reduce((sum, item) => sum + item.ms, 0);
  return <section className="timing-section" aria-label="Timing"><h3>Timing</h3>
    <div className="waterfall" role="img" aria-label={`Total ${formatMs(total)}: ${segments.map(item => `${item.label} ${formatMs(item.ms)}`).join(', ')}`}>{segments.map(item => <i key={item.key} className={`seg-${item.key}`} style={{width: `${item.widthPct}%`}} title={`${item.label}: ${formatMs(item.ms)}`}/>)}</div>
    <dl>{segments.map(item => <Fragment key={item.key}><dt><i className={`seg-${item.key}`}/>{item.label}</dt><dd>{formatMs(item.ms)}</dd></Fragment>)}</dl>
  </section>;
}
