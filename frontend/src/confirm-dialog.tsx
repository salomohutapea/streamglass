import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { TriangleAlert } from 'lucide-react';
import './confirm-dialog.css';

export type ConfirmOptions = { title: string; message?: string; confirmLabel: string; cancelLabel?: string; danger?: boolean };

function ConfirmDialog({ title, message, confirmLabel, cancelLabel = 'Cancel', danger, onResult }: ConfirmOptions & { onResult(ok: boolean): void }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  return <dialog ref={dialog} className="confirm-dialog" role="alertdialog" aria-label={title} aria-describedby={message ? 'confirm-dialog-message' : undefined}
    onCancel={event => { event.preventDefault(); onResult(false); }} onClick={event => { if (event.target === event.currentTarget) onResult(false); }}>
    <div className="confirm-body">{danger && <TriangleAlert className="confirm-icon" size={18} aria-hidden="true"/>}<div><h2>{title}</h2>{message && <p id="confirm-dialog-message">{message}</p>}</div></div>
    <div className="confirm-foot"><button ref={cancel} type="button" onClick={() => onResult(false)}>{cancelLabel}</button><button type="button" className={danger ? 'danger-button' : 'primary'} onClick={() => onResult(true)}>{confirmLabel}</button></div>
  </dialog>;
}

/** In-app replacement for window.confirm. Cancel is focused and Esc cancels; resolves true only on the confirm button. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const finish = (ok: boolean) => { root.unmount(); host.remove(); resolve(ok); };
    root.render(<ConfirmDialog {...options} onResult={finish}/>);
  });
}
