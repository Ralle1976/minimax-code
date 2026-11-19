/**
 * Windows caps the working directory a child process may start in at
 * `MAX_PATH`: 260 characters including the terminating NUL. `CreateProcessW`
 * normalizes `lpCurrentDirectory` before it starts the child, so the longest
 * directory a child can actually start in is 258 characters.
 *
 * Measured on Windows 11 x64 with Node 24.18.0 (see the Windows contract
 * test in `test/windows-workspace-path.test.mjs`):
 * - 258 characters: the child process starts
 * - 259 characters: the spawn fails with `spawn <command> ENOENT`
 * - 260 characters: the spawn fails *and* the pending stdio socket raises an
 *   uncaught `read ENOTCONN` error that terminates the Node process
 *
 * `LongPathsEnabled` does not lift the limit: it applies to the file APIs,
 * not to the working directory a child process starts in.
 */
export const WINDOWS_MAX_PATH = 260;

export const WINDOWS_MAX_CHILD_PROCESS_WORKING_DIRECTORY_LENGTH = WINDOWS_MAX_PATH - 2;

export interface WindowsWorkingDirectoryOverflow {
  /** Length of the offending working directory, in characters. */
  readonly length: number;
  /** Longest working directory Windows accepts, in characters. */
  readonly limit: number;
}

/**
 * Reports whether `workingDirectory` is too long for a child process on
 * Windows. Every other platform is a no-op: POSIX has no `MAX_PATH` limit for
 * a working directory.
 */
export function findWindowsWorkingDirectoryOverflow(
  workingDirectory: string,
  options: { platform?: NodeJS.Platform } = {},
): WindowsWorkingDirectoryOverflow | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return undefined;
  const length = workingDirectory.length;
  if (length <= WINDOWS_MAX_CHILD_PROCESS_WORKING_DIRECTORY_LENGTH) return undefined;
  return { length, limit: WINDOWS_MAX_CHILD_PROCESS_WORKING_DIRECTORY_LENGTH };
}

/**
 * User-facing explanation for a working directory Windows cannot hand to a
 * child process.
 */
export function formatWindowsWorkingDirectoryOverflowMessage(
  overflow: WindowsWorkingDirectoryOverflow,
): string {
  return (
    'Workspace path exceeds the Windows limit for child processes ' +
    `(${overflow.length} characters; maximum ${overflow.limit}). ` +
    'Move the project to a shorter directory, for example C:\\src\\project.'
  );
}
