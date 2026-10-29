import { useEffect, useState } from 'react';
import { Bug, GitBranch, Mail, Scale } from 'lucide-react';
import logo from './assets/streamglass.svg';
import './about.css';

type Bridge = { getAboutInfo?(): Promise<{ version: string; electron: string }>; openAboutLink?(key: string): Promise<void> };
const bridge = () => (window as unknown as { streamglass?: Bridge }).streamglass;
const links = [
  { key: 'issues', label: 'Report an issue', hint: 'github.com/…/issues', Icon: Bug },
  { key: 'email', label: 'Contact', hint: 'me@salomo.dev', Icon: Mail },
  { key: 'repository', label: 'Source code', hint: 'github.com/salomohutapea/streamglass', Icon: GitBranch },
  { key: 'license', label: 'MIT License', hint: 'Free software', Icon: Scale },
];

export default function AboutWindow() {
  const [version, setVersion] = useState('');
  useEffect(() => { document.title = 'About Streamglass'; try { document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'; } catch { document.documentElement.dataset.theme = 'dark'; } void bridge()?.getAboutInfo?.().then(info => setVersion(info.version)).catch(() => {}); }, []);
  return <main className="about-window">
    <header className="window-header about-header" aria-hidden="true" />
    <section className="about-hero">
      <img src={logo} alt="" width={84} height={84} />
      <h1>Streamglass</h1>
      <p className="about-version">{version ? `Version ${version}` : ' '}</p>
      <p className="about-tagline">Inspect HTTP, HTTPS and SSE traffic.</p>
    </section>
    <nav className="about-links" aria-label="Links">
      {links.map(({ key, label, hint, Icon }) => <button key={key} type="button" onClick={() => void bridge()?.openAboutLink?.(key)}><Icon size={16} /><span><strong>{label}</strong><small>{hint}</small></span></button>)}
    </nav>
    <footer>© 2026 Salomo Hutapea</footer>
  </main>;
}
