const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const WORKING_DIRECTORY = process.cwd();
const DEFAULT_SEMITONE_OFFSETS = [-24, -26, -28, -30];
const RATE_PRECISION_DIGITS = 6;
const DEFAULT_OUTPUT_DIR = path.join(WORKING_DIRECTORY, 'output');
const LOCAL_FFMPEG_ROOT = path.join(WORKING_DIRECTORY, 'libs');
const WINDOWS_FFMPEG_DOWNLOAD_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const MACOS_FFMPEG_DOWNLOAD_URL = 'https://evermeet.cx/ffmpeg/getrelease/zip';
const MACOS_FFPROBE_DOWNLOAD_URL = 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip';
const LINUX_FFMPEG_DOWNLOAD_URLS = {
  x64: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
  arm64: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz',
  ia32: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-i686-static.tar.xz',
  arm: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-armhf-static.tar.xz',
};
const PROGRESS_STEP_PERCENT = 5;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  validateOptions(options);

  const inputFile = path.resolve(options.inputFile);

  if (!fs.existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const ffmpegTools = await resolveFfmpegTools();
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  fs.mkdirSync(outputDir, { recursive: true });

  const audioMetadata = await probeAudioMetadata(inputFile, ffmpegTools.ffprobePath);
  const outputTargets = options.semitones.map((semitones) => ({
    semitones,
    outputFile: path.join(outputDir, buildOutputFileName(inputFile, semitones)),
  }));

  console.log(`Input: ${inputFile}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`FFmpeg: ${ffmpegTools.ffmpegPath}`);
  console.log(`Sample rate: ${audioMetadata.sampleRate} Hz`);

  for (const target of outputTargets) {
    console.log(
      `Creating ${formatSemitoneLabel(target.semitones)} version at ${target.outputFile}`
    );
  }

  await runFfmpegBatch({
    ffmpegPath: ffmpegTools.ffmpegPath,
    inputFile,
    outputTargets,
    sampleRate: audioMetadata.sampleRate,
    expectedDurationSeconds: getLongestOutputDurationSeconds(
      audioMetadata.durationSeconds,
      outputTargets
    ),
  });

  console.log('Semitone resampling completed successfully.');
}

async function resolveFfmpegTools() {
  const workingDirectoryTools = getWorkingDirectoryFfmpegTools();

  if (await areFfmpegToolsAvailable(workingDirectoryTools)) {
    return workingDirectoryTools;
  }

  const localTools = getLocalFfmpegTools();

  if (await areFfmpegToolsAvailable(localTools)) {
    return localTools;
  }

  console.log(`FFmpeg not found in the working directory. Installing a local copy to ${LOCAL_FFMPEG_ROOT}`);
  await installLocalFfmpeg();

  if (!(await areFfmpegToolsAvailable(localTools))) {
    throw new Error('Local FFmpeg install completed, but the binaries could not be started.');
  }

  return localTools;
}

function getWorkingDirectoryFfmpegTools() {
  const extension = process.platform === 'win32' ? '.exe' : '';

  return {
    ffmpegPath: path.join(WORKING_DIRECTORY, `ffmpeg${extension}`),
    ffprobePath: path.join(WORKING_DIRECTORY, `ffprobe${extension}`),
  };
}

function getLocalFfmpegTools() {
  const extension = process.platform === 'win32' ? '.exe' : '';

  return {
    ffmpegPath: path.join(LOCAL_FFMPEG_ROOT, `ffmpeg${extension}`),
    ffprobePath: path.join(LOCAL_FFMPEG_ROOT, `ffprobe${extension}`),
  };
}

async function areFfmpegToolsAvailable({ ffmpegPath, ffprobePath }) {
  const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
    isCommandAvailable(ffmpegPath, ['-version']),
    isCommandAvailable(ffprobePath, ['-version']),
  ]);

  return ffmpegAvailable && ffprobeAvailable;
}

async function isCommandAvailable(command, args) {
  try {
    await runCommand(command, args);
    return true;
  } catch {
    return false;
  }
}

async function installLocalFfmpeg() {
  switch (process.platform) {
    case 'win32':
      await installLocalFfmpegWindows();
      return;
    case 'darwin':
      await installLocalFfmpegMacos();
      return;
    case 'linux':
      await installLocalFfmpegLinux();
      return;
    default:
      throw new Error(`Automatic local FFmpeg install is not supported on platform: ${process.platform}`);
  }
}

async function installLocalFfmpegWindows() {
  fs.mkdirSync(LOCAL_FFMPEG_ROOT, { recursive: true });

  const archivePath = path.join(LOCAL_FFMPEG_ROOT, 'ffmpeg-release-essentials.zip');
  const extractDir = path.join(LOCAL_FFMPEG_ROOT, `extract-${Date.now()}-${process.pid}`);

  try {
    console.log('Downloading FFmpeg...');
    await downloadFile(WINDOWS_FFMPEG_DOWNLOAD_URL, archivePath);

    console.log('Extracting FFmpeg...');
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZipWindows(archivePath, extractDir);

    const extractedBinDir = findDirectoryContainingFiles(extractDir, ['ffmpeg.exe', 'ffprobe.exe']);

    if (!extractedBinDir) {
      throw new Error('Could not locate ffmpeg.exe and ffprobe.exe in the downloaded archive.');
    }

    const localTools = getLocalFfmpegTools();
    fs.rmSync(localTools.ffmpegPath, { force: true });
    fs.rmSync(localTools.ffprobePath, { force: true });
    fs.copyFileSync(path.join(extractedBinDir, 'ffmpeg.exe'), localTools.ffmpegPath);
    fs.copyFileSync(path.join(extractedBinDir, 'ffprobe.exe'), localTools.ffprobePath);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
  }
}

async function installLocalFfmpegMacos() {
  fs.mkdirSync(LOCAL_FFMPEG_ROOT, { recursive: true });

  const downloads = [
    { url: MACOS_FFMPEG_DOWNLOAD_URL, archiveName: 'ffmpeg-macos.zip', binaryName: 'ffmpeg' },
    { url: MACOS_FFPROBE_DOWNLOAD_URL, archiveName: 'ffprobe-macos.zip', binaryName: 'ffprobe' },
  ];

  for (const download of downloads) {
    await installSingleBinaryFromZip(download);
  }
}

async function installLocalFfmpegLinux() {
  const archiveUrl = LINUX_FFMPEG_DOWNLOAD_URLS[process.arch];

  if (!archiveUrl) {
    throw new Error(`Automatic local FFmpeg install is not supported for Linux architecture: ${process.arch}`);
  }

  fs.mkdirSync(LOCAL_FFMPEG_ROOT, { recursive: true });

  const archivePath = path.join(LOCAL_FFMPEG_ROOT, `ffmpeg-linux-${process.arch}.tar.xz`);
  const extractDir = path.join(LOCAL_FFMPEG_ROOT, `extract-${Date.now()}-${process.pid}`);

  try {
    console.log('Downloading FFmpeg...');
    await downloadFile(archiveUrl, archivePath);

    console.log('Extracting FFmpeg...');
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarXzArchive(archivePath, extractDir);

    const extractedBinDir = findDirectoryContainingFiles(extractDir, ['ffmpeg', 'ffprobe']);

    if (!extractedBinDir) {
      throw new Error('Could not locate ffmpeg and ffprobe in the downloaded archive.');
    }

    const localTools = getLocalFfmpegTools();
    copyBinary(path.join(extractedBinDir, 'ffmpeg'), localTools.ffmpegPath);
    copyBinary(path.join(extractedBinDir, 'ffprobe'), localTools.ffprobePath);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
  }
}

async function installSingleBinaryFromZip({ url, archiveName, binaryName }) {
  const archivePath = path.join(LOCAL_FFMPEG_ROOT, archiveName);
  const extractDir = path.join(LOCAL_FFMPEG_ROOT, `extract-${binaryName}-${Date.now()}-${process.pid}`);

  try {
    console.log(`Downloading ${binaryName}...`);
    await downloadFile(url, archivePath);

    console.log(`Extracting ${binaryName}...`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZipArchive(archivePath, extractDir);

    const binaryPath = findFileInDirectory(extractDir, binaryName);

    if (!binaryPath) {
      throw new Error(`Could not locate ${binaryName} in the downloaded archive.`);
    }

    copyBinary(binaryPath, path.join(LOCAL_FFMPEG_ROOT, binaryName));
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
  }
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download FFmpeg archive: ${response.status} ${response.statusText}`.trim());
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath));
}

