const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_SEMITONE_OFFSETS = [-24, -26, -28, -30];
const RATE_PRECISION_DIGITS = 6;
const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'output');
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

  const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  fs.mkdirSync(outputDir, { recursive: true });

  const audioMetadata = await probeAudioMetadata(inputFile);
  const outputTargets = options.semitones.map((semitones) => ({
    semitones,
    outputFile: path.join(outputDir, buildOutputFileName(inputFile, semitones)),
  }));

  console.log(`Input: ${inputFile}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Sample rate: ${audioMetadata.sampleRate} Hz`);

  for (const target of outputTargets) {
    console.log(
      `Creating ${formatSemitoneLabel(target.semitones)} version at ${target.outputFile}`
    );
  }

  await runFfmpegBatch({
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

async function probeAudioMetadata(inputFile) {
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

  const { stdout } = await runCommand('ffprobe', ffprobeArgs);
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

function runFfmpeg({ inputFile, outputFile, sampleRate, pitchRatio, expectedDurationSeconds }) {
  return runCommand('ffmpeg', [
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

function runFfmpegBatch({ inputFile, outputTargets, sampleRate, expectedDurationSeconds }) {
  if (outputTargets.length === 1) {
    const [target] = outputTargets;

    return runFfmpeg({
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

  return runCommand('ffmpeg', args, {
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