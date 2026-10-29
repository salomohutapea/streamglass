import { useEffect, useRef, useState } from 'react';
import { Code2, FileInput, Gauge, Info, Laptop, Pause, type LucideIcon } from 'lucide-react';
import './onboarding.css';

export const onboardingKey = 'streamglass.onboarding.v1';
export function onboardingSeen() { try { return localStorage.getItem(onboardingKey) === 'done'; } catch { return true; } }
export function markOnboardingSeen() { try { localStorage.setItem(onboardingKey, 'done'); } catch {} }

const tools: readonly (readonly [string, string, string, LucideIcon])[] = [
  ['Breakpoints', 'Pause, edit, release.', 'GET /orders · paused', Pause],
  ['Scripts', 'Rewrite traffic with JavaScript.', 'x-env: staging · set', Code2],
  ['Map Local', 'Answer from a local file.', 'GET /orders → orders.json', FileInput],
  ['Network conditions', 'Throttle and add latency.', 'GET /orders · 2.4 s', Gauge],
];
const streamEvents = ['delta "Hel"', 'delta "lo, "', 'delta "wor"', 'delta "ld"'];
const agentQuestion = 'why did checkout return 401?';

function Welcome() {
  const [shown, setShown] = useState(0);
  useEffect(() => { const timer = setInterval(() => setShown(count => Math.min(count + 1, streamEvents.length)), 700); return () => clearInterval(timer); }, []);
  return <div className="ob-card ob-rows">
    <div className="ob-row" style={{ animationDelay: '.1s' }}><b className="get">GET</b><span>api.example.com/user</span><i>200</i></div>
    <div className="ob-row sel" style={{ animationDelay: '.35s' }}><b className="post">POST</b><span>chat.example.com/conversation</span><i className="sse">SSE</i></div>
    <div className="ob-events">{streamEvents.slice(0, shown).map((event, index) => <div key={event} className="ob-event">event #{index + 1} · {event}</div>)}</div>
    <div className="ob-row" style={{ animationDelay: '.6s' }}><b className="get">GET</b><span>images.example.com/hero.jpg</span><i>304</i></div>
    <div className="ob-row last" style={{ animationDelay: '.85s' }}><b className="get">GET</b><span>api.example.com/orders</span><i className="warn">401</i></div>
  </div>;
}
function Connect() {
  return <div className="ob-card ob-connect"><small>Connect device</small>
    <div className="ob-device"><Laptop size={20}/><div><div>This Mac</div><small>Wi-Fi · 127.0.0.1:9090</small></div><span className="ob-toggle"><i/></span></div>
    <div className="ob-live"><i/>Capturing</div></div>;
}
function Certificate() {
  return <div className="ob-cert"><svg width="92" height="104" viewBox="0 0 92 104" aria-hidden="true"><path className="ob-shield" d="M46 4 L84 18 V50 C84 74 66 92 46 100 C26 92 8 74 8 50 V18 Z"/><path className="ob-check" d="M28 52 L41 65 L66 38"/></svg>
    <div className="ob-allow"><small>TLS allowlist</small><span style={{ animationDelay: '.6s' }}>api.example.com</span><span style={{ animationDelay: '.8s' }}>chat.example.com</span><span className="add" style={{ animationDelay: '1s' }}>+ Add domain</span></div></div>;
}
function Tools({ active, onPick }: { active: number; onPick: (index: number) => void }) {
  return <div className="ob-tools">{tools.map(([name, , , Icon], index) => <button key={name} className={index === active ? 'on' : ''} onClick={() => onPick(index)}><Icon size={14} aria-hidden="true"/>{name}</button>)}
    <div className="ob-paused" key={active}>{tools[active][2]}</div></div>;
}
function Agent() {
  const [typed, setTyped] = useState(0);
  const [lines, setLines] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTyped(count => Math.min(count + 1, agentQuestion.length)), 45);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (typed < agentQuestion.length) return;
    const timers = [1, 2, 3].map(count => setTimeout(() => setLines(count), 500 * count));
    return () => timers.forEach(clearTimeout);
  }, [typed]);
  return <div className="ob-term"><div className="dim">$ claude</div><div className="ob-prompt"><span>&gt;</span><span>{agentQuestion.slice(0, typed)}</span><i/></div>
    <div className="ob-answer">{lines > 0 && <div className="ob-event"><b className="ok">✓</b> streamglass.search_captures  host:api.example.com</div>}{lines > 1 && <div className="ob-event"><b className="ok">✓</b> streamglass.get_capture  #412</div>}{lines > 2 && <div className="ob-event bright">Token expired before the call.</div>}</div></div>;
}

export default function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [tool, setTool] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  const ref = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.showModal(); primary.current?.focus(); }, []);
  useEffect(() => {
    if (step !== 3 || !autoplay) return;
    const timer = setInterval(() => setTool(current => (current + 1) % tools.length), 3500);
    return () => clearInterval(timer);
  }, [step, autoplay]);
  const copy: { title: string; text: string; note?: string }[] = [
    { title: 'Welcome to Streamglass', text: 'See HTTP, HTTPS and SSE traffic.' },
    { title: 'Connect', text: 'Pick a device, turn on capture.', note: 'No admin password? Use certificate-only setup and point your app at 127.0.0.1:9090.' },
    { title: 'Trust the certificate', text: 'Then add domains to inspect.', note: 'iPhone: also enable full trust in Settings → General → About → Certificate Trust Settings.' },
    { title: tools[tool][0], text: tools[tool][1], note: 'The inspector is read-only. Breakpoints and scripts open in their own windows.' },
    { title: 'Let your AI drive', text: 'Local MCP server. Turn it on in Proxy settings.', note: 'Listens on 127.0.0.1 and needs a token.' },
  ];
  const last = step === copy.length - 1;
  const current = copy[step];
  const go = (next: number) => setStep(Math.max(0, Math.min(copy.length - 1, next)));
  // Arrow keys step through the tour from anywhere in the dialog, without moving focus to Skip.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault();
    go(step + (event.key === 'ArrowRight' ? 1 : -1));
    primary.current?.focus();
  };
  return <dialog ref={ref} className="onboarding" aria-label="Welcome tour" onCancel={onClose} onKeyDown={onKeyDown} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="ob-top"><span role="img" aria-label={`Step ${step + 1} of ${copy.length}`}>{step + 1} / {copy.length}</span><button onClick={onClose}>Skip tour</button></div>
    <div className="ob-stage" key={step}>{step === 0 ? <Welcome/> : step === 1 ? <Connect/> : step === 2 ? <Certificate/> : step === 3 ? <Tools active={tool} onPick={index => { setAutoplay(false); setTool(index); }}/> : <Agent/>}</div>
    <div className="ob-body" aria-live="polite"><div className="ob-fade" key={`${step}-${step === 3 ? tool : ''}`}><div className="ob-title"><h2>{current.title}</h2>{current.note && <span className="ob-info" role="img" aria-label={current.note} title={current.note}><Info size={14}/></span>}</div><p>{current.text}</p></div></div>
    <div className="ob-foot"><div className="ob-dots" aria-hidden="true">{copy.map((_, index) => <i key={index} className={index === step ? 'on' : ''}/>)}</div>
      <div className="ob-actions">{step > 0 && <button onClick={() => go(step - 1)}>Back</button>}<button ref={primary} className="primary" autoFocus onClick={() => last ? onClose() : go(step + 1)}>{last ? 'Start' : 'Next'}</button></div></div>
  </dialog>;
}
