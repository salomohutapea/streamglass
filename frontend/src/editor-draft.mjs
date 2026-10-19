import { prepareJson } from './json-viewer.mjs';

export function editableBody(value) {
  const original = String(value ?? '');
  const formatted = prepareJson(original);
  return formatted.isJson ? formatted.text : original;
}

export function resolvedBody(draft, original) {
  return draft === editableBody(original) ? original : draft;
}
