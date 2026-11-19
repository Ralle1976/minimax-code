import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Windows command execution for the release acceptance.
//
// npm ships as a .cmd shim next to node.exe, and CreateProcess cannot run a
// .cmd without a shell (same class as #130/#351). npm itself does not need
// that shell: its entry point is a JavaScript file, so it is started with the
// Node binary that runs this script. The whole argument vector then stays
// out of any command line parser, and no path can become command syntax.

// The directories that hold a shim for the given command, in the order
// cmd.exe searches them.
function shimDirectories(name) {
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean);
  const directories = [];
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = entry.trim();
    if (!directory) continue;
    for (const extension of extensions) {
      if (existsSync(path.join(directory, `${name}${extension.toLowerCase()}`))) {
        directories.push(directory);
        break;
      }
    }
  }
  return directories;
}

export function resolveNpmCli() {
  // The official Node layout keeps npm next to the node binary; a custom npm
  // installation anchors on the directory of its own shim.
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...shimDirectories('npm').map(directory =>
      path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`npm-cli.js was not found next to ${process.execPath} or on PATH.`);
}

export function runNpm(args, options) {
  if (process.platform !== 'win32') return execFileSync('npm', args, options);
  return execFileSync(process.execPath, [resolveNpmCli(), ...args], options);
}

// cmd.exe has no escape for a double quote and expands %VAR%, so a value that
// contains one of them is refused instead of escaped: a path that could close
// the quoted argument must never reach a command line.
const UNSAFE_FOR_CMD = /["%!\r\n]/u;

export function assertShellSafe(value, label) {
  if (UNSAFE_FOR_CMD.test(value))
    throw new Error(
      `Refusing to pass ${label} to cmd.exe: ${JSON.stringify(value)} contains a character that cmd.exe does not treat literally.`);
  return value;
}

// cmd.exe strips the first and the last quote of the command it receives, so
// the command line carries one pair of quotes more than its arguments.
export function runWindowsShim(command, args, options) {
  assertShellSafe(command, 'the launcher path');
  for (const argument of args) assertShellSafe(argument, 'a launcher argument');
  const line = [command, ...args].map(value => `"${value}"`).join(' ');
  return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

export function runShim(command, args, options) {
  if (process.platform !== 'win32') return execFileSync(command, args, options);
  return runWindowsShim(command, args, options);
}