function extractZipWindows(archivePath, destinationDir) {
  const powershellPath = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

  return runCommand(powershellPath, [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${escapePowerShellString(archivePath)}' -DestinationPath '${escapePowerShellString(destinationDir)}' -Force`,
  ]);
}

function extractZipArchive(archivePath, destinationDir) {
  if (process.platform === 'win32') {
    return extractZipWindows(archivePath, destinationDir);
  }

  return runCommand('unzip', ['-o', archivePath, '-d', destinationDir]);
}

function extractTarXzArchive(archivePath, destinationDir) {
  return runCommand('tar', ['-xJf', archivePath, '-C', destinationDir]);
}

function escapePowerShellString(value) {
  return value.replace(/'/g, "''");
}

function copyBinary(sourcePath, destinationPath) {
  fs.rmSync(destinationPath, { force: true });
  fs.copyFileSync(sourcePath, destinationPath);

  if (process.platform !== 'win32') {
    fs.chmodSync(destinationPath, 0o755);
  }
}

function findFileInDirectory(rootDir, fileName) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);

    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return entryPath;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const nestedMatch = findFileInDirectory(entryPath, fileName);

    if (nestedMatch) {
      return nestedMatch;
    }
  }

  return null;
}

function findDirectoryContainingFiles(rootDir, requiredFiles) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const entryNames = new Set(entries.map((entry) => entry.name.toLowerCase()));

  if (requiredFiles.every((fileName) => entryNames.has(fileName.toLowerCase()))) {
    return rootDir;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nestedMatch = findDirectoryContainingFiles(path.join(rootDir, entry.name), requiredFiles);

    if (nestedMatch) {
      return nestedMatch;
    }
  }

  return null;
}

