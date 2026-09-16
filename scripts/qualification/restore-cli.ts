import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { invokedAs } from "./cli.ts";
import { createPrivateSink, readPrivateJson } from "./private-files.ts";
import { prepareRestore } from "./controllers/restore.ts";

export async function main(args: string[]): Promise<number> {
  const [flag, path, ...extra] = args;
  if (flag !== "--manifest" || !path || extra.length) throw new Error("usage: --manifest private-path");
  const sink = await createPrivateSink(dirname(path));
  const receipt = await prepareRestore(await readPrivateJson(path), sink);
  await sink.write(`restore-preparation-${randomUUID()}.json`, receipt);
  return 1;
}
if (invokedAs(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write("restore preparation refused; inspect private inputs\n");
    process.exitCode = 1;
  }
}
