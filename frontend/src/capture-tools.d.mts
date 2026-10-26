export type CaptureComparison = { changes: { path: string; before?: string; after?: string }[]; totalChanges: number; incomplete: boolean; limited?: boolean; warnings: string[] };
export function compareCaptures(left: any, right: any, options: {section: 'request'|'response'|'events';ignoreFields:string[];eventKey:'sequence'|'id';bodyOnly?:boolean;focusPath?:string}): CaptureComparison;
export function redactCapture(record: any, options: {fields:string[]}): any;
export function comparisonText(record: any, options: {section: 'request'|'response'|'events';ignoreFields:string[];eventKey:'sequence'|'id';bodyOnly?:boolean;focusPath?:string}): string;
export function bodyRecord(record: any, section?: 'request'|'response'|'events', focusPath?: string): any;
export function formatJson(text: string): string;
export function pathSegments(path: string): string[];
