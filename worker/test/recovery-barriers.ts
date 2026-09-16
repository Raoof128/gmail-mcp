/** Deterministic test-only pauses. Production code has no fault selector or remote control. */
export type BarrierPoint =
  | "bound"
  | "reserved"
  | "mime-start"
  | "headers"
  | "partial-body"
  | "provider-commit"
  | "response"
  | "settlement-statement"
  | "settlement-commit"
  | "disable"
  | "reconnect";
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export class RecoveryBarriers {
  private readonly pauses = new Map<
    BarrierPoint,
    { arrival: ReturnType<typeof latch>; resume: ReturnType<typeof latch> }
  >();
  hold(point: BarrierPoint): void {
    if (this.pauses.has(point)) throw new Error("barrier already held");
    this.pauses.set(point, { arrival: latch(), resume: latch() });
  }
  async barrier(point: BarrierPoint): Promise<void> {
    const pause = this.pauses.get(point);
    if (!pause) return;
    pause.arrival.resolve();
    await pause.resume.promise;
  }
  reached(point: BarrierPoint): Promise<void> {
    const pause = this.pauses.get(point);
    if (!pause) throw new Error("barrier not held");
    return pause.arrival.promise;
  }
  release(point: BarrierPoint): void {
    const pause = this.pauses.get(point);
    if (!pause) throw new Error("barrier not held");
    pause.resume.resolve();
  }
}