function parseArgs(args) {
  const options = {
    inputFile: null,
    outputDir: null,
    semitones: DEFAULT_SEMITONE_OFFSETS,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }

    if (arg === '-o' || arg === '--output-dir') {
      options.outputDir = args[++index];

      if (!options.outputDir) {
        console.error(`Missing value for ${arg}.`);
        process.exit(1);
      }

      continue;
    }

    if (arg === '-s' || arg === '--semitones') {
      options.semitones = [parseSemitoneArg(args[++index], arg)];
      continue;
    }

    if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }

    if (!options.inputFile) {
      options.inputFile = arg;
      continue;
    }

    console.error(`Unexpected argument: ${arg}`);
    printHelp();
    process.exit(1);
  }

  return options;
}

function validateOptions(options) {
  if (!options.inputFile) {
    console.error('Missing input file.');
    printHelp();
    process.exit(1);
  }

  if (!Array.isArray(options.semitones) || options.semitones.length === 0) {
    console.error('At least one semitone value is required.');
    process.exit(1);
  }
}

function parseSemitoneArg(value, optionName) {
  const semitones = Number.parseFloat(value);

  if (!Number.isFinite(semitones)) {
    console.error(`Invalid value for ${optionName}: ${value}`);
    process.exit(1);
  }

  return semitones;
}

function printHelp() {
  console.log(`Usage: node app.js <input-file> [--output-dir <directory>] [--semitones <value>]

Creates resampled versions of the input audio.
By default it writes four downsampled versions:
- down 24 semitones
- down 26 semitones
- down 28 semitones
- down 30 semitones

Arguments:
  <input-file>                 Source audio file

Options:
  -o, --output-dir <directory> Directory for the generated files. Defaults to the repo output directory.
  -s, --semitones <value>      Optional semitone shift to generate a single specific version.
  -h, --help                   Show this help message

The app only uses ffmpeg/ffprobe from the current working directory: either ./ffmpeg(.exe) and ./ffprobe(.exe), or ./libs/. If they are missing, the app downloads an OS-appropriate local copy into ./libs automatically.

Example:
  node app.js input/song.mp3 --output-dir output
  node app.js input/song.mp3 --output-dir output --semitones 7
`);
}

function buildOutputFileName(inputFile, semitones) {
  const parsed = path.parse(inputFile);
  return `${parsed.name}_${buildSemitoneLabel(semitones)}${parsed.ext || '.wav'}`;
}

function buildSemitoneLabel(semitones) {
  if (semitones === 0) {
    return '0';
  }

  const magnitude = Number.isInteger(semitones)
    ? Math.abs(semitones)
    : Math.abs(semitones).toString().replace('.', '_');

  return `${semitones > 0 ? 'up' : 'down'}-${magnitude}`;
}

function formatSemitoneLabel(semitones) {
  return `${semitones > 0 ? '+' : ''}${semitones} st`;
}

async function probeAudioMetadata(inputFile, ffprobePath) {
  const ffprobeArgs = [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=sample_rate:format=duration',
    '-of',
    'json',
    inputFile,
  ];

  const { stdout } = await runCommand(ffprobePath, ffprobeArgs);
  const payload = JSON.parse(stdout);
  const stream = payload.streams?.[0];
  const sampleRate = Number.parseInt(stream?.sample_rate, 10);
  const durationSeconds = Number.parseFloat(payload.format?.duration);

  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('Unable to determine input sample rate.');
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Unable to determine input duration.');
  }

  return { sampleRate, durationSeconds };
}

