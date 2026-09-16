import { RestoreTarget, type VerifiedQuiescence } from "../contracts.ts";

/** No supported writer-exclusion mechanism has passed the feasibility gate yet. */
export class QuiescenceVerifier {
  async verify(input: unknown): Promise<VerifiedQuiescence> {
    RestoreTarget.parse(input);
    // A parsed record or operator assertion cannot exclude queued and cross-host writers.
    await Promise.resolve();
    throw new Error("quiescence_unavailable");
  }
}
