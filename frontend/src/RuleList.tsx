import { ListFilter, Trash2 } from 'lucide-react';
import './rule-list.css';

type Rule = { id: string; name?: string; enabled: boolean; pattern: string; method: string; stages: string[]; script?: string; breakpoint?: boolean };

export default function RuleList({ rules, emptyMessage, onToggle, onEdit, onDelete }: {
  rules: Rule[];
  emptyMessage: string;
  onToggle: (rule: Rule, enabled: boolean) => void;
  onEdit: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
}) {
  return <div className="compact-rule-list">
    {rules.map(rule => {
      const name = rule.name?.trim();
      const method = rule.method || '*';
      const customName = name && name !== rule.pattern && name !== `${method} ${rule.pattern}`;
      const label = customName ? name : `${method} ${rule.pattern}`;
      return <div className="compact-rule-row" key={rule.id}>
        <input aria-label={`Enable ${label}`} type="checkbox" checked={rule.enabled} onChange={event => onToggle(rule, event.target.checked)} />
        <button className="compact-rule-detail" aria-label={`Edit ${label}`} onClick={() => onEdit(rule)}>
          {customName && <strong className="compact-rule-name" title={name}>{name}</strong>}
          <span className="compact-rule-target"><span className="compact-rule-method">{method === '*' ? 'ANY' : method}</span><code title={rule.pattern}>{rule.pattern}</code></span>
          <span className="compact-rule-stages">{rule.stages.map(stage => <span key={stage}>{stage === 'request' ? 'Request' : stage === 'response' ? 'Response' : stage === 'event' ? 'Each SSE event' : stage}</span>)}</span>
        </button>
        <button className="icon-button compact-rule-delete" title={`Delete ${label}`} aria-label={`Delete ${label}`} onClick={() => onDelete(rule)}><Trash2 /></button>
      </div>;
    })}
    {!rules.length && <div className="small-empty"><ListFilter /><p>{emptyMessage}</p></div>}
  </div>;
}
