const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');
const SPEED_VALUES = [0.9, 1.0, 1.1];
const PITCH_VALUES = [-3, -2, -1, 0, 1, 2, 3];
const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(4, getAvailableParallelism() - 1));
const CONCURRENCY = getConcurrency();

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

if (!fs.existsSync(INPUT_DIR)) {
  console.error(`Input directory not found: ${INPUT_DIR}`);
  process.exit(1);
}

const inputFiles = fs
  .readdirSync(INPUT_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

if (inputFiles.length === 0) {
  console.error(`No input files found in: ${INPUT_DIR}`);
  process.exit(1);
}

async function main() {
  const jobs = [];

  for (const inputFileName of inputFiles) {
    const inputFile = path.join(INPUT_DIR, inputFileName);
    const outputSubdir = path.join(OUTPUT_DIR, inputFileName);

    fs.mkdirSync(outputSubdir, { recursive: true });

    for (const speed of SPEED_VALUES) {
      const speedSubdir = path.join(outputSubdir, buildSpeedFolderName(speed));

      fs.mkdirSync(speedSubdir, { recursive: true });

      for (const semitones of PITCH_VALUES) {
        const outputFile = path.join(speedSubdir, buildOutputFileName(inputFileName, semitones));

        jobs.push({ inputFile, inputFileName, outputFile, speed, semitones });
      }
    }
  }

  console.log(`Found ${inputFiles.length} input files.`);
  console.log(`Generating ${jobs.length} output files in ${OUTPUT_DIR}`);
  console.log(`Running up to ${CONCURRENCY} FFmpeg jobs in parallel.`);

  await runJobsInParallel(jobs, CONCURRENCY);

  console.log('All variations generated successfully.');
}

function getAvailableParallelism() {
  if (typeof os.availableParallelism === 'function') {
    return os.availableParallelism();
  }

  return os.cpus().length;
}

function getConcurrency() {
  const parsed = Number.parseInt(process.env.FFMPEG_CONCURRENCY ?? '', 10);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return DEFAULT_CONCURRENCY;
}

async function runJobsInParallel(jobs, concurrency) {
  let nextIndex = 0;
  let completed = 0;

  async function runWorker(workerId) {
    while (true) {
      const jobIndex = nextIndex;
      if (jobIndex >= jobs.length) {
        return;
      }

      nextIndex += 1;

      const job = jobs[jobIndex];
      console.log(
        `[start ${jobIndex + 1}/${jobs.length}] worker ${workerId} | ${job.inputFileName} | speed ${job.speed.toFixed(1)}x | pitch ${formatSemitoneLabel(job.semitones)}`
      );

      await processVariation(job);

      completed += 1;
      console.log(
        `[done  ${completed}/${jobs.length}] worker ${workerId} | ${path.basename(job.outputFile)}`
      );
    }
  }

  const workerCount = Math.min(concurrency, jobs.length);
  const workers = Array.from({ length: workerCount }, (_, index) => runWorker(index + 1));

  await Promise.all(workers);
}

function buildSpeedFolderName(speed) {
  return `speed-${speed.toFixed(1)}x`;
}

function buildOutputFileName(inputFileName, semitones) {
  const parsed = path.parse(inputFileName);
  const pitchLabel = semitones >= 0 ? `plus${semitones}` : `minus${Math.abs(semitones)}`;

  return `pitch-${pitchLabel}${parsed.ext}`;
}

function formatSemitoneLabel(semitones) {
  return `${semitones >= 0 ? '+' : ''}${semitones} st`;
}

function processVariation({ inputFile, outputFile, speed, semitones }) {
  const pitchRatio = Math.pow(2, semitones / 12);

  return runRubberband(inputFile, outputFile, speed, pitchRatio).catch((err) => {
    if (!err.message.includes('rubberband')) {
      throw err;
    }

    console.log('rubberband filter unavailable, using fallback method.');
    return runFallback(inputFile, outputFile, speed, pitchRatio);
  });
}

function runRubberband(inputFile, outputFile, speed, pitchRatio) {
  return runFfmpeg({
    inputFile,
    outputFile,
    filters: [`rubberband=tempo=${speed.toFixed(6)}:pitch=${pitchRatio.toFixed(6)}`],
  });
}

function runFallback(inputFile, outputFile, speed, pitchRatio) {
  const shiftedRate = Math.round(DEFAULT_SAMPLE_RATE * pitchRatio);
  const atempoValue = speed / pitchRatio;

  return runFfmpeg({
    inputFile,
    outputFile,
    filters: [
      `asetrate=${shiftedRate}`,
      `aresample=${DEFAULT_SAMPLE_RATE}`,
      `atempo=${atempoValue.toFixed(6)}`,
    ],
  });
}

function runFfmpeg({ inputFile, outputFile, filters }) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-y', '-i', inputFile, '-af', filters.join(','), outputFile];
    const ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    ffmpegProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpegProcess.on('error', (err) => {
      reject(err);
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const errorOutput = stderr.trim().split(/\r?\n/).slice(-10).join('\n');
      reject(new Error(errorOutput || `ffmpeg exited with code ${code}`));
    });
  });
}

main().catch((err) => {
  console.error('Processing failed:', err.message);
  process.exit(1);
});
