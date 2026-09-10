/**
 * Everything that reaches outside the Worker goes through here so a test can stand in for Google
 * without a network. Production uses the platform fetch unchanged.
 */
export type Deps = { googleFetch: typeof fetch };

export const defaultDeps: Deps = { googleFetch: (input, init) => fetch(input, init) };
