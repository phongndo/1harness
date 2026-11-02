# Agent instructions

The code is the documentation. Prose kept apart from the code falls out of sync,
so this repository keeps very little of it.

- Do not add Markdown, HTML, or text files: no plans, research notes, design
  docs, changelogs, summaries, or TODO lists. Use your scratchpad for working
  notes and leave them out of the repository. `src/docs.test.ts` fails on new
  ones.
- Do not update `README.md` for a new feature or behavior change. It changes
  only when installing, running, or developing changes, or a config path moves.
- Describe user-facing behavior where users see it: `--help` in `src/cli.ts` and
  command descriptions in `src/commands`. Tests pin down the details.
- Explain _why_ in a short comment beside the code that needs it, or in the
  commit message. Do not narrate _what_ the code does.
- When you change code, fix or delete the comments that describe it.

Run `pnpm check` before you finish.
