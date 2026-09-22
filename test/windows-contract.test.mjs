import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { checkWindowsSourceLocation } from "../scripts/check-windows-source-location.mjs";
import { resolveWslPath } from "../packages/tui/src/host/wsl-path.js";

const windowsPath = String.raw`D:\Users\demo\Documents\Screen shots\截图.png`;

describe.skipIf(process.platform !== "win32")("Windows source contract", () => {
  it("accepts the Windows checkout on a local NTFS volume", () => {
    assert.deepEqual(checkWindowsSourceLocation(), {
      ok: true,
      skipped: false,
    });
  });

  it("preserves Windows path syntax on the native host", async () => {
    assert.equal(await resolveWslPath(windowsPath), windowsPath);
  });
});

// Policy cases inject execFile, so they exercise the win32 volume rules on
// every host without needing a Windows machine.
describe("checkWindowsSourceLocation volume policy", () => {
  const win32Fixture = {
    platform: "win32",
    cwd: String.raw`C:\work\repo`,
    allowNonFixed: false,
  };

  const denyingFsutil = (cimOutput) => (command) => {
    if (command === "fsutil") {
      throw new Error("Command failed: fsutil fsinfo volumeinfo C:");
    }
    return cimOutput;
  };

  it("accepts NTFS via the WMI fallback when fsutil is denied without elevation", () => {
    assert.deepEqual(
      checkWindowsSourceLocation({ ...win32Fixture, execFile: denyingFsutil("NTFS 3\n") }),
      { ok: true, skipped: false },
    );
  });

  it("still rejects a non-NTFS volume when fsutil is denied", () => {
    const result = checkWindowsSourceLocation({
      ...win32Fixture,
      execFile: denyingFsutil("FAT32 3\n"),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not formatted as NTFS/);
  });

  it("still rejects a non-fixed volume when fsutil is denied", () => {
    const result = checkWindowsSourceLocation({
      ...win32Fixture,
      execFile: denyingFsutil("NTFS 2\n"),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not a local fixed drive/);
  });

  it("honors allowNonFixed for the fallback verdict", () => {
    assert.deepEqual(
      checkWindowsSourceLocation({
        ...win32Fixture,
        allowNonFixed: true,
        execFile: denyingFsutil("NTFS 2\n"),
      }),
      { ok: true, skipped: false },
    );
  });

  it("fails closed when fsutil and the fallback are both unavailable", () => {
    const result = checkWindowsSourceLocation({
      ...win32Fixture,
      execFile: () => {
        throw new Error("Command failed");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /could not verify/);
  });

  it("keeps the fsutil fast path when it works", () => {
    assert.deepEqual(
      checkWindowsSourceLocation({
        ...win32Fixture,
        execFile: (command, args) => {
          if (command === "powershell") {
            throw new Error("fallback must not run when fsutil succeeds");
          }
          return args[1] === "drivetype"
            ? "Drivetype : DRIVE_FIXED\n"
            : "File System : NTFS\n";
        },
      }),
      { ok: true, skipped: false },
    );
  });
});
