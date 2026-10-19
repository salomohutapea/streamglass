import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import EditorWindow from './EditorWindow';
import './style.css';
const mode = new URLSearchParams(location.search).get('editor');
const Surface = mode && mode !== 'tools' ? EditorWindow : App;
createRoot(document.getElementById('root')!).render(<React.StrictMode><Surface /></React.StrictMode>);
if (/Mac/.test(navigator.userAgent) && !new URLSearchParams(location.search).has('editor') && !new URLSearchParams(location.search).has('record')) document.documentElement.dataset.titlebar = 'inset';
