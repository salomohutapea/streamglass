import type {SortColumn} from './TrafficTable';
export const columnIds: string[];
export function readColumns(raw:string|null):SortColumn[];
export const columnWidthsKey:string;
export const MIN_COLUMN:number;
export const MAX_COLUMN:number;
export function readColumnWidths(raw:string|null):Partial<Record<SortColumn,number>>;
export function matchesLibrary(record:{kind?:string;response?:{headers?:unknown};pinned?:boolean;isSSE?:boolean;state?:string;eventCount?:number;events?:unknown[]},library:string):boolean;
export function matchesQuickFilters(record:{url:string;kind?:string;isEncrypted?:boolean;requestContentType?:string;responseContentType?:string;hasJsonEvents?:boolean;request?:{headers?:unknown};status?:number;statusCode?:number;isSSE?:boolean;state?:string;eventCount?:number;events?:unknown[];response?:{headers?:unknown}},protocols:string[],statuses:number[],types?:string[]):boolean;
export function isSSE(record:{kind?:string;isSSE?:boolean;eventCount?:number;events?:unknown[];response?:{headers?:unknown}}):boolean;

export const contentTypes: string[];
export const contentTypeLabels: Record<string,string>;
export function recordContentTypes(record:{isSSE?:boolean;eventCount?:number;events?:{data?:unknown}[];kind?:string;isEncrypted?:boolean;requestContentType?:string;responseContentType?:string;hasJsonEvents?:boolean;request?:{headers?:unknown};response?:{headers?:unknown}}):string[];
