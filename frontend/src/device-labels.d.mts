export type DeviceIconName = 'auto'|'android'|'ios'|'mac'|'generic';
export type DeviceLabel = { name:string; color:string; icon:DeviceIconName };
export const deviceLabelsKey: string;
export const deviceIcons: DeviceIconName[];
export function readDeviceLabels(value:string|null): Record<string,DeviceLabel>;
export function trafficDevices(records:{ device?:string; deviceId?:string; devicePlatform?:string|null }[]): { id:string; platform:string }[];
export function stableDeviceOrder<T extends { id:string }>(devices:T[],previousOrder?:string[],records?:{ device?:string; deviceId?:string; startedAt?:number|string|null }[]): { order:string[]; devices:T[] };
export function incomingRecordIds(records:{ id:string }[],seen:Set<string>|null): {incoming:Set<string>; seen:Set<string>};
