export function matchesListSearch(query:string,values:unknown[]):boolean;
export function matchesRuleSearch(rule:{name?:string;pattern:string;method?:string;stages?:string[];folderId?:string;enabled:boolean;script?:string},query:string,folders?:{id:string;name:string}[]):boolean;