function runFfmpeg({ ffmpegPath, inputFile, outputFile, sampleRate, pitchRatio, expectedDurationSeconds }) {
  return runCommand(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1',
    '-y',
    '-i',
    inputFile,
    '-af',
    `asetrate=${formatRate(sampleRate * pitchRatio)},aresample=${sampleRate}`,
    outputFile,
  ], {
    onProgress: createProgressReporter(expectedDurationSeconds),
  });
}

function runFfmpegBatch({ ffmpegPath, inputFile, outputTargets, sampleRate, expectedDurationSeconds }) {
  if (outputTargets.length === 1) {
    const [target] = outputTargets;

    return runFfmpeg({
      ffmpegPath,
      inputFile,
      outputFile: target.outputFile,
      sampleRate,
      pitchRatio: Math.pow(2, target.semitones / 12),
      expectedDurationSeconds,
    });
  }

  const splitLabels = outputTargets.map((_, index) => `[src${index}]`);
  const filterChains = [
    `[0:a]asplit=${outputTargets.length}${splitLabels.join('')}`,
    ...outputTargets.map((target, index) => {
      const pitchRatio = Math.pow(2, target.semitones / 12);
      return `${splitLabels[index]}asetrate=${formatRate(sampleRate * pitchRatio)},aresample=${sampleRate}[out${index}]`;
    }),
  ];
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1',
    '-y',
    '-i',
    inputFile,
    '-filter_complex',
    filterChains.join(';'),
  ];

  for (let index = 0; index < outputTargets.length; index += 1) {
    args.push('-map', `[out${index}]`, outputTargets[index].outputFile);
  }

  return runCommand(ffmpegPath, args, {
    onProgress: createProgressReporter(expectedDurationSeconds),
  });
}

function getLongestOutputDurationSeconds(inputDurationSeconds, outputTargets) {
  return outputTargets.reduce((longestDuration, target) => {
    const pitchRatio = Math.pow(2, target.semitones / 12);
    const outputDuration = inputDurationSeconds / pitchRatio;
    return Math.max(longestDuration, outputDuration);
  }, 0);
}

function createProgressReporter(expectedDurationSeconds) {
  if (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) {
    return null;
  }

  let lastPrintedStep = -1;

  return (progressState) => {
    if (progressState.progress === 'end') {
      if (lastPrintedStep < 100 / PROGRESS_STEP_PERCENT) {
        console.log('Progress: 100%');
      }
      return;
    }

    const outTimeSeconds = parseProgressTimeSeconds(progressState);

    if (!Number.isFinite(outTimeSeconds) || outTimeSeconds < 0) {
      return;
    }

    const percent = Math.max(0, Math.min(100, (outTimeSeconds / expectedDurationSeconds) * 100));
    const step = Math.floor(percent / PROGRESS_STEP_PERCENT);

    if (step <= lastPrintedStep || step <= 0) {
      return;
    }

    lastPrintedStep = step;
    console.log(`Progress: ${Math.min(step * PROGRESS_STEP_PERCENT, 100)}%`);
  };
}

function parseProgressTimeSeconds(progressState) {
  if (progressState.out_time) {
    return parseTimestampSeconds(progressState.out_time);
  }

  const outTimeMicros = Number.parseInt(progressState.out_time_us ?? progressState.out_time_ms ?? '', 10);

  if (Number.isFinite(outTimeMicros)) {
    return outTimeMicros / 1000000;
  }

  return Number.NaN;
}

function parseTimestampSeconds(value) {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());

  if (!match) {
    return Number.NaN;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseFloat(match[3]);

  return hours * 3600 + minutes * 60 + seconds;
}

function formatRate(rate) {
  return rate.toFixed(RATE_PRECISION_DIGITS);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    const progressState = {};

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;

      if (typeof options.onProgress !== 'function') {
        return;
      }

      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        collectProgressLine(line, progressState, options.onProgress);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const message = stderr.trim() || stdout.trim() || `${command} exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

function collectProgressLine(line, progressState, onProgress) {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  const separatorIndex = trimmed.indexOf('=');

  if (separatorIndex === -1) {
    return;
  }

  const key = trimmed.slice(0, separatorIndex);
  const value = trimmed.slice(separatorIndex + 1);

  progressState[key] = value;

  if (key === 'progress') {
    onProgress({ ...progressState });

    for (const stateKey of Object.keys(progressState)) {
      delete progressState[stateKey];
    }
  }
}

main().catch((error) => {
  console.error('Semitone resampling failed:', error.message);
  process.exit(1);
});