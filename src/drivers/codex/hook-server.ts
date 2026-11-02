import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { denyHookOutput } from "../../core/tools.ts";

/**
 * How long Codex waits for 1harness's hook. A call whose hook gives no answer
 * goes ahead, so this is far longer than a check takes, even one that asks the
 * user. No longer than the 300 seconds Node's fetch waits for response headers:
 * past that the hook's fetch fails as if 1harness were gone.
 */
export const HOOK_TIMEOUT_SEC = 290;
/** How long 1harness takes to answer, well inside that. */
export const ANSWER_WITHIN_MS = (HOOK_TIMEOUT_SEC - 30) * 1000;
/** Why a call whose check never finished was blocked, as the agent hears it. */
export const LATE_ANSWER = "1harness could not check this call in time, so it was blocked";

/**
 * A localhost endpoint for Codex's command hooks: each POST carries a hook's
 * input, and the reply is the hook's output. A token keeps other local
 * processes out. A hook still unanswered after `within` ms blocks its call,
 * since Codex lets a call through once its hook gives up.
 */
export class HookServer {
  readonly url: string;
  readonly token: string;
  #server: Server;

  private constructor(server: Server, url: string, token: string) {
    this.#server = server;
    this.url = url;
    this.token = token;
  }

  static start(
    handle: (input: Record<string, unknown>) => Promise<unknown>,
    within = ANSWER_WITHIN_MS,
  ): Promise<HookServer> {
    const token = randomBytes(24).toString("base64url");
    const server = createServer((request, response) => {
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        void (async () => {
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<unknown>((resolve) => {
            timer = setTimeout(resolve, within, denyHookOutput(LATE_ANSWER));
          });
          try {
            const output = await Promise.race([
              handle(JSON.parse(body) as Record<string, unknown>),
              late,
            ]);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(output ?? {}));
          } catch {
            response.writeHead(500).end();
          } finally {
            clearTimeout(timer);
          }
        })();
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address !== "object" || !address) {
          reject(new Error("The hook server has no address"));
          return;
        }
        server.unref();
        resolve(new HookServer(server, `http://127.0.0.1:${address.port}/hook`, token));
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
