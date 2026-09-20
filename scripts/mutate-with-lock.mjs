#!/usr/bin/env node

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const LOCK_FILENAME = '.stryker.lock';
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

let lockPath;
let lockFd = null;
let lockReleased = false;
let childProcess = null;
let receivedSignal = null;

function findRepositoryRoot() {
  const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();

  if (!topLevel || !commonDir) {
    throw new Error('could not determine the repository root');
  }

  const commonGitDir = resolve(topLevel, commonDir);
  try {
    return dirname(realpathSync(commonGitDir));
  } catch {
    return dirname(commonGitDir);
  }
}

function readExistingLock() {
  try {
    const metadata = JSON.parse(readFileSync(lockPath, 'utf8'));
    const pid = Number(metadata.pid);
    const rawTimestamp = metadata.timestamp ?? metadata.startedAt ?? metadata.started_at;
    const startedAt = typeof rawTimestamp === 'number'
      ? (rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1_000 : rawTimestamp)
      : Date.parse(String(rawTimestamp));

    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt)) {
      throw new Error('missing pid or timestamp');
    }

    const heldForMs = Math.max(0, Date.now() - startedAt);
    process.stderr.write(
      `Unable to acquire ${LOCK_FILENAME}: held by pid ${pid} for ${heldForMs}ms `
      + `(since ${String(rawTimestamp)}).\n`,
    );
  } catch {
    process.stderr.write(
      `Unable to acquire ${LOCK_FILENAME}: an existing lock has unreadable `
      + 'pid/timestamp metadata.\n',
    );
  }
}

function acquireLock() {
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({
    pid: process.pid,
    timestamp,
    startedAt: timestamp,
    started_at: timestamp,
  }) + '\n';
  let created = false;

  try {
    lockFd = openSync(lockPath, 'wx', 0o644);
    created = true;
    writeFileSync(lockFd, payload, 'utf8');
    fsyncSync(lockFd);
    return true;
  } catch (error) {
    if (created) {
      try { closeSync(lockFd); } catch {}
      lockFd = null;
      try { unlinkSync(lockPath); } catch {}
    }

    if (error?.code === 'EEXIST') {
      readExistingLock();
      return false;
    }
    throw error;
  }
}

function releaseLock() {
  if (lockReleased || !lockPath) return;
  lockReleased = true;

  if (lockFd !== null) {
    try { closeSync(lockFd); } catch {}
    lockFd = null;
  }

  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      process.stderr.write(`Unable to remove ${LOCK_FILENAME}: ${error.message}\n`);
    }
  }
}

function handleSignal(signal) {
  if (receivedSignal) return;
  receivedSignal = signal;
  if (childProcess && childProcess.exitCode === null) {
    try { childProcess.kill(signal); } catch {}
  }
}

function installSignalHandlers() {
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

function runStryker(args) {
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      childProcess = null;
      resolveResult({ code, signal });
    };

    try {
      const command = process.platform === 'win32' ? 'stryker.cmd' : 'stryker';
      childProcess = spawn(command, ['run', ...args], { stdio: 'inherit' });
      childProcess.once('error', (error) => {
        process.stderr.write(`Unable to start Stryker: ${error.message}\n`);
        finish(1, null);
      });
      childProcess.once('close', finish);
    } catch (error) {
      process.stderr.write(`Unable to start Stryker: ${error.message}\n`);
      finish(1, null);
    }
  });
}

function exitCodeForSignal(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

async function main() {
  const repositoryRoot = findRepositoryRoot();
  lockPath = join(repositoryRoot, LOCK_FILENAME);

  if (!acquireLock()) return 1;

  installSignalHandlers();
  try {
    const result = await runStryker(process.argv.slice(2));
    if (receivedSignal) return exitCodeForSignal(receivedSignal);
    if (result.code !== null) return result.code;
    return exitCodeForSignal(result.signal);
  } finally {
    releaseLock();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  releaseLock();
  process.stderr.write(`mutate-with-lock failed: ${error.message}\n`);
  process.exitCode = 1;
}
