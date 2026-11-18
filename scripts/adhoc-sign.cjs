// Harden the packaged executable before either ad-hoc signing here or electron-builder's Developer ID signing.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { FuseVersion, FuseV1Options } = await import('@electron/fuses');
  await context.packager.addElectronFuses(context, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  // Seal Apple Silicon output even if electron-builder later finds no Developer ID identity.
  // A configured Developer ID signature replaces this signature in the signing step.
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
