import { normalizeExtraConditions } from './filter-conditions.mjs';

const modeLabels = {contains: 'contains', not_contains: "doesn't contain", equals: 'equals', starts_with: 'starts with', ends_with: 'ends with', wildcard: 'matches'};
const libraryLabels = {sse: 'SSE only', pinned: 'Pinned'};

const normalize = view => ({filter: view.filter ?? '', scope: view.scope, mode: view.mode, conditions: normalizeExtraConditions(view.conditions),
  protocols: [...(view.protocols ?? [])].sort(), statuses: [...(view.statuses ?? [])].sort(), device: view.device ?? 'all', application: view.application ?? null, library: view.library ?? 'all'});

// A saved filter is shown as applied while the traffic window's filters are exactly its filters.
export function viewMatches(view, current) {
  return !!view && !!current && JSON.stringify(normalize(view)) === JSON.stringify(normalize(current));
}

// The applied filter stays chosen among identical ones; otherwise the first saved filter that matches.
export function matchingViewId(views, current, appliedId) {
  const applied = views.find(view => view.id === appliedId);
  if (applied && viewMatches(applied, current)) return applied.id;
  return views.find(view => viewMatches(view, current))?.id ?? '';
}

export function describeView(view) {
  const value = normalize(view), parts = [];
  parts.push(value.filter ? `${value.scope} ${modeLabels[value.mode] ?? value.mode} "${value.filter}"` : 'any content');
  if (value.conditions.length) parts.push(`+${value.conditions.length} ${value.conditions.length === 1 ? 'condition' : 'conditions'}`);
  if (value.protocols.length) parts.push(value.protocols.join('/'));
  if (value.statuses.length) parts.push(value.statuses.map(status => `${status}xx`).join(', '));
  if (libraryLabels[value.library]) parts.push(libraryLabels[value.library]);
  if (value.device !== 'all') parts.push(`device ${value.device}`);
  if (value.application) parts.push(`app ${value.application}`);
  return parts.join(' · ');
}
