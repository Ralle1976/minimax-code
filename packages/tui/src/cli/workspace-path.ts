import {
  findWindowsWorkingDirectoryOverflow,
  formatWindowsWorkingDirectoryOverflowMessage,
} from '@mavis/shared';

/**
 * Explains why a workspace directory cannot host child processes on Windows.
 *
 * Windows starts every child process in a working directory that has to fit
 * `MAX_PATH`; a longer directory makes the spawn fail asynchronously and
 * terminates the process with an uncaught socket error. The CLI therefore
 * refuses such a workspace before the runtime starts.
 *
 * Returns `undefined` when the directory is usable. POSIX has no such limit,
 * so every directory passes there.
 */
export function workspacePathLimitMessage(directory: string): string | undefined {
  const overflow = findWindowsWorkingDirectoryOverflow(directory);
  return overflow ? formatWindowsWorkingDirectoryOverflowMessage(overflow) : undefined;
}
