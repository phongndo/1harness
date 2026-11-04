import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandRegistry, parseShortcut, type CommandDefinition } from "./registry.ts";

function command(name: string, aliases: string[] = []): CommandDefinition {
  return { name, aliases, description: "", group: "General", run: () => {} };
}

describe("CommandRegistry", () => {
  it("finds commands by name or alias, and removes only what it added", () => {
    const registry = new CommandRegistry();
    const remove = registry.register(command("quit", ["exit"]));
    assert.equal(registry.find("exit")?.name, "quit");
    const replacement = command("quit");
    registry.register(replacement);
    remove();
    assert.equal(registry.find("quit"), replacement, "a later registration survives");
    assert.equal(registry.find("exit"), undefined);
  });
});

describe("parseShortcut", () => {
  it("takes ctrl+ or alt+ and a letter or digit, however it is written", () => {
    assert.equal(parseShortcut("alt+r"), "alt+r");
    assert.equal(parseShortcut(" Ctrl+G "), "ctrl+g");
    assert.equal(parseShortcut("alt+1"), "alt+1");
  });

  it("refuses other keys, and ones the composer and the UI answer to", () => {
    assert.throws(() => parseShortcut("r"), /not a shortcut/);
    assert.throws(() => parseShortcut("shift+r"), /not a shortcut/);
    assert.throws(() => parseShortcut("ctrl+return"), /not a shortcut/);
    for (const taken of ["ctrl+c", "ctrl+d", "ctrl+t", "ctrl+x", "ctrl+z", "ctrl+a", "alt+b"])
      assert.throws(() => parseShortcut(taken), /already taken/);
  });
});
