import type { ReactNode } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import './banner.css';

type Tone = 'info' | 'warn' | 'error';
const icons = { info: Info, warn: TriangleAlert, error: CircleAlert };

/** One row for app-level messages under a toolbar or window header: icon, message, actions on the right.
 *  Errors announce as alerts; info and warnings as polite status. `className` keeps legacy hooks working. */
export default function Banner({ tone, icon, children, actions, className = '' }: { tone: Tone; icon?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  const Icon = icons[tone];
  return <div className={`banner banner-${tone} ${className}`.trim()} role={tone === 'error' ? 'alert' : 'status'}>
    {icon ?? <Icon size={14} aria-hidden="true"/>}<span className="banner-text">{children}</span>{actions && <div className="banner-actions">{actions}</div>}
  </div>;
}
