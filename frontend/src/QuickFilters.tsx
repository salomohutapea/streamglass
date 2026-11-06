import {useEffect, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {contentTypes, contentTypeLabels} from './traffic-preferences.mjs';

type Props = {protocols:string[];types:string[];statuses:number[];tlsOnly:boolean;onProtocol:(value:string)=>void;onType:(value:string)=>void;onStatus:(value:number)=>void;onTls:()=>void;onClear:()=>void};
export default function QuickFilters({protocols,types,statuses,tlsOnly,onProtocol,onType,onStatus,onTls,onClear}:Props) {
  const strip=useRef<HTMLDivElement>(null);
  const [edges,setEdges]=useState({left:false,right:false});
  const measure=()=>{const el=strip.current;if(el)setEdges({left:el.scrollLeft>1,right:el.scrollLeft+el.clientWidth<el.scrollWidth-1});};
  useEffect(()=>{const el=strip.current;if(!el)return;const observer=new ResizeObserver(measure);observer.observe(el);if(el.firstElementChild)observer.observe(el.firstElementChild);measure();return()=>observer.disconnect();},[]);
  const scroll=(direction:number)=>strip.current?.scrollBy({left:direction*Math.max(160,strip.current.clientWidth*.65),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  return <div className="quick-filter-strip">
    <button className="quick-filter-scroll" aria-label="Scroll quick filters left" disabled={!edges.left} onClick={()=>scroll(-1)}><ChevronLeft size={13}/></button>
    <div ref={strip} className="quick-filter-viewport" onScroll={measure}>
      <div className="quick-filter-options">
        <button aria-pressed={!protocols.length&&!types.length&&!statuses.length&&!tlsOnly} onClick={onClear}>All</button>
        <div role="group" aria-label="Protocol filters">{['HTTP','HTTPS','SSE'].map(value=><button key={value} aria-pressed={protocols.includes(value)} onClick={()=>onProtocol(value)}>{value}</button>)}</div>
        <div role="group" aria-label="Content type filters">{contentTypes.map(value=><button key={value} aria-pressed={types.includes(value)} onClick={()=>onType(value)}>{contentTypeLabels[value]}</button>)}</div>
        <div role="group" aria-label="Status filters">{[1,2,3,4,5].map(value=><button key={value} aria-pressed={statuses.includes(value)} onClick={()=>onStatus(value)}>{value}xx</button>)}</div>
        <div role="group" aria-label="TLS filters"><button aria-pressed={tlsOnly} title="Show only connections with a failed TLS handshake" onClick={onTls}>TLS errors</button></div>
      </div>
    </div>
    <button className="quick-filter-scroll" aria-label="Scroll quick filters right" disabled={!edges.right} onClick={()=>scroll(1)}><ChevronRight size={13}/></button>
  </div>;
}
