const { build } = require('./package.json');
const fs = require('node:fs');
const path = require('node:path');

// Build-time configuration only. No user settings, backend runtime or secrets.
module.exports = {
  ...build,
  appId: 'com.patrick.ckdsop.cloud',
  productName: 'CKD SOP Cloud',
  // Electron 44 downloads on demand. Reuse only a complete native distribution;
  // otherwise let electron-builder download its requested platform/version.
  electronDist: ({ platformName, arch, version }) => {
    if (platformName !== process.platform || arch !== process.arch) return null;
    const dist = path.join(__dirname, 'node_modules/electron/dist');
    const binary = platformName === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
      : platformName === 'win32' ? 'electron.exe' : 'electron';
    try {
      const installedVersion = fs.readFileSync(path.join(dist, 'version'), 'utf8').trim().replace(/^v/, '');
      return installedVersion === version && fs.statSync(path.join(dist, binary)).isFile() ? dist : null;
    } catch { return null; }
  },
  directories: { ...build.directories, output: 'release/cloud' },
  extraMetadata: {
    name: 'ckd-sop-desktop-cloud',
    productName: 'CKD SOP Cloud',
    ckdBackendUrl: 'https://ckd-sop.patrick-shenzhen.cn',
  },
  artifactName: 'CKD-SOP-Cloud-${version}-${os}-${arch}.${ext}',
};
