import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  runInImmediateTransaction,
  type DatabaseConstructor,
} from '../packages/local-runtime/src/persistence/db.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function openProbeDb(): Promise<{
  db: InstanceType<DatabaseConstructor>;
  dbPath: string;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'mcode-immediate-tx-retry-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'probe.sqlite');
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3') as DatabaseConstructor;
  const db = new Database(dbPath);
  cleanup.push(() => db.close());
  // Shrink the native wait so the case stays fast: the hold below outlasts it
  // on purpose, which is exactly the window where #282's turns die today.
  db.exec('PRAGMA busy_timeout = 50');
  db.exec('CREATE TABLE probe (x TEXT NOT NULL)');
  return { db, dbPath, dir };
}

async function holdWriter(dir: string, dbPath: string, durationMs: number) {
  const file = join(dir, 'lock-holder.cjs');
  await writeFile(
    file,
    `
    const Database = require(process.argv[2]);
    const db = new Database(process.argv[3]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setTimeout(() => {
      db.exec('COMMIT');
      db.close();
      process.disconnect();
    }, Number(process.argv[4]));
  `,
  );
  const child = fork(
    file,
    [createRequire(import.meta.url).resolve('better-sqlite3'), dbPath, String(durationMs)],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const exited = once(child, 'exit');
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await Promise.race([
    once(child, 'message'),
    exited.then(() => {
      throw new Error('Lock holder exited before acquiring the lock');
    }),
  ]);
}

it('completes the transaction and its write after a foreign writer outlasts the native busy timeout', async () => {
  const { db, dbPath, dir } = await openProbeDb();
  await holdWriter(dir, dbPath, 400);

  const result = runInImmediateTransaction(db, () => {
    db.prepare('INSERT INTO probe VALUES (?)').run('landed');
    return 'committed';
  });

  expect(result).toBe('committed');
  expect(db.prepare('SELECT x FROM probe').all()).toEqual([{ x: 'landed' }]);
});

it('throws the last busy error once the retry budget expires', async () => {
  const { db, dbPath, dir } = await openProbeDb();
  await holdWriter(dir, dbPath, 1_000);
  const startedAt = performance.now();
  expect(() => runInImmediateTransaction(db, () => 'never', { timeoutMs: 150 })).toThrow(
    /database is locked/i,
  );
  expect(performance.now() - startedAt).toBeLessThan(900);
});

it('never replays a callback that already started', async () => {
  const { db } = await openProbeDb();
  let calls = 0;
  expect(() =>
    runInImmediateTransaction(db, () => {
      calls += 1;
      throw new Error('callback failed');
    }),
  ).toThrow('callback failed');
  expect(calls).toBe(1);
});
