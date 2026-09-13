import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { NativeReply, NativePort } from "./protocol.ts";
export type { NativeReply, NativePort } from "./protocol.ts";
export class NativeProcess implements NativePort {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private pending:
    | { resolve: (value: NativeReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  private failed = false;
  constructor(initialize = false) {
    const executable = fileURLToPath(new URL("../native/.build/release/gmail-mcp-native", import.meta.url));
    this.child = spawn(executable, initialize ? ["--init"] : [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    this.child.stderr.resume();
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.receive();
    });
  }
  private fail() {
    this.failed = true;
    const p = this.pending;
    this.pending = undefined;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error("native_unavailable"));
    }
  }
  private receive() {
    if (this.buffer.length < 8) return;
    const metadata = this.buffer.readUInt32BE(0),
      body = this.buffer.readUInt32BE(4);
    if (metadata > 65536 || body > 25 * 1024 * 1024) {
      this.close();
      return;
    }
    if (this.buffer.length < 8 + metadata + body) return;
    const pending = this.pending;
    if (!pending) {
      this.close();
      return;
    }
    this.pending = undefined;
    clearTimeout(pending.timer);
    try {
      const meta: unknown = JSON.parse(this.buffer.subarray(8, 8 + metadata).toString("utf8"));
      const bytes = new Uint8Array(this.buffer.subarray(8 + metadata, 8 + metadata + body));
      this.buffer = this.buffer.subarray(8 + metadata + body);
      if (typeof meta === "object" && meta !== null && "error" in meta) {
        const code = String(meta.error);
        pending.reject(new Error(/^[a-z_]+$/.test(code) ? code : "native_failed"));
      } else pending.resolve({ meta, body: bytes });
    } catch {
      pending.reject(new Error("native_protocol"));
    }
  }
  call(command: Record<string, unknown>, body: Uint8Array = new Uint8Array()): Promise<NativeReply> {
    if (this.failed || this.pending) return Promise.reject(new Error("native_busy_or_unavailable"));
    const meta = Buffer.from(JSON.stringify(command));
    if (meta.length > 65536 || body.length > 25 * 1024 * 1024) return Promise.reject(new Error("frame_size"));
    const header = Buffer.alloc(8);
    header.writeUInt32BE(meta.length, 0);
    header.writeUInt32BE(body.length, 4);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: setTimeout(() => this.close(), 6 * 60_000) };
      this.child.stdin.write(Buffer.concat([header, meta, body]), (error) => {
        if (error) this.fail();
      });
    });
  }
  close() {
    this.fail();
    this.child.stdin.end();
    this.child.kill();
  }
}
