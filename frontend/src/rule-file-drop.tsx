import { useState, type DragEvent } from 'react';
import './rule-file-drop.css';

export const ruleFileLimit = 16 * 1024 * 1024;
export type RuleImportResult = { breakpoints: number; scripts: number };

export async function readDroppedRuleBundles(files: File[]): Promise<unknown[]> {
  if (files.length > 500 || files.reduce((size, file) => size + file.size, 0) > ruleFileLimit) {
    throw new Error('Drop at most 500 rule files totaling up to 16 MiB.');
  }
  const bundles: unknown[] = [];
  for (const file of files) {
    if (!/\.(sgrules|json)$/i.test(file.name)) throw new Error('Drop a Streamglass .sgrules or .json file.');
    try {
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      bundles.push(JSON.parse(contents));
    } catch { throw new Error(`Invalid JSON in "${file.name}"`); }
  }
  return bundles;
}

export type RuleImportNotice = { id: number; count: number };

export function importedRuleNotice(kind: keyof RuleImportResult, count: number) {
  const noun = kind === 'scripts' ? 'script' : 'breakpoint';
  return `Imported ${count} ${noun}${count === 1 ? '' : 's'} as ${count === 1 ? 'a disabled rule' : 'disabled rules'}.`;
}

export function useRuleFileDrop(canAccept: () => boolean, importFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);

  function onDragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return false;
    event.preventDefault();
    const accepting = canAccept();
    event.dataTransfer.dropEffect = accepting ? 'copy' : 'none';
    setOver(accepting);
    return true;
  }

  function onDragLeave(event: DragEvent) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOver(false);
  }

  function onDrop(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return false;
    event.preventDefault();
    setOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (canAccept() && files.length) importFiles(files);
    return true;
  }

  return { over, onDragOver, onDragLeave, onDrop };
}

export function RuleFileDropIndicator() {
  return <div className="rule-file-drop-indicator" role="status">
    <span>Drop rule files to import</span>
  </div>;
}
