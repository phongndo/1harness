import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandRegistry, type CommandDefinition } from "./registry.ts";

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
