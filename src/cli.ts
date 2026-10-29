#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const help = `1harness
A programmable control surface for agent harnesses, locally and remotely.

Usage: 1harness [options]

Options:
  -h, --help       Show this help
  -v, --version    Show the version

This repository currently contains the development scaffold.
`;

try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${manifest.version}\n`);
  } else {
    process.stdout.write(help);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`1harness: ${message}\n`);
  process.exitCode = 2;
}
