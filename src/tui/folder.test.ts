import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FolderLabel } from "./folder.ts";

const settle = () => new Promise((done) => setImmediate(done));

describe("FolderLabel", () => {
  it("adds a repository's branch, asking again each turn", async () => {
    const branches = new Map<string, string | null>([
      ["/home/u/app", "main"],
      ["/home/u/notes", null],
    ]);
    const asked: string[] = [];
    let changed = 0;
    const folder = new FolderLabel(
      async (cwd) => {
        asked.push(cwd);
        return branches.get(cwd) ?? null;
      },
      () => changed++,
    );
    assert.equal(folder.label("/home/u/app", "t:0", "/home/u"), "~/app", "the path until it hears");
    await settle();
    assert.equal(folder.label("/home/u/app", "t:0", "/home/u"), "app · main");
    assert.deepEqual(asked, ["/home/u/app"], "asked once a turn");

    branches.set("/home/u/app", "feat");
    assert.equal(folder.label("/home/u/app", "t:1", "/home/u"), "app · main", "the last meanwhile");
    await settle();
    assert.equal(folder.label("/home/u/app", "t:1", "/home/u"), "app · feat");
    assert.equal(changed, 2);

    folder.label("/home/u/notes", "t:1", "/home/u");
    await settle();
    assert.equal(
      folder.label("/home/u/notes", "t:1", "/home/u"),
      "~/notes",
      "the path outside one",
    );
  });

  it("shows the path alone when the host cannot say", async () => {
    const folder = new FolderLabel(
      () => Promise.reject(new Error("no such method")),
      () => {},
    );
    folder.label("/srv/app", "", "/home/u");
    await settle();
    assert.equal(folder.label("/srv/app", "", "/home/u"), "/srv/app");
  });
});
