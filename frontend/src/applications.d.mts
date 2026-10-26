export type Application = { id:string; name:string; pid:number; bundleId?:string; icon?:string; kind:'application'|'process' };
export type ApplicationRecord = { application?:Application|null; clientIsLocal?:boolean };
export const unknownApplicationId: string;
export function applicationIcon(value:unknown): string|undefined;
export function recordApplicationId(record:ApplicationRecord): string|null;
export function trafficApplications(records:ApplicationRecord[], icons?:Record<string,string>): { id:string; name:string; kind:string; icon?:string; count:number }[];
