/**
 * Everything that reaches outside the Worker, and every wait the Worker takes, goes through here so
 * a test can stand in for Google and collapse time. Production uses the platform unchanged.
 */
export type Deps = {
  googleFetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Spec 1.4: poll the pending row every interval, up to the deadline, inside one tools/call. */
  approvalWait: { intervalMs: number; deadlineMs: number };
};

export const defaultDeps: Deps = {
  googleFetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  approvalWait: { intervalMs: 2000, deadlineMs: 120_000 },
};
