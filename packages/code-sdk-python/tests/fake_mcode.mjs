#!/usr/bin/env node
// Fake `mcode` for unit tests, for Windows hosts.
//
// This is the Node port of `fake_mcode.py`, which is a `#!/usr/bin/env python3` script: Windows
// cannot execute a shebang script (`CreateProcess` rejects it with WinError 193), and the SDK
// only launches `.exe`, `.com` and `.js` entries on Windows (see `minimax_code._cli`). A `.mjs`
// entry is started as `node <entry>`, so this file is the Windows fake CLI.
//
// Behaviour is selected with FAKE_MCODE_SCENARIO and mirrors `fake_mcode.py` exactly.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const args = process.argv.slice(2);
const scenario = env.FAKE_MCODE_SCENARIO ?? 'ok';

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(`${env.FAKE_MCODE_VERSION ?? '0.7.2'}\n`);
  process.exit(0);
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const prompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt;
  if (env.FAKE_MCODE_PID) writeFileSync(env.FAKE_MCODE_PID, String(process.pid));
  if (env.FAKE_MCODE_RECORD) {
    appendFileSync(env.FAKE_MCODE_RECORD, `${JSON.stringify({ args, prompt })}\n`);
  }
  run(prompt);
});

function note(text) {
  if (env.FAKE_MCODE_LOG) appendFileSync(env.FAKE_MCODE_LOG, `${text}\n`);
}

const session =
  args.find((a) => a.startsWith('--session='))?.slice('--session='.length) ?? 'sess-new';

let seq = 0;
function emit(kind, extra = {}) {
  seq += 1;
  const base = {
    schemaVersion: 1,
    type: kind,
    sequence: seq,
    timestampMs: 0,
    runId: 'run-1',
    sessionId: session,
    turnId: `turn-${seq}`,
  };
  process.stdout.write(`${JSON.stringify({ ...base, ...extra })}\n`);
}

function result(status, extra = {}) {
  return {
    schemaVersion: 1,
    type: 'exec.result',
    runId: 'run-1',
    sessionId: session,
    turnId: 'turn-1',
    status,
    durationMs: 5,
    ...extra,
  };
}

function run(prompt) {
  const msg = { id: 'm1', type: 'agent_message' };

  if (scenario === 'invocation') {
    process.stderr.write('Error: --model is invalid\n');
    process.exit(2);
  }
  if (scenario === 'garbage') {
    process.stdout.write('not json\n');
    process.exit(0);
  }
  if (scenario === 'crash') {
    emit('exec.started');
    process.stderr.write('boom: internal failure\n');
    process.exit(70);
  }

  emit('exec.started');
  emit(args.some((a) => a.startsWith('--session=')) ? 'session.resumed' : 'session.started');
  emit('turn.started');
  emit('item.started', { item: { ...msg, contentDelta: 'Hel' } });
  emit('item.updated', { item: { ...msg, contentDelta: 'lo' } });
  const tool = { id: 't1', type: 'tool_call', toolCall: { id: 't1', name: 'bash', status: 1 } };
  emit('item.updated', { item: tool });
  emit('item.updated', { item: tool }); // duplicate snapshot: dropped by the SDK
  emit('item.completed', { item: { ...tool, toolCall: { id: 't1', name: 'bash', status: 2 } } });
  emit('future.event', { payload: true });

  if (scenario === 'slow') {
    // Like the CLI: SIGINT and SIGTERM each have a one-shot cancel handler; a repeated signal
    // hits the default action and kills the process before exec.completed.
    let cancelled = false;
    const onSignal = (name) => {
      note(`signal ${name}`);
      process.removeAllListeners(name);
      cancelled = true;
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    const timer = setInterval(() => {
      if (!cancelled) return;
      clearInterval(timer);
      setTimeout(() => {
        emit('turn.failed', { status: 'cancelled', durationMs: 5 });
        emit('exec.completed', { result: result('cancelled') });
        note('completed');
        process.exit(130);
      }, Number(env.FAKE_MCODE_SHUTDOWN_S ?? '0') * 1000);
    }, 50);
    return;
  }

  if (scenario === 'hang') {
    // ignores cancel signals and never finishes: only a hard kill stops it
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 60_000);
    return;
  }

  if (scenario === 'grandchild' || scenario === 'grandchild_crash') {
    // A background process inherits stdout and stderr and outlives the CLI.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.unref();
    if (scenario === 'grandchild_crash') process.exit(4);
    emit('exec.completed', { result: result('succeeded', { output: 'ok' }) });
    process.exit(0);
  }

  if (scenario === 'linger') {
    // exec.completed, then the CLI never exits on its own
    process.on('SIGTERM', () => {});
    emit('exec.completed', { result: result('succeeded', { output: 'ok' }) });
    emit('after.completed');
    setTimeout(() => process.exit(0), 60_000);
    return;
  }

  if (scenario === 'no_duration') {
    const bad = result('succeeded', { output: 'ok' });
    delete bad.durationMs;
    emit('exec.completed', { result: bad });
    process.exit(0);
  }

  if (scenario === 'error_no_message') {
    emit('exec.completed', { result: result('failed', { error: { category: 'runtime' } }) });
    process.exit(4);
  }

  if (scenario === 'failed') {
    const error = { category: 'runtime', message: 'model unavailable' };
    emit('turn.failed', { status: 'failed', error, durationMs: 5 });
    emit('exec.completed', { result: result('failed', { error }) });
    process.exit(4);
  }

  emit('item.completed', { item: { ...msg, content: `Hello: ${prompt}` } });
  emit('turn.completed', {
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    durationMs: 5,
  });
  emit('exec.completed', {
    result: result('succeeded', {
      output: `Hello: ${prompt}`,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    }),
  });
  process.exit(0);
}
