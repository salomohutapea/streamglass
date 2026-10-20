export type QrCode = { version: number; size: number; modules: boolean[][]; mask: number; score: number };
export function encodeQr(text: string): QrCode;
export function maxBytes(version: number): number;
export function reedSolomon(data: number[], degree: number): number[];
export function functionMask(version: number): boolean[][];
export const maskFunction: Array<(row: number, col: number) => boolean>;
