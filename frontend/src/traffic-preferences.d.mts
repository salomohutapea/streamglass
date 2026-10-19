import type {SortColumn} from './TrafficTable';
export const columnIds: string[];
export function readColumns(raw:string|null):SortColumn[];
export function matchesLibrary(record:{kind?:string;response?:{headers?:unknown};pinned?:boolean;isSSE?:boolean;state?:string;eventCount?:number;events?:unknown[]},library:string):boolean;
export function matchesQuickFilters(record:{url:string;kind?:string;status?:number;statusCode?:number;isSSE?:boolean;state?:string;eventCount?:number;events?:unknown[];response?:{headers?:unknown}},protocols:string[],statuses:number[]):boolean;
export function isSSE(record:{kind?:string;isSSE?:boolean;eventCount?:number;events?:unknown[];response?:{headers?:unknown}}):boolean;
