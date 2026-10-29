import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import EditorWindow from './EditorWindow';
import PausedWindow from './PausedWindow';
import AboutWindow from './AboutWindow';
import './style.css';
const mode = new URLSearchParams(location.search).get('editor');
const Surface = new URLSearchParams(location.search).has('about') ? AboutWindow : mode === 'paused' ? PausedWindow : mode && mode !== 'tools' ? EditorWindow : App;
createRoot(document.getElementById('root')!).render(<React.StrictMode><Surface /></React.StrictMode>);
if (/Mac/.test(navigator.userAgent)) document.documentElement.dataset.titlebar = 'inset';
// Page zoom (⌘+/⌘-) scales CSS pixels, but the macOS traffic lights stay put. Title bars divide their height and
// inset by the zoom factor so they keep the same on-screen size and stay centred on the lights; their contents zoom.
// Chromium reports outerWidth in screen points and innerWidth in CSS pixels, so their ratio is the zoom factor.
function syncZoom() { const zoom = window.outerWidth > 0 && window.innerWidth > 0 ? window.outerWidth / window.innerWidth : 1; document.documentElement.style.setProperty('--ui-zoom', String(Math.round(zoom * 100) / 100)); }
syncZoom();
window.addEventListener('resize', syncZoom);
