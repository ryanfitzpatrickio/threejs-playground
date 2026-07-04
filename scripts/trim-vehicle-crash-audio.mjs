/**
 * Trim leading silence/dead air from vehicle crash one-shots so impacts play
 * immediately in-game. Finds the loudest transient in each clip and exports a
 * tight slice around it (attack + tail).
 *
 * Requires ffmpeg + ffprobe on PATH.
 *
 *   node scripts/trim-vehicle-crash-audio.mjs
 *   node scripts/trim-vehicle-crash-audio.mjs path/to/crash-01.mp3 ...
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = path.join(ROOT, 'public/audio/vehicles');
const DEFAULT_GLOB_PREFIX = 'crash-';

const SAMPLE_RATE = 48_000;
const WINDOW = 256;
const HOP = 64;
const ATTACK_PAD_SEC = 0.008;
const TAIL_PAD_SEC = 0.12;
const ONSET_FRACTION = 0.12;
const TAIL_FRACTION = 0.08;
const MIN_DURATION_SEC = 0.18;
const MAX_DURATION_SEC = 1.4;

function requireFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('ffmpeg and ffprobe are required on PATH');
  }
}

function decodeMono(inputPath) {
  const raw = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'],
    { encoding: 'buffer' },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function measureRmsEnvelope(samples) {
  const envelope = [];
  for (let index = 0; index < samples.length - WINDOW; index += HOP) {
    let sum = 0;
    for (let offset = 0; offset < WINDOW; offset += 1) {
      const sample = samples[index + offset];
      sum += sample * sample;
    }
    envelope.push({ t: index / SAMPLE_RATE, v: Math.sqrt(sum / WINDOW) });
  }
  return envelope;
}

export function findCrashTrimRange(samples, {
  attackPadSec = ATTACK_PAD_SEC,
  tailPadSec = TAIL_PAD_SEC,
  onsetFraction = ONSET_FRACTION,
  tailFraction = TAIL_FRACTION,
  minDurationSec = MIN_DURATION_SEC,
  maxDurationSec = MAX_DURATION_SEC,
} = {}) {
  const totalDuration = samples.length / SAMPLE_RATE;
  const envelope = measureRmsEnvelope(samples);
  if (!envelope.length) {
    return { start: 0, end: totalDuration, peak: 0, duration: totalDuration };
  }

  let peakValue = 0;
  let peakIndex = 0;
  for (let index = 0; index < envelope.length; index += 1) {
    if (envelope[index].v > peakValue) {
      peakValue = envelope[index].v;
      peakIndex = index;
    }
  }

  const onsetThreshold = peakValue * onsetFraction;
  let startIndex = peakIndex;
  for (let index = peakIndex; index >= 0; index -= 1) {
    if (envelope[index].v < onsetThreshold) {
      startIndex = Math.min(envelope.length - 1, index + 1);
      break;
    }
    if (index === 0) startIndex = 0;
  }

  const tailThreshold = peakValue * tailFraction;
  let endIndex = peakIndex;
  for (let index = peakIndex; index < envelope.length; index += 1) {
    if (envelope[index].v < tailThreshold) {
      endIndex = index;
      break;
    }
    endIndex = index;
  }

  let start = Math.max(0, envelope[startIndex].t - attackPadSec);
  let end = Math.min(totalDuration, envelope[endIndex].t + tailPadSec);
  let duration = end - start;

  if (duration < minDurationSec) {
    const center = envelope[peakIndex].t;
    start = Math.max(0, center - minDurationSec * 0.18);
    end = Math.min(totalDuration, start + minDurationSec);
    duration = end - start;
  }

  if (duration > maxDurationSec) {
    const center = envelope[peakIndex].t;
    start = Math.max(0, center - maxDurationSec * 0.12);
    end = Math.min(totalDuration, start + maxDurationSec);
    duration = end - start;
  }

  return {
    start,
    end,
    peak: envelope[peakIndex].t,
    duration,
    peakValue,
  };
}

function exportTrimmed({ inputPath, outputPath, start, end }) {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-af', `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`,
      '-c:a', 'libmp3lame', '-q:a', '4',
      outputPath,
    ],
    { stdio: 'inherit' },
  );
}

function probeDuration(filePath) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { encoding: 'utf8' },
  ).trim();
  return Number(out);
}

function resolveInputs(argv) {
  if (argv.length > 0) return argv.map((entry) => path.resolve(entry));
  return readdirSync(DEFAULT_DIR)
    .filter((name) => name.startsWith(DEFAULT_GLOB_PREFIX) && name.endsWith('.mp3'))
    .sort()
    .map((name) => path.join(DEFAULT_DIR, name));
}

function trimFile(inputPath, { dryRun = false } = {}) {
  const beforeDuration = probeDuration(inputPath);
  const samples = decodeMono(inputPath);
  const range = findCrashTrimRange(samples);

  const report = {
    file: inputPath,
    beforeDuration,
    afterDuration: range.duration,
    trimStart: range.start,
    trimEnd: range.end,
    peak: range.peak,
  };

  if (dryRun) return report;

  const tempDir = mkdtempSync(path.join(tmpdir(), 'dreamfall-crash-trim-'));
  const tempOut = path.join(tempDir, path.basename(inputPath));
  const backup = `${inputPath}.orig`;

  try {
    exportTrimmed({ inputPath, outputPath: tempOut, start: range.start, end: range.end });
    const afterDuration = probeDuration(tempOut);
    assert.ok(afterDuration > 0.05, `trim produced empty audio for ${inputPath}`);

    if (!dryRun) {
      try {
        copyFileSync(inputPath, backup);
      } catch {
        // No backup if already exists is fine.
      }
      renameSync(tempOut, inputPath);
    }

    report.afterDuration = afterDuration;
    return report;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  requireFfmpeg();
  const dryRun = process.argv.includes('--dry-run');
  const inputs = resolveInputs(process.argv.slice(2).filter((arg) => !arg.startsWith('--')));

  if (!inputs.length) {
    console.error('No crash mp3 files found to trim.');
    process.exit(1);
  }

  console.log(`${dryRun ? 'Analyzing' : 'Trimming'} ${inputs.length} crash clip(s)...\n`);
  for (const inputPath of inputs) {
    const report = trimFile(inputPath, { dryRun });
    console.log(
      `${path.basename(report.file)}: ${report.beforeDuration.toFixed(2)}s -> ${report.afterDuration.toFixed(2)}s ` +
      `(cut ${report.trimStart.toFixed(3)}s..${report.trimEnd.toFixed(3)}s, peak @ ${report.peak.toFixed(3)}s)`,
    );
  }
  console.log(dryRun ? '\nDry run only — re-run without --dry-run to write files.' : '\nDone.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
