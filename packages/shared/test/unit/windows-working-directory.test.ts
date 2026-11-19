import { describe, expect, it } from 'vitest';

import {
  WINDOWS_MAX_CHILD_PROCESS_WORKING_DIRECTORY_LENGTH,
  findWindowsWorkingDirectoryOverflow,
  formatWindowsWorkingDirectoryOverflowMessage,
} from '../../src/windows-working-directory.js';

const LIMIT = WINDOWS_MAX_CHILD_PROCESS_WORKING_DIRECTORY_LENGTH;

describe('Windows child-process working-directory limit', () => {
  it('accepts a working directory at the limit', () => {
    expect(findWindowsWorkingDirectoryOverflow('C:\\'.padEnd(LIMIT, 'a'), { platform: 'win32' })).toBeUndefined();
  });

  it('reports a working directory beyond the limit', () => {
    const overflow = findWindowsWorkingDirectoryOverflow('C:\\'.padEnd(LIMIT + 1, 'a'), {
      platform: 'win32',
    });
    expect(overflow).toEqual({ length: LIMIT + 1, limit: LIMIT });
  });

  it.each(['linux', 'darwin'])('never limits a working directory on %s', (platform) => {
    expect(
      findWindowsWorkingDirectoryOverflow('C:\\'.padEnd(LIMIT + 500, 'a'), {
        platform: platform as NodeJS.Platform,
      }),
    ).toBeUndefined();
  });

  it('explains the limit in user-facing words', () => {
    const message = formatWindowsWorkingDirectoryOverflowMessage({
      length: LIMIT + 1,
      limit: LIMIT,
    });
    expect(message).toContain('Workspace path exceeds the Windows limit for child processes');
    expect(message).toContain(`${LIMIT + 1} characters`);
    expect(message).toContain(`maximum ${LIMIT}`);
  });
});
