import {useCallback, useEffect, useLayoutEffect, useRef} from 'react';
import {flushSync} from 'react-dom';
import './inspector-transition.css';

type Position = 'right'|'below';

export function useInspectorTransition(position:Position, onChange:(next:Position)=>void, enabled:boolean) {
  const requested=useRef(position);
  const generation=useRef(0);
  const current=useRef<ViewTransition|null>(null);
  useLayoutEffect(()=>{requested.current=position;},[position]);
  useEffect(()=>{
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    const skip=()=>{if(reduced.matches)current.current?.skipTransition();};
    reduced.addEventListener('change',skip);
    return()=>{
      reduced.removeEventListener('change',skip);
      generation.current++;
      current.current?.skipTransition();
      document.documentElement.classList.remove('inspector-transition');
    };
  },[]);
  useEffect(()=>{if(!enabled)current.current?.skipTransition();},[enabled]);

  return useCallback((next:Position)=>{
    if(next===requested.current)return;
    requested.current=next;
    const revision=++generation.current;
    current.current?.skipTransition();
    current.current=null;
    document.documentElement.classList.remove('inspector-transition');
    if(!enabled||next===position||matchMedia('(prefers-reduced-motion: reduce)').matches||typeof document.startViewTransition!=='function') {
      onChange(next);
      return;
    }
    document.documentElement.classList.add('inspector-transition');
    try {
      const transition=document.startViewTransition(()=>{
        // An older queued callback must not overwrite a newer toggle.
        if(revision===generation.current)flushSync(()=>onChange(next));
      });
      current.current=transition;
      // Capture can be skipped (e.g. rapid toggling or a hidden window); the position still updates.
      void transition.ready.catch(()=>{});
      void transition.updateCallbackDone.catch(()=>{});
      void transition.finished.catch(()=>{}).finally(()=>{
        if(current.current===transition){
          current.current=null;
          document.documentElement.classList.remove('inspector-transition');
        }
      });
    } catch {
      document.documentElement.classList.remove('inspector-transition');
      onChange(next);
    }
  },[position,onChange,enabled]);
}
