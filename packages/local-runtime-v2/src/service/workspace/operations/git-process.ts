import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessByStdio,
  type ExecFileException,
} from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import {
  findWindowsWorkingDirectoryOverflow,
  formatWindowsWorkingDirectoryOverflowMessage,
} from '@mavis/shared';

import { WorkspaceGitCommandError } from '../contracts.js';

const execFile = promisify(execFileCallback);
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  signal?: AbortSignal;
}

export interface GitStreamOptions {
  signal?: AbortSignal;
  onStdout: (chunk: string) => void;
  maxStderrBytes?: number;
}

export async function git(
  args: string[],
  workspace: string,
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  if (options.signal?.aborted) throw abortError();
  const cwd = resolve(workspace);
  // Windows refuses to start a child process in a working directory that does
  // not fit MAX_PATH. The spawn then fails asynchronously on the stdio socket,
  // which no `try`/`catch` around the promise can intercept, so the check has
  // to happen before the child is created.
  const overflow = findWindowsWorkingDirectoryOverflow(cwd);
  if (overflow) {
    return { code: 1, stdout: '', stderr: formatWindowsWorkingDirectoryOverflowMessage(overflow) };
  }
  try {
    const result = await execFile(
      'git',
      ['-c', 'core.quotePath=false', '--no-optional-locks', ...args],
      {
        cwd,
        encoding: 'utf-8',
        env: gitEnv(),
        maxBuffer: GIT_MAX_BUFFER,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    if (isAbortFailure(error, options.signal)) {
      throw abortError();
    }
    const err = error as ExecFileException & { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: bufferToString(err.stdout),
      stderr: bufferToString(err.stderr) || err.message,
    };
  }
}

/**
 * Starts Git with stdio pipes that cannot terminate the host process.
 *
 * A child that fails to start leaves its stdio pipes unconnected, and the
 * sockets then report `read ENOTCONN` on their own. Without an 'error'
 * listener on every pipe that report is an unhandled 'error' event and it
 * kills the process, so the pipes are guarded here and every failure is
 * reported through `onError`.
 */
export function spawnGitChild(
  args: string[],
  cwd: string,
  onError: (error: unknown) => void,
): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn('git', ['-c', 'core.quotePath=false', '--no-optional-locks', ...args], {
    cwd,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.on('error', onError);
  child.stdout.on('error', onError);
  child.stderr.on('error', onError);
  return child;
}

/**
 * Runs Git without buffering stdout. Review search and untracked enumeration
 * use this path so repository-sized output never crosses execFile.maxBuffer.
 */
export async function gitStream(
  args: string[],
  workspace: string,
  options: GitStreamOptions,
): Promise<Omit<GitRunResult, 'stdout'>> {
  if (options.signal?.aborted) throw abortError();
  const cwd = resolve(workspace);
  const overflow = findWindowsWorkingDirectoryOverflow(cwd);
  if (overflow) throw new Error(formatWindowsWorkingDirectoryOverflowMessage(overflow));
  return new Promise((resolvePromise, reject) => {
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const stderrLimit = options.maxStderrBytes ?? 64 * 1024;
    let stderr = '';
    let settled = false;

    const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      child.kill();
      finishError(abortError());
    };

    const child = spawnGitChild(args, cwd, finishError);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      const text = stdoutDecoder.decode(chunk, { stream: true });
      if (text) options.onStdout(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length >= stderrLimit) return;
      stderr += stderrDecoder.decode(chunk, { stream: true });
      if (stderr.length > stderrLimit) stderr = stderr.slice(0, stderrLimit);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const tail = stdoutDecoder.decode();
      if (tail) options.onStdout(tail);
      stderr += stderrDecoder.decode();
      resolvePromise({ code: code ?? 1, stderr });
    });
  });
}

export function requireGitSuccess(
  result: GitRunResult,
  operation: 'diff' | 'ls-files',
): GitRunResult {
  if (result.code !== 0) {
    throw new WorkspaceGitCommandError(
      operation,
      result.code,
      (result.stderr || result.stdout).trim(),
    );
  }
  return result;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function abortError(): Error {
  const error = new Error('Git operation aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function bufferToString(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value ?? '');
}
