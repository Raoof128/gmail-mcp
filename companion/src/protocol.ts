export type NativeReply = { meta: unknown; body: Uint8Array<ArrayBuffer> };
export interface NativePort {
  call(command: Record<string, unknown>, body?: Uint8Array): Promise<NativeReply>;
  close(): void;
}
