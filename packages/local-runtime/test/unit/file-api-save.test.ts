import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { routeLocalFileApi } from '../../src/files/api.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function saveRequest(workspace: string, path: string, content: string) {
  const request = new Request('http://localhost/api/file/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, path, content }),
  });
  return routeLocalFileApi(request, ['file', 'save'], new URL('http://localhost/api/file/save'));
}

async function openWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'mcode-file-save-'));
  cleanup.push(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

// Windows requires Developer Mode (or admin) to create symlinks. Probed lazily
// and memoized: the escape-guard cases create real links.
let symlinkPrivilege: boolean | undefined;
async function canSymlink(): Promise<boolean> {
  if (symlinkPrivilege === undefined) {
    const dir = await mkdtemp(join(tmpdir(), 'mcode-save-symlink-probe-'));
    try {
      await symlink(join(dir, 'target'), join(dir, 'link'));
      symlinkPrivilege = true;
    } catch {
      symlinkPrivilege = false;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return symlinkPrivilege;
}

it('creates a new nested file and returns ok', async () => {
  const workspace = await openWorkspace();

  const response = await saveRequest(workspace, 'nested/new.txt', 'hello');

  expect(response?.status).toBe(200);
  await expect(readFile(join(workspace, 'nested', 'new.txt'), 'utf-8')).resolves.toBe('hello');
});

it('overwrites an existing file', async () => {
  const workspace = await openWorkspace();
  await saveRequest(workspace, 'keep.txt', 'first');

  const response = await saveRequest(workspace, 'keep.txt', 'second');

  expect(response?.status).toBe(200);
  await expect(readFile(join(workspace, 'keep.txt'), 'utf-8')).resolves.toBe('second');
});

it('rejects a path that escapes the workspace', async () => {
  const workspace = await openWorkspace();

  const response = await saveRequest(workspace, '../escape.txt', 'x');

  expect(response?.status).toBe(400);
  await expect(readFile(join(workspace, '..', 'escape.txt'), 'utf-8')).rejects.toThrow();
});

it('rejects writes through a symlinked directory that leaves the workspace', async () => {
  if (process.platform === 'win32' && !(await canSymlink())) return;
  const workspace = await openWorkspace();
  const outside = await mkdtemp(join(tmpdir(), 'mcode-save-outside-'));
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(workspace, 'escape'));

  const response = await saveRequest(workspace, 'escape/evil.txt', 'x');

  expect(response?.status).toBe(400);
  await expect(readFile(join(outside, 'evil.txt'), 'utf-8')).rejects.toThrow();
});

it('rejects a dangling symlink target instead of writing through it', async () => {
  if (process.platform === 'win32' && !(await canSymlink())) return;
  const workspace = await openWorkspace();
  await symlink(join(workspace, 'never-created'), join(workspace, 'dangling.txt'));

  const response = await saveRequest(workspace, 'dangling.txt', 'x');

  expect(response?.status).toBe(400);
});
