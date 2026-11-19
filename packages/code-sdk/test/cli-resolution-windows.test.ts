import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSpawnCommand, findOnPath, resolveCli } from '../src/cli-resolver.js';
import { MCode } from '../src/index.js';
import { findProjectBin } from '../src/project-bin.js';
import { FAKE_MCODE, fixture, tempDir } from './helpers.js';

/**
 * Windows resolves a launcher differently from POSIX: `.cmd`/`.ps1` instead of a symlink,
 * `;` instead of `:` as the PATH separator, PATHEXT instead of the executable bit and a
 * case-insensitive filesystem. These tests run on a real Windows host and therefore let the
 * production code take its Windows branches instead of simulating them with a pinned
 * `platform: 'win32'`.
 */
const onWindows = process.platform === 'win32';

/** A project whose CLI package (any name) is installed with a JS entry under node_modules. */
function project(): { root: string; entry: string; bin: string } {
  const root = tempDir();
  const packageDir = join(root, 'node_modules', '@scope', 'any-mcode-cli', 'dist');
  mkdirSync(packageDir, { recursive: true });
  const entry = join(packageDir, 'index.js');
  copyFileSync(FAKE_MCODE, entry);
  writeFileSync(
    join(root, 'node_modules', '@scope', 'any-mcode-cli', 'package.json'),
    '{"type":"module"}',
  );
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  return { root, entry, bin };
}

/** The npm-style `.cmd` shim that points at the project's JS entry. */
function cmdShim(): string {
  return '"%~dp0\\..\\@scope\\any-mcode-cli\\dist\\index.js" %*\r\n';
}

/** The pnpm-style PowerShell shim that points at the project's JS entry. */
function ps1Shim(): string {
  return '& "$basedir/node$exe"  "$basedir/../@scope/any-mcode-cli/dist/index.js" $args\n';
}

/** A PATH directory that holds a `mcode` launcher and the JS entry the launcher runs. */
function pathLauncher(name: string): { dir: string; entry: string } {
  const dir = tempDir();
  const entry = join(dir, 'mcode.mjs');
  copyFileSync(FAKE_MCODE, entry);
  writeFileSync(join(dir, name), '"%~dp0\\mcode.mjs" %*\r\n');
  return { dir, entry };
}

