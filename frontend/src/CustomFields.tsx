import { Copy, Settings2 } from 'lucide-react';
import { chipTitle, fieldChips, fieldsForTab, locationText, prettyValue, stateText, type FieldResult } from './custom-fields.mjs';
import './custom-fields.css';

export function FieldChips({ fields }: { fields?: FieldResult[] }) {
  const chips = fieldChips(fields);
  if (!chips.length) return <span className="muted">—</span>;
  return <span className="field-chips">{chips.map(chip => <span className="field-chip" key={chip.id} title={chipTitle(chip)}><span className="field-chip-name">{chip.name}</span><span className="field-chip-value">{chip.value}</span>{chip.more > 0 && <span className="field-chip-more">+{chip.more}</span>}</span>)}</span>;
}

const copy = (text: string) => void navigator.clipboard?.writeText(text);

function FieldValue({ name, value, summary }: { name: string; value: string; summary?: string | null }) {
  if (!summary) return <span className="custom-field-value"><code>{value}</code><button className="icon-button" aria-label={`Copy ${name} value`} title="Copy value" onClick={() => copy(value)}><Copy size={12} /></button></span>;
  // Arrays and objects: pretty JSON in a bounded scroll box. Text cut at the engine's cap is shown as it is.
  const pretty = prettyValue(value);
  return <div className="custom-field-json">
    <div className="custom-field-json-head"><span>{summary}</span>{!pretty && <span className="muted">Shortened</span>}<button className="icon-button" aria-label={`Copy ${name} value`} title="Copy JSON" onClick={() => copy(pretty ?? value)}><Copy size={12} /></button></div>
    <pre>{pretty ?? value}</pre>
  </div>;
}

// Shown above the inspector content: the custom fields configured for this API, read from the tab's content.
export function CustomFieldsSection({ fields, tab, onEdit }: { fields?: FieldResult[]; tab: string; onEdit?: () => void }) {
  const shown = fieldsForTab(fields, tab);
  if (!shown.length) return null;
  return <section className="custom-fields" aria-label="Custom fields">
    <div className="custom-fields-head"><h3>Custom fields</h3>{onEdit && <button className="icon-button" aria-label="Edit custom fields" title="Edit custom fields" onClick={onEdit}><Settings2 size={13} /></button>}</div>
    <dl>{shown.map(field => <div key={field.id} className={`custom-field state-${field.state}`}>
      <dt><strong>{field.name}</strong><small title={(field.locations ?? []).map(locationText).join('\n')}>{(field.locations ?? []).map(locationText).join(' · ')}</small></dt>
      <dd>{field.values.length ? <>{field.values.map((value, index) => <FieldValue key={index} name={field.name} value={value} summary={field.summaries?.[index]} />)}
        {(field.count > field.values.length || (field.limited && !field.summaries?.some(Boolean))) && <small className="muted">{field.count > field.values.length ? `First ${field.values.length} of ${field.count}${field.limited ? '+' : ''}` : 'Shortened'}</small>}</> : <span className="muted">{stateText(field)}</span>}</dd>
    </div>)}</dl>
  </section>;
}
