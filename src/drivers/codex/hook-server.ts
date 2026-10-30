import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A localhost endpoint for Codex's command hooks: each POST carries a hook's
 * input, and the reply is the hook's output. A token keeps other local
 * processes out.
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

  static start(handle: (input: Record<string, unknown>) => Promise<unknown>): Promise<HookServer> {
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
          try {
            const output = await handle(JSON.parse(body) as Record<string, unknown>);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(output ?? {}));
          } catch {
            response.writeHead(500).end();
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
