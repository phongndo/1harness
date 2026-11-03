import { errorMessage } from "../core/errors.ts";
import { serverHello } from "./socket.ts";
import { loadHosts, resolveServer, saveHosts } from "./hosts.ts";

export const HOSTS_HELP = `Usage: 1harness hosts add <name> <address>
       1harness hosts ls
       1harness hosts remove <name>
       1harness hosts check [name]

Names servers on other machines, such as one listening with
\`1harness server run --extra-listen tailnet://:7330\`, for \`1harness -S <name>\`.
An address is host:port, an http(s):// URL, or a socket path.
`;

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Says whether a server answers, as which version, and who it takes the caller to be. */
async function check(spec: string | undefined): Promise<boolean> {
  const { target, label } = resolveServer(spec);
  try {
    const hello = await serverHello(target, 5_000);
    line(
      `${label}  1harness ${hello.version}, protocol ${hello.protocol}, pid ${hello.pid}${hello.identity ? `, you are ${hello.identity}` : ""}`,
    );
    return true;
  } catch (error) {
    line(`${label}  ${errorMessage(error)}`);
    return false;
  }
}

/** `1harness hosts …`; resolves with the exit status. */
export async function hostsCommand(args: string[]): Promise<number> {
  const [command = "ls", ...rest] = args;
  const hosts = loadHosts();
  switch (command) {
    case "add": {
      const [name, address] = rest;
      if (!name || !address) {
        process.stderr.write(HOSTS_HELP);
        return 2;
      }
      if (/[:/\s]/.test(name)) throw new Error("A host's name has no colons, slashes, or spaces");
      hosts[name] = address;
      saveHosts(hosts);
      line(`Added ${name} → ${address}`);
      return (await check(name)) ? 0 : 1;
    }
    case "ls":
    case "list": {
      const names = Object.keys(hosts).toSorted();
      if (names.length === 0) line("No hosts; add one with `1harness hosts add <name> <address>`.");
      for (const name of names) line(`${name.padEnd(12)} ${hosts[name]}`);
      return 0;
    }
    case "remove":
    case "rm": {
      const [name] = rest;
      if (!name || !(name in hosts)) throw new Error(`No host named ${name ?? ""}`);
      delete hosts[name];
      saveHosts(hosts);
      line(`Removed ${name}`);
      return 0;
    }
    case "check": {
      const names = rest.length > 0 ? rest : [undefined, ...Object.keys(hosts).toSorted()];
      let ok = true;
      for (const name of names) ok = (await check(name)) && ok;
      return ok ? 0 : 1;
    }
    default:
      process.stdout.write(HOSTS_HELP);
      return command === "help" || command === "--help" ? 0 : 2;
  }
}

/** `1harness whoami`: who a server takes you to be. */
export async function whoami(spec: string | undefined): Promise<number> {
  const { target, label, local } = resolveServer(spec);
  try {
    const hello = await serverHello(target, 5_000);
    line(
      hello.identity ??
        (local ? `${process.env["USER"] ?? "you"}, on the local socket of ${label}` : "anonymous"),
    );
    return 0;
  } catch (error) {
    line(`${label}: ${errorMessage(error)}`);
    return 1;
  }
}
