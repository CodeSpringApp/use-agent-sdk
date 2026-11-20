import { createServer } from "node:http";
import type { ChatGPTPlanAuthorization, ChatGPTPlanStatus } from "./types";

type PlanClient = {
  authorizeLocal(redirectUri: string): Promise<ChatGPTPlanAuthorization>;
  complete(input: { state: string; code?: string; error?: string; clientId?: string }): Promise<ChatGPTPlanStatus>;
};

/** The callback carries a single-use code. Provider tokens remain in the broker. */
export async function connectChatGPTLocally(client: PlanClient, options: {
  openBrowser: (url: string) => Promise<boolean>;
  write: (text: string) => unknown;
  timeoutMs?: number;
}): Promise<ChatGPTPlanStatus> {
  let expectedState: string | undefined;
  let redirectUri = "";
  let consumed = false;
  let resolve!: (value: ChatGPTPlanStatus) => void;
  let reject!: (reason: Error) => void;
  const completed = new Promise<ChatGPTPlanStatus>((yes, no) => { resolve = yes; reject = no; });
  // Attach a handler before browser startup, so an early timeout is never unhandled.
  void completed.catch(() => {});
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    const url = new URL(request.url ?? "/", redirectUri || "http://127.0.0.1");
    if (request.method !== "GET" || request.headers.host !== new URL(redirectUri).host || url.pathname !== "/auth/callback" || request.headers.origin) {
      response.writeHead(404).end("Not found"); return;
    }
    const state = url.searchParams.get("state");
    if (!expectedState || state !== expectedState || url.searchParams.getAll("state").length !== 1 || consumed) {
      response.writeHead(400).end("This sign-in does not match the pending connection."); return;
    }
    const code = url.searchParams.get("code"), error = url.searchParams.get("error"), clientId = url.searchParams.get("client_id");
    if (Boolean(code) === Boolean(error) || ["code", "error", "client_id"].some(key => url.searchParams.getAll(key).length > 1)) {
      response.writeHead(400).end("Invalid sign-in response."); return;
    }
    consumed = true;
    try {
      const result = await client.complete({ state, ...(code ? { code } : {}), ...(error ? { error } : {}), ...(clientId ? { clientId } : {}) });
      response.end("ChatGPT connected. You can close this tab and return to Use Agent."); resolve(result);
    } catch {
      response.writeHead(400).end("Connection failed. Return to the terminal and try again.");
      reject(new Error("ChatGPT connection failed. Run the connect command again."));
    }
  });
  server.maxConnections = 8;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  const timeout = setTimeout(() => reject(new Error("ChatGPT sign-in timed out. Run the connect command again.")), options.timeoutMs ?? 600000);
  const interrupted = () => reject(new Error("ChatGPT sign-in cancelled."));
  process.once("SIGINT", interrupted);
  try {
    await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => { server.removeListener("error", no); yes(); }); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local callback listener is unavailable");
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const authorization = await client.authorizeLocal(redirectUri);
    const url = new URL(authorization.authorizationUrl);
    if (url.origin !== "https://auth.openai.com" || url.username || url.password || url.searchParams.get("redirect_uri") !== redirectUri) throw new Error("Invalid ChatGPT authorization address");
    expectedState = url.searchParams.get("state") ?? undefined;
    if (!expectedState || expectedState.length < 32) throw new Error("Missing ChatGPT transaction state");
    options.write("Complete the ChatGPT sign-in in your browser. This command will wait.\n");
    if (!await options.openBrowser(url.toString())) options.write(`Open this address on this computer:\n${url.toString()}\n`);
    return await completed;
  } finally {
    clearTimeout(timeout); process.removeListener("SIGINT", interrupted);
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}
