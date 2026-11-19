import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { git as gitV1 } from "../packages/local-runtime/src/files/git-process.js";
import {
  git as gitV2,
  gitStream as gitStreamV2,
  spawnGitChild,
} from "../packages/local-runtime-v2/src/service/workspace/operations/git-process.js";
import { workspacePathLimitMessage } from "../packages/tui/src/cli/workspace-path.js";

const LIMIT_MESSAGE = /Workspace path exceeds the Windows limit for child processes/u;
const WORKSPACE_LENGTH = 260;
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  }
});

/**
 * Creates nested directories until the absolute path is at least `length`
 * characters long. Windows starts a child process in a working directory that
 * has to fit `MAX_PATH`, so a workspace beyond that limit cannot host Git.
 */
function createWorkspaceOfLength(root, length) {
  let current = root;
  mkdirSync(current, { recursive: true });
  while (current.length + 41 <= length) {
    current = path.join(current, "w".repeat(40));
    mkdirSync(current, { recursive: true });
  }
  const remaining = length - current.length;
  if (remaining === 0) return current;
  current = path.join(current, "w".repeat(Math.max(1, remaining - 1)));
  mkdirSync(current, { recursive: true });
  return current;
}

function createWorkspaceRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "mcode-workspace-path-"));
  temporaryRoots.push(root);
  return root;
}

describe.skipIf(process.platform !== "win32")("Windows workspace path contract", () => {
  it("reports the limit instead of crashing the process", async () => {
    const workspace = createWorkspaceOfLength(createWorkspaceRoot(), WORKSPACE_LENGTH);
    assert.ok(
      workspace.length > 258,
      `expected a workspace beyond the Windows child-process limit, got ${workspace.length}`,
    );

    const result = await gitV2(["rev-parse", "--is-inside-work-tree"], workspace);
    assert.equal(result.code, 1);
    assert.match(result.stderr, LIMIT_MESSAGE);

    const stream = await gitStreamV2(["ls-files"], workspace, { onStdout: () => {} }).then(
      () => undefined,
      (error) => error,
    );
    assert.ok(stream instanceof Error);
    assert.match(stream.message, LIMIT_MESSAGE);

    const legacy = await gitV1(["rev-parse", "--is-inside-work-tree"], workspace);
    assert.equal(legacy.code, 1);
    assert.match(legacy.stderr, LIMIT_MESSAGE);

    // Reaching this line proves the process survived: an unreported socket
    // error would have terminated the worker before the first assertion.
  });

  it("starts Git normally for a workspace within the limit", async () => {
    const workspace = createWorkspaceOfLength(createWorkspaceRoot(), 120);
    assert.ok(workspace.length <= 258);

    const result = await gitV2(["rev-parse", "--is-inside-work-tree"], workspace);
    // Git ran and reported that the temporary directory is not a repository.
    // A failed spawn would report "spawn git ENOENT" instead.
    assert.doesNotMatch(result.stderr, LIMIT_MESSAGE);
    assert.doesNotMatch(result.stderr, /spawn/u);
  });

  it("reports a child process that cannot start instead of crashing", async () => {
    const workspace = createWorkspaceOfLength(createWorkspaceRoot(), WORKSPACE_LENGTH);
    const failures = [];
    const child = spawnGitChild(["rev-parse", "--is-inside-work-tree"], workspace, (error) => {
      failures.push(error);
    });
    await new Promise((resolve) => child.on("close", resolve));

    // The child cannot start in this directory. Its stdio sockets report
    // `read ENOTCONN`, and only the guarded pipes keep that from becoming an
    // unhandled 'error' event that terminates the worker.
    assert.ok(
      failures.some((failure) => failure?.code === "ENOTCONN"),
      "expected the unconnected stdio socket to report ENOTCONN",
    );
  });
});

describe("workspace path limit policy", () => {
  it("names the limit for a Windows workspace beyond it", () => {
    const message = workspacePathLimitMessage("C:\\".padEnd(259, "a"));
    if (process.platform === "win32") {
      assert.match(message ?? "", LIMIT_MESSAGE);
    } else {
      assert.equal(message, undefined);
    }
  });

  it("leaves every workspace alone on POSIX", () => {
    if (process.platform === "win32") return;
    assert.equal(workspacePathLimitMessage("C:\\".padEnd(4096, "a")), undefined);
  });
});
