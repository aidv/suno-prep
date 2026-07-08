const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const BUILD_CACHE_DIR = path.join(ROOT_DIR, '.sea-build');
const NODE_VERSION = process.version;
const SEA_BLOB_SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const TARGETS = [
  {
    name: 'windows',
    outputFile: path.join(DIST_DIR, 'suno-prep-win.exe'),
    executablePath: process.execPath,
  },
  {
    name: 'macos',
    outputFile: path.join(DIST_DIR, 'suno-prep-mac'),
    executablePath: path.join(BUILD_CACHE_DIR, `node-${NODE_VERSION}-darwin-x64`, 'bin', 'node'),
  },
];

async function main() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(BUILD_CACHE_DIR, { recursive: true });

  await ensureMacosNodeBinary();

  for (const build of TARGETS) {
    console.log(`Building ${path.basename(build.outputFile)} with Node SEA for ${build.name}`);
    await buildSeaBinary(build);
  }

  console.log('Binary packaging completed successfully.');
}

async function ensureMacosNodeBinary() {
  const macTarget = TARGETS.find((target) => target.name === 'macos');

  if (!macTarget) {
    return;
  }

  if (fs.existsSync(macTarget.executablePath)) {
    return;
  }

  const archiveDirName = `node-${NODE_VERSION}-darwin-x64`;
  const archiveFileName = `${archiveDirName}.tar.gz`;
  const archivePath = path.join(BUILD_CACHE_DIR, archiveFileName);
  const extractRoot = path.join(BUILD_CACHE_DIR, `extract-${Date.now()}-${process.pid}`);
  const archiveUrl = `https://nodejs.org/dist/${NODE_VERSION}/${archiveFileName}`;

  try {
    console.log(`Downloading ${archiveFileName}`);
    await downloadFile(archiveUrl, archivePath);

    console.log(`Extracting ${archiveFileName}`);
    fs.mkdirSync(extractRoot, { recursive: true });
    const extractedDir = path.join(extractRoot, archiveDirName);
    const extractedBinary = path.join(extractedDir, 'bin', 'node');

    try {
      await runCommand(getTarCommand(), ['-xzf', archivePath, '-C', extractRoot]);
    } catch (error) {
      if (!fs.existsSync(extractedBinary)) {
        throw error;
      }
    }

    if (!fs.existsSync(extractedBinary)) {
      throw new Error(`Could not find macOS Node binary at ${extractedBinary}`);
    }

    fs.rmSync(path.join(BUILD_CACHE_DIR, archiveDirName), { recursive: true, force: true });
    fs.cpSync(extractedDir, path.join(BUILD_CACHE_DIR, archiveDirName), { recursive: true, force: true });
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
  }
}

function getTarCommand() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }

  return 'tar';
}

async function buildSeaBinary({ name, outputFile, executablePath }) {
  const seaConfigPath = path.join(BUILD_CACHE_DIR, `sea-config-${name}.json`);
  const seaBlobPath = path.join(BUILD_CACHE_DIR, `sea-prep-${name}.blob`);

  fs.rmSync(outputFile, { force: true });
  fs.rmSync(seaBlobPath, { force: true });
  fs.writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: path.join(ROOT_DIR, 'app.js'),
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2
    )
  );

  try {
    await runNode(['--experimental-sea-config', seaConfigPath]);
    fs.copyFileSync(executablePath, outputFile);

    if (name === 'macos') {
      fs.chmodSync(outputFile, 0o755);
    }

    await injectSeaBlob({
      name,
      outputFile,
      seaBlobPath,
    });
  } finally {
    fs.rmSync(seaConfigPath, { force: true });
    fs.rmSync(seaBlobPath, { force: true });
  }
}

function injectSeaBlob({ name, outputFile, seaBlobPath }) {
  const args = [
    outputFile,
    'NODE_SEA_BLOB',
    seaBlobPath,
    '--sentinel-fuse',
    SEA_BLOB_SENTINEL,
  ];

  if (name === 'macos') {
    args.push('--macho-segment-name', 'NODE_SEA');
  }

  return runPostject(args);
}

function runPostject(args) {
  const command = path.join(
    ROOT_DIR,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'postject.cmd' : 'postject'
  );

  if (process.platform === 'win32') {
    return runCommand(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...args]);
  }

  return runCommand(command, args);
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Packaging failed with exit code ${code}.`));
    });
  });
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Node binary archive: ${response.status} ${response.statusText}`.trim());
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath));
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} failed with exit code ${code}.`));
    });
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});