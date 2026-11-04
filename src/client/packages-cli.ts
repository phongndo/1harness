import {
  installedPackages,
  installPackage,
  removePackage,
  updatePackages,
  type PackageContents,
  type Runner,
} from "../extensions/packages.ts";

export const PACKAGES_HELP = `Usage: 1harness packages [ls] [--json]
       1harness packages install <source>
       1harness packages remove <source or name>
       1harness packages update [source or name]

Installs extensions and skills as one, for every harness, on this machine.
A source is npm:name@version, git:github.com/you/tools@ref, an https:// git URL,
or a folder, which is read where it is.

A package declares what it offers in package.json:
  "1harness": { "extensions": ["./src/tools.ts"], "skills": ["./skills"] }
or keeps it in extensions/ and skills/ folders, with "type": "module" so its
extensions load as ES modules. A pinned version or ref stays
pinned through update. No install scripts run, but a package's extensions run
with your permissions once loaded, so read a package before installing it.

packages.json in ~/.config/1harness says what is installed; update fetches what
it names on a new machine. /extensions reload loads changes into a running server.
`;

const RELOAD_HINT = "Open threads pick this up after /extensions reload.";

function offers(contents: PackageContents): string {
  const parts = [
    contents.extensions.length > 0
      ? `${contents.extensions.length} extension${contents.extensions.length === 1 ? "" : "s"}`
      : null,
    contents.skills.length > 0 ? "skills" : null,
  ].filter(Boolean);
  return parts.join(" and ") || "nothing";
}

/** `1harness packages`, which works on this machine's files and needs no server. */
export async function packagesCommand(
  args: string[],
  dirs: { configDir: string; stateDir: string; cwd?: string },
  write: (text: string) => void = (text) => process.stdout.write(text),
  runner?: Runner,
): Promise<number> {
  const line = (text: string) => write(`${text}\n`);
  const json = args.includes("--json");
  const [action = "ls", target, extra] = args.filter((arg) => arg !== "--json");
  if (action === "-h" || action === "--help") {
    write(PACKAGES_HELP);
    return 0;
  }
  if (extra !== undefined) {
    write(PACKAGES_HELP);
    return 1;
  }
  switch (action) {
    case "ls": {
      const { packages, warnings } = installedPackages(dirs.configDir, dirs.stateDir);
      if (json) {
        line(JSON.stringify(packages, null, 2));
        return 0;
      }
      if (packages.length === 0 && warnings.length === 0)
        line("No packages. `1harness packages install <source>` adds one.");
      for (const entry of packages) {
        const { contents } = entry;
        if (contents)
          line(
            `${contents.name}${contents.version ? ` ${contents.version}` : ""}  ${offers(contents)}  ${entry.source}`,
          );
      }
      for (const warning of warnings) line(warning);
      return warnings.length > 0 ? 1 : 0;
    }
    case "install": {
      if (!target) {
        write(PACKAGES_HELP);
        return 1;
      }
      const { source, contents } = await installPackage(target, dirs, runner);
      line(`Installed ${contents.name} (${offers(contents)}) from ${source}. ${RELOAD_HINT}`);
      return 0;
    }
    case "remove": {
      if (!target) {
        write(PACKAGES_HELP);
        return 1;
      }
      for (const source of removePackage(target, dirs)) line(`Removed ${source}.`);
      line(RELOAD_HINT);
      return 0;
    }
    case "update": {
      const results = await updatePackages(target, dirs, runner);
      if (results.length === 0) line("No packages to update.");
      for (const result of results)
        line(
          result.contents
            ? `Updated ${result.contents.name} from ${result.source}.`
            : `Could not update ${result.source}: ${result.error}`,
        );
      if (results.some((result) => result.contents)) line(RELOAD_HINT);
      return results.some((result) => result.error) ? 1 : 0;
    }
    default:
      write(PACKAGES_HELP);
      return 1;
  }
}
