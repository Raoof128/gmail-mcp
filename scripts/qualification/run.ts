export { RunReportV2, runV2Case, selectRunCase } from "./run-v2.ts";
export type { RunIdentity } from "./contracts.ts";
import { invokedAs, entry } from "./cli.ts";
if (invokedAs(import.meta.url)) await entry(["run", ...process.argv.slice(2)]);
