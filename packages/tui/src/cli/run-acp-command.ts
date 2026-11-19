import { Console } from 'node:console';
import type { Readable, Writable } from 'node:stream';

import { serveTuiAcpStdio } from '../acp/stdio.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import type { SystemPromptOverrides } from './system-prompt-options.js';
import { workspacePathLimitMessage } from './workspace-path.js';
import type {
  CreatedTuiRuntime,
  createTuiRuntime,
  shutdownTuiRuntime,
} from '../runtime/lifecycle.js';

type TuiTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

interface TuiAcpProcess {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  once(signal: TuiTerminationSignal, listener: () => void): unknown;
  off(signal: TuiTerminationSignal, listener: () => void): unknown;
}

export interface RunTuiAcpCommandDependencies {
  readonly processRef?: TuiAcpProcess;
  readonly workspaceDir?: () => string;
  readonly prepareDataDir?: typeof prepareTuiDataDir;
  readonly createRuntime?: typeof createTuiRuntime;
  readonly shutdownRuntime?: typeof shutdownTuiRuntime;
  readonly serve?: typeof serveTuiAcpStdio;
  readonly loadRuntimeLifecycle?: () => Promise<{
    createTuiRuntime: typeof createTuiRuntime;
    shutdownTuiRuntime: typeof shutdownTuiRuntime;
  }>;
}

export async function runTuiAcpCommand(
  version: string,
  dependencies: RunTuiAcpCommandDependencies = {},
  lane?: string,
  systemPromptOverrides?: SystemPromptOverrides,
): Promise<void> {
  const processRef = dependencies.processRef ?? process;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('ACP process is stopping.'));
  const restoreConsole = redirectConsoleOutputToStderr(processRef.stderr);
  let runtime: CreatedTuiRuntime | undefined;
  let shutdownRuntime = dependencies.shutdownRuntime;
  processRef.once('SIGINT', cancel);
  processRef.once('SIGTERM', cancel);
  processRef.once('SIGHUP', cancel);
  try {
    const lifecycle =
      dependencies.createRuntime && dependencies.shutdownRuntime
        ? {
            createTuiRuntime: dependencies.createRuntime,
            shutdownTuiRuntime: dependencies.shutdownRuntime,
          }
        : await (dependencies.loadRuntimeLifecycle ?? (() => import('../runtime/lifecycle.js')))();
    const createRuntime = dependencies.createRuntime ?? lifecycle.createTuiRuntime;
    shutdownRuntime ??= lifecycle.shutdownTuiRuntime;
    const dataDir = await (dependencies.prepareDataDir ?? prepareTuiDataDir)();
    const workspaceDir = (dependencies.workspaceDir ?? (() => process.cwd()))();
    // Git and shell tools start in the workspace directory. On Windows a
    // directory beyond MAX_PATH makes those spawns fail asynchronously and kill
    // the process, so the server stops here with an explanation instead.
    const workspacePathLimit = workspacePathLimitMessage(workspaceDir);
    if (workspacePathLimit) throw new Error(workspacePathLimit);
    runtime = await createRuntime({
      dataDir,
      workspaceDir,
      version,
      surface: 'acp',
      ...(lane ? { lane } : {}),
      ...(systemPromptOverrides ? { systemPromptOverrides } : {}),
    });
    await (dependencies.serve ?? serveTuiAcpStdio)({
      runtime: runtime.adapter,
      version,
      input: processRef.stdin,
      output: processRef.stdout,
      signal: controller.signal,
    });
  } finally {
    processRef.off('SIGINT', cancel);
    processRef.off('SIGTERM', cancel);
    processRef.off('SIGHUP', cancel);
    try {
      if (runtime && shutdownRuntime) await shutdownRuntime(runtime);
    } finally {
      restoreConsole();
    }
  }
}

function redirectConsoleOutputToStderr(stderr: Writable): () => void {
  const original = globalThis.console;
  globalThis.console = new Console({ stdout: stderr, stderr });
  return () => {
    globalThis.console = original;
  };
}
