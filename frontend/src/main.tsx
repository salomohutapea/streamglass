import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import EditorWindow from './EditorWindow';
import PausedWindow from './PausedWindow';
import AboutWindow from './AboutWindow';
import './style.css';
import './active-states.css';
const mode = new URLSearchParams(location.search).get('editor');
const Surface = new URLSearchParams(location.search).has('about') ? AboutWindow : mode === 'paused' ? PausedWindow : mode && mode !== 'tools' ? EditorWindow : App;
createRoot(document.getElementById('root')!).render(<React.StrictMode><Surface /></React.StrictMode>);
if (/Mac/.test(navigator.userAgent)) document.documentElement.dataset.titlebar = 'inset';
// Page zoom (⌘+/⌘-) scales CSS pixels, but the macOS traffic lights stay put. Title bars divide their height and
// inset by the zoom factor so they keep the same on-screen size and stay centred on the lights; their contents zoom.
// Window dimensions can update at different times during resize; use Electron's actual page zoom.
function syncZoom(factor:number) {
  if(Number.isFinite(factor)&&factor>0){
    const value=String(factor),style=document.documentElement.style;
    if(style.getPropertyValue('--ui-zoom')!==value)style.setProperty('--ui-zoom',value);
  }
}
let zoomRevision=0,zoomFrame=0;
function readZoom(){
  const revision=++zoomRevision;
  void window.streamglass?.getUiZoom?.().then(factor=>{if(revision===zoomRevision)syncZoom(factor);}).catch(()=>{});
}
const stopZoom=window.streamglass?.onUiZoom?.(factor=>{zoomRevision++;syncZoom(factor);});
const resizeZoom=()=>{if(!zoomFrame)zoomFrame=requestAnimationFrame(()=>{zoomFrame=0;readZoom();});};
readZoom();
window.addEventListener('resize',resizeZoom);
window.addEventListener('pagehide',()=>{zoomRevision++;cancelAnimationFrame(zoomFrame);window.removeEventListener('resize',resizeZoom);stopZoom?.();},{once:true});
