export function normalizeVmUrl(input: string): string {
  try {
    let url = new URL(input.trim());
    if (url.searchParams.has("uri"))
      url = new URL(url.searchParams.get("uri")!);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.protocol = ["https:", "wss:"].includes(url.protocol) ? "wss:" : "ws:";
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/ws")) url.pathname += "/ws";
    return url.href;
  } catch {
    throw new Error(
      "Enter a local VM Service URL from your Flutter debug session.",
    );
  }
}

export interface RpcTransport {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
  onClose?: () => void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RpcClient {
  private socket: WebSocket;
  private timeoutMs: number;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private closed = false;
  onClose?: () => void;

  private constructor(socket: WebSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    socket.addEventListener("close", () =>
      this.fail(new Error("VM connection closed.")),
    );
    socket.addEventListener("error", () =>
      this.fail(new Error("VM connection closed.")),
    );
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (
          !message ||
          typeof message !== "object" ||
          message.jsonrpc !== "2.0"
        )
          throw new Error();
        if (!("id" in message)) return;
        const task = this.pending.get(String(message.id));
        if (!task) return;
        if (!("result" in message) && !("error" in message)) throw new Error();
        clearTimeout(task.timer);
        this.pending.delete(String(message.id));
        if (message.error) {
          const code = Number.isInteger(message.error.code)
            ? message.error.code
            : "unknown";
          task.reject(new Error(`RPC error (${code}).`));
        } else task.resolve(message.result);
      } catch {
        this.fail(new Error("Invalid VM response."));
      }
    });
  }

  static async connect(
    url: string,
    timeoutMs = 8000,
    dtd = false,
  ): Promise<RpcClient> {
    let endpoint = normalizeVmUrl(url);
    if (dtd) {
      const original = new URL(url);
      if (
        !["ws:", "wss:"].includes(original.protocol) ||
        original.origin !== new URL(endpoint).origin ||
        original.search ||
        original.hash
      )
        throw new Error("Invalid DTD endpoint.");
      endpoint = original.href;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(endpoint);
    } catch {
      throw new Error("Could not open the local VM connection.");
    }
    const client = new RpcClient(socket, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const failed = () => {
        clearTimeout(timer);
        reject(
          new Error(
            "Could not connect. Check the VM URL and device forwarding.",
          ),
        );
      };
      const timer = setTimeout(() => {
        client.close();
        failed();
      }, timeoutMs);
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          socket.removeEventListener("error", failed);
          socket.removeEventListener("close", failed);
          resolve();
        },
        { once: true },
      );
    });
    return client;
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("VM connection closed."));
    return new Promise<T>((resolve, reject) => {
      const id = String(++this.sequence);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("VM request timed out."));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.socket.send(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        );
      } catch {
        this.fail(new Error("VM connection closed."));
      }
    });
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    this.pending.clear();
    this.socket.close();
    this.onClose?.();
  }

  close() {
    this.fail(new Error("VM connection closed."));
  }
}
