import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { HarnessProcess } from "./child.ts";

function run(source: string): HarnessProcess {
  return new HarnessProcess(spawn(process.execPath, ["-e", source]), "Fake");
}

describe("HarnessProcess", () => {
  it("says why it exited with the last lines it wrote to stderr", async () => {
    const child = run(
      `for (let n = 1; n <= 7; n++) console.error("line " + n); process.exitCode = 3;`,
    );
    assert.equal(
      await child.exited,
      "Fake exited (code 3): line 3\nline 4\nline 5\nline 6\nline 7",
    );
  });

  it("closes a process that is still running", async () => {
    const child = run("setInterval(() => {}, 1000);");
    await child.close();
    assert.equal(await child.exited, "Fake exited (signal SIGTERM)");
    // Closing again, once it has exited, does nothing.
    await child.close();
  });
});