/** The layout the official installer writes: a root launcher, a release key and a release launcher. */
function installerLayout(release: string): { prefix: string; entry: string } {
  const prefix = tempDir();
  const packageDir = join(prefix, 'releases', release, 'node_modules', '@minimax-ai', 'code');
  mkdirSync(packageDir, { recursive: true });
  const entry = join(packageDir, 'cli.js');
  copyFileSync(FAKE_MCODE, entry);
  writeFileSync(join(packageDir, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(prefix, 'releases', release, '.mcode-launcher.cmd'),
    '@ECHO off\r\n"%~dp0node_modules\\@minimax-ai\\code\\cli.js" %*\r\nEXIT /B %ERRORLEVEL%\r\n',
  );
  writeFileSync(
    join(prefix, 'mcode.cmd'),
    '@ECHO off\r\nSETLOCAL\r\nSET /P MCODE_RELEASE=<"%~dp0current"\r\nCALL "%~dp0releases\\%MCODE_RELEASE%\\.mcode-launcher.cmd" %*\r\nEXIT /B %ERRORLEVEL%\r\n',
  );
  writeFileSync(join(prefix, 'current'), `${release}\r\n`);
  return { prefix, entry };
}

describe.skipIf(!onWindows)('Windows CLI resolution', () => {
  it('resolves a project-local mcode.cmd launcher to its JavaScript entry', () => {
    const { root, entry, bin } = project();
    writeFileSync(join(bin, 'mcode.cmd'), cmdShim());

    expect(findProjectBin(root)).toEqual({ kind: 'node', path: entry, source: 'project' });
    expect(
      resolveCli({ env: { PATH: '' }, packageSearchFrom: [], projectSearchFrom: root }),
    ).toEqual({ kind: 'node', path: entry, source: 'project' });
  });

  it('resolves a project-local mcode.ps1 launcher to its JavaScript entry', () => {
    const { root, entry, bin } = project();
    writeFileSync(join(bin, 'mcode.ps1'), ps1Shim());

    expect(findProjectBin(root)).toEqual({ kind: 'node', path: entry, source: 'project' });
  });

  it('prefers mcode.cmd over mcode.ps1 in the same node_modules/.bin', () => {
    const { root, entry, bin } = project();
    const other = join(root, 'node_modules', '@scope', 'any-mcode-cli', 'dist', 'other.js');
    copyFileSync(FAKE_MCODE, other);
    writeFileSync(join(bin, 'mcode.cmd'), cmdShim());
    writeFileSync(
      join(bin, 'mcode.ps1'),
      '& "$basedir/node$exe"  "$basedir/../@scope/any-mcode-cli/dist/other.js" $args\n',
    );

    expect(findProjectBin(root)).toEqual({ kind: 'node', path: entry, source: 'project' });
  });

  it('finds the project launcher above the working directory', () => {
    const { root, entry, bin } = project();
    writeFileSync(join(bin, 'mcode.cmd'), cmdShim());
    const nested = join(root, 'packages', 'app', 'src');
    mkdirSync(nested, { recursive: true });

    expect(findProjectBin(nested)).toEqual({ kind: 'node', path: entry, source: 'project' });
  });

  it('splits PATH on ";" and returns the first launcher', () => {
    const first = pathLauncher('mcode.cmd');
    const second = pathLauncher('mcode.cmd');

    const found = findOnPath('mcode', { PATH: `${first.dir};${second.dir}`, PATHEXT: '.CMD' });

    expect(found).toBe(join(first.dir, 'mcode.CMD'));
  });

  it('reads PATH and PATHEXT case-insensitively', () => {
    const { dir } = pathLauncher('mcode.cmd');

    expect(findOnPath('mcode', { Path: dir, pathext: '.CMD' })).toBe(join(dir, 'mcode.CMD'));
  });

  it('strips the quotes around a PATH entry', () => {
    const dir = join(tempDir(), 'Program Files', 'mcode tools');
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, 'mcode.mjs');
    copyFileSync(FAKE_MCODE, entry);
    writeFileSync(join(dir, 'mcode.cmd'), '"%~dp0\\mcode.mjs" %*\r\n');

    // The quoted entry is not a usable path until the quotes are removed.
    expect(findOnPath('mcode', { PATH: `"${dir}"`, PATHEXT: '.CMD' })).toBe(
      join(dir, 'mcode.CMD'),
    );
    expect(findOnPath('mcode.cmd', { PATH: `"${dir}"` })).toBe(join(dir, 'mcode.cmd'));
  });

  it('resolves a .cmd launcher on PATH to its JavaScript entry', () => {
    const { dir, entry } = pathLauncher('mcode.cmd');

    const cli = resolveCli({ env: { PATH: dir, PATHEXT: '.CMD' }, packageSearchFrom: [] });

    expect(cli).toEqual({ kind: 'node', path: entry, source: 'path' });
    expect(buildSpawnCommand(cli, ['--version'])).toEqual({
      command: process.execPath,
      args: [entry, '--version'],
    });
  });

  it('resolves a .bat launcher on PATH to its JavaScript entry', () => {
    const { dir, entry } = pathLauncher('mcode.bat');

    // No PATHEXT in the environment: the default list covers .BAT.
    const cli = resolveCli({ env: { PATH: dir }, packageSearchFrom: [] });

    expect(cli).toEqual({ kind: 'node', path: entry, source: 'path' });
  });

  it('resolves an explicit .cmd bin to its JavaScript entry', () => {
    const { dir, entry } = pathLauncher('mcode.cmd');

    expect(resolveCli({ bin: join(dir, 'mcode.cmd'), env: {} })).toEqual({
      kind: 'node',
      path: entry,
      source: 'option',
    });
  });

  it('asks for a JavaScript entry instead of starting a batch file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'mcode.cmd'), '@echo off\r\nnative-launcher.exe %*\r\n');

    expect(() => resolveCli({ bin: join(dir, 'mcode.cmd'), env: {} })).toThrow(
      /could not determine the JS entry it runs/u,
    );
  });

  it('follows the installer layout: mcode.cmd, current, release launcher', () => {
    const { prefix, entry } = installerLayout('0.7.1');

    const viaBin = resolveCli({ bin: join(prefix, 'mcode.cmd'), env: {} });
    expect(viaBin).toEqual({
      kind: 'node',
      path: entry,
      source: 'option',
      launcher: join(prefix, 'mcode.cmd'),
    });

    const viaPath = resolveCli({ env: { PATH: prefix, PATHEXT: '.CMD' }, packageSearchFrom: [] });
    expect(viaPath.kind).toBe('node');
    expect(viaPath.path).toBe(entry);
    expect(viaPath.source).toBe('path');
  });

  it('runs the launcher it resolved without a shell', () => {
    const { dir, entry } = pathLauncher('mcode.cmd');
    const cli = resolveCli({ env: { PATH: dir, PATHEXT: '.CMD' }, packageSearchFrom: [] });

    const command = buildSpawnCommand(cli, ['--version']);
    const result = spawnSync(command.command, command.args, { encoding: 'utf8', shell: false });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.7.0');
  });

  it('runs the CLI the SDK found on PATH through the client', async () => {
    const { dir } = pathLauncher('mcode.cmd');

    const turn = await new MCode({
      bin: 'mcode',
      env: { PATH: dir, PATHEXT: '.CMD', FAKE_MCODE_FIXTURE: fixture('resumed') },
    })
      .startThread()
      .run('hi');

    expect(turn.status).toBe('succeeded');
  });
});
