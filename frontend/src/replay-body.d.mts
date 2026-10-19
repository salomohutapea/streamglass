export function encodeReplayText(text:string):string;
export function decodeReplayText(base64:string):string;
export function replayHeaders(headers:unknown,textChanged:boolean):[string,string][];
