import {z} from 'zod';

// Settings and Connect a device open in their own windows (like Tools). The main process validates the small
// amount of context a caller may pass; everything else stays in the window's own state.
export const settingsSections = ['proxy', 'tls', 'agent'];
export const setupPlatforms = ['macos', 'ios-simulator', 'ios-device', 'android-emulator', 'android-device'];
const settingsInput = z.object({section: z.enum(settingsSections).optional()}).strict();
const setupInput = z.object({platform: z.enum(setupPlatforms).optional()}).strict();
export const validateSettingsInput = value => settingsInput.parse(value ?? {});
export const validateSetupInput = value => setupInput.parse(value ?? {});
export const validateDeviceFilter = value => z.string().min(1).max(256).parse(value);
