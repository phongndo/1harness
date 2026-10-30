// One notebook for every harness: the agent saves and reads notes through two
// tools that 1harness serves over MCP, so a note Claude saves, Codex can read.
//
//   /notes         list the notes
//   /notes clear   delete them
//
// Load it with `1harness -x examples/extensions/shared-notes.ts`, or copy it to
// ~/.config/1harness/extensions/.

import type { ExtensionAPI } from "1harness/extension";

interface Note {
  text: string;
  harness: string;
  savedAt: number;
}

export default function sharedNotes(api: ExtensionAPI): void {
  const notes = (): Note[] => api.storage.get<Note[]>("notes") ?? [];

  api.registerTool({
    name: "save_note",
    description:
      "Save a short note for later. Any agent in 1harness can read it, on any harness, with read_notes.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The note" } },
      required: ["text"],
    },
    execute(input, context) {
      const text = String(input["text"] ?? "").trim();
      if (!text) throw new Error("The note is empty");
      const harness = context.thread.session.info.harness;
      api.storage.set("notes", [...notes(), { text, harness, savedAt: Date.now() }]);
      return "Saved.";
    },
  });

  api.registerTool({
    name: "read_notes",
    description: "Read the notes agents saved with save_note, oldest first.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    execute: () =>
      notes()
        .map((note) => `[${note.harness}] ${note.text}`)
        .join("\n") || "No notes yet.",
  });

  api.registerCommand({
    name: "notes",
    usage: "[clear]",
    description: "list the notes agents saved, or clear them",
    group: "Tools",
    run(context, args) {
      if (args === "clear") {
        api.storage.delete("notes");
        context.ui.notify("info", "Notes cleared");
        return;
      }
      const saved = notes();
      context.ui.report({
        title: "Notes",
        lines:
          saved.length > 0
            ? saved.map((note) => [
                { text: `${note.harness.padEnd(8)}`, tone: "muted" },
                { text: note.text, tone: "soft" },
              ])
            : [[{ text: "No notes yet", tone: "muted" }]],
      });
    },
  });
}
