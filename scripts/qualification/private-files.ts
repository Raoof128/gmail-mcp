import { ArtifactRef, parsePrivateArtifact, type PrivateSink } from "./contracts.ts";
import { constants } from "node:fs";
import { lstat, open, realpath, link, unlink } from "node:fs/promises";
import { dirname, resolve, join, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
const refuse = () => new Error("private artifact path refused");
export const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  if ((await realpath(absolute)) !== absolute) throw refuse();
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw refuse();
  const attachments = join(homedir(), ".codex", "attachments");
  if (absolute === attachments || absolute.startsWith(attachments + sep)) throw refuse();
  for (let current = absolute; ; current = dirname(current)) {
    if (
      await lstat(join(current, ".git")).then(
        () => true,
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw refuse();
        },
      )
    )
      throw refuse();
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw refuse();
    // Sticky root-owned temporary roots protect children from other users; writable ordinary parents do not.
    if ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0)) throw refuse();
    if (dirname(current) === current) break;
  }
  return absolute;
}
export async function readPrivateBytes(path: string): Promise<Buffer> {
  const dir = await privateDirectory(dirname(path));
  const absolute = resolve(path);
  if (dirname(absolute) !== dir) throw refuse();
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0 || s.size > 65536) throw refuse();
    // Bound the allocation even if an owner process grows the file after stat.
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length > 65536 || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs)
      throw refuse();
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}
export async function readPrivateJson(path: string): Promise<unknown> {
  return parsePrivateArtifact(await readPrivateBytes(path));
}
export async function writePrivateJson(directory: string, name: string, value: unknown): Promise<string> {
  const dir = await privateDirectory(directory);
  if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) throw refuse();
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > 65536) throw new Error("artifact too large");
  const final = join(dir, name);
  if (
    await lstat(final).then(
      () => true,
      () => false,
    )
  )
    throw new Error("artifact already exists");
  const temp = join(dir, `.${randomUUID()}.tmp`);
  const file = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    // Hard-link publication is atomic and fails if another writer won. Rename would overwrite.
    await link(temp, final);
    await unlink(temp);
    const parent = await open(dir, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return digest(bytes);
}

/** Owns path and byte-hash verification; consumers receive only bounded parsed artifacts. */
export async function createPrivateSink(directory: string): Promise<PrivateSink> {
  const dir = await privateDirectory(directory);
  return {
    write: async (name, value) => {
      ArtifactRef.shape.name.parse(name);
      parsePrivateArtifact(Buffer.from(JSON.stringify(value) + "\n"));
      return { name, sha256: await writePrivateJson(dir, name, value) };
    },
    read: async (input) => {
      const ref = ArtifactRef.parse(input);
      const bytes = await readPrivateBytes(join(dir, ref.name));
      if (digest(bytes) !== ref.sha256) throw new Error("artifact digest changed");
      return parsePrivateArtifact(bytes);
    },
  };
}
