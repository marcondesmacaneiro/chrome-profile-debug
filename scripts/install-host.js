#!/usr/bin/env node
// Registers the native messaging host with every Chromium-family browser found
// on this machine. Writes files OUTSIDE the repository: the generated manifest
// carries an absolute path and your local extension IDs.

import { writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HOST_NAME = 'io.github.marcondesmacaneiro.chrome_profile_debug';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MANIFEST_DIRS = {
  darwin: [
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Google/Chrome Canary',
    'Library/Application Support/Chromium',
    'Library/Application Support/BraveSoftware/Brave-Browser',
    'Library/Application Support/Microsoft Edge',
  ],
  linux: [
    '.config/google-chrome',
    '.config/chromium',
    '.config/BraveSoftware/Brave-Browser',
    '.config/microsoft-edge',
  ],
};

function parseArgs(argv) {
  const ids = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--extension-id' && argv[i + 1]) ids.push(argv[++i]);
    else if (argv[i].startsWith('--extension-id=')) ids.push(argv[i].split('=')[1]);
  }
  return ids;
}

function nodeBinary() {
  // Chrome launched from the GUI has a minimal PATH, so the wrapper must name
  // the interpreter absolutely rather than relying on `env node`.
  try {
    return execSync('command -v node', { encoding: 'utf8', shell: '/bin/sh' }).trim() || process.execPath;
  } catch {
    return process.execPath;
  }
}

function writeWrapper() {
  const wrapper = join(REPO, 'host', 'run-host.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${nodeBinary()}" "${join(REPO, 'host', 'host.js')}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function main() {
  const ids = parseArgs(process.argv.slice(2));
  if (ids.length === 0) {
    console.error('Usage: npm run install-host -- --extension-id <ID> [--extension-id <ID2> ...]');
    console.error('\nFind the ID at chrome://extensions after "Load unpacked" (Developer mode on).');
    process.exit(1);
  }

  const bad = ids.filter((id) => !/^[a-p]{32}$/.test(id));
  if (bad.length) {
    console.error(`Not valid Chrome extension IDs (expected 32 letters a-p): ${bad.join(', ')}`);
    process.exit(1);
  }

  const dirs = MANIFEST_DIRS[platform()];
  if (!dirs) {
    console.error(`Unsupported platform: ${platform()}. On Windows the host is registered in the registry; see docs/PROTOCOL.md.`);
    process.exit(1);
  }

  const wrapper = writeWrapper();
  const manifest = {
    name: HOST_NAME,
    description: 'chrome-profile-debug native messaging host',
    path: wrapper,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };

  let written = 0;
  for (const rel of dirs) {
    const base = join(homedir(), rel);
    if (!existsSync(base)) continue;
    const dir = join(base, 'NativeMessagingHosts');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${HOST_NAME}.json`);
    writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`  wrote ${target}`);
    written++;
  }

  if (written === 0) {
    console.error('No Chromium-family browser directory found. Is Chrome installed for this user?');
    process.exit(1);
  }

  console.log(`\nRegistered "${HOST_NAME}" for ${ids.length} extension ID(s) in ${written} browser(s).`);
  console.log('Now open the extension popup in each profile and give it a name.');
  console.log('A profile with no name never connects.');
}

main();
