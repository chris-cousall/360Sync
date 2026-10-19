// Builds into %TEMP% (the Desktop folder gets file-locked by AV/OneDrive mid-build), then copies the results to dist/.
//   node build.js            -> dist/360Sync (portable folder)
//   node build.js installer  -> dist/360Sync-Setup-<version>.exe as well (installs per user and registers .360sync files)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const installer = process.argv.includes('installer');
const out = path.join(os.tmpdir(), '360sync-dist');
const dist = path.join(__dirname, 'dist');
const dest = path.join(dist, '360Sync');
fs.rmSync(out, { recursive: true, force: true });
execSync(`npx electron-builder --win ${installer ? 'nsis' : 'dir'} --publish never -c.directories.output="${out}"`, { stdio: 'inherit', cwd: __dirname });
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.join(out, 'win-unpacked'), dest, { recursive: true });
console.log(`\nBuilt: ${path.join(dest, '360Sync.exe')}`);
if (installer) {
  const setup = fs.readdirSync(out).find((f) => /^360Sync-Setup-.*\.exe$/.test(f));
  if (!setup) throw new Error(`electron-builder produced no installer in ${out}`);
  fs.copyFileSync(path.join(out, setup), path.join(dist, setup));
  console.log(`Installer: ${path.join(dist, setup)}`);
}
