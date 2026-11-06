import {useEffect, useRef} from 'react';
import {Search, X} from 'lucide-react';
import './list-search.css';

type Props={label:string;placeholder?:string;value:string;onChange:(value:string)=>void;matches:number;total:number;onEnter?:()=>void};
export default function ListSearch({label,placeholder,value,onChange,matches,total,onEnter}:Props) {
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    const focus=(event:KeyboardEvent)=>{
      if(event.target instanceof Element&&event.target.closest('.monaco-editor'))return;
      if((event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='f') {
        event.preventDefault();event.stopPropagation();input.current?.focus();input.current?.select();
      }
    };
    window.addEventListener('keydown',focus,true);
    return()=>window.removeEventListener('keydown',focus,true);
  },[]);
  return <div className="list-search-bar">
    <label className="list-search"><Search size={13} aria-hidden="true"/>
      <input ref={input} type="search" aria-label={label} placeholder={placeholder??label} value={value} maxLength={256} onChange={event=>onChange(event.target.value)} onKeyDown={event=>{
        if(event.key==='Escape'&&value){event.preventDefault();event.stopPropagation();onChange('');}
        if(event.key==='Enter'&&onEnter&&value.trim()){event.preventDefault();onEnter();}
      }}/>
      {value&&<button type="button" className="list-search-clear" aria-label={`Clear ${label.toLowerCase()}`} title="Clear search" onClick={()=>{onChange('');input.current?.focus();}}><X size={12}/></button>}
    </label>
    {value.trim()&&<span className="list-search-count" role="status" aria-live="polite">{matches} of {total}</span>}
  </div>;
}
