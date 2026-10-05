import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { checkAuthority, interactiveLogin, refresh, type AuthConfig, type TokenSet } from "./auth.ts";
import { Recorder, writeRun, type ProbeRecord, type RunRecord } from "./evidence.ts";
import { GraphClient, Refused, str, type Gate } from "./graph.ts";
import { MANUAL_PROBES, PROBES, ProbeFailed, type Kind, type Probe, type ProbeContext } from "./probes.ts";
import { redact } from "./redact.ts";

export interface Config {
  auth: AuthConfig;
  probes: string[];
  out: string;
  allowMutation: boolean;
  allowDestructive: boolean;
  allowLoad: boolean;
  allowExternalForward: boolean;
  confirmMailbox?: string;
  forwardTarget?: string;
  pollIntervalMs: number;
  pollLimitMs: number;
}

const USAGE = `Usage: node cli.ts --authority <consumers|tenant-id> --client-id <id> [options]

  --probes <list>              comma-separated probe ids, or "all" (default: all)
  --out <dir>                  evidence directory (default: probe-evidence)
  --port <n>                   loopback port registered as the redirect URI (default: 8400)
  --allow-mutation             create drafts, send to the account itself, edit categories
  --confirm-mailbox <address>  required with --allow-mutation; must equal the signed-in mailbox
  --allow-destructive          P4 only: DELETE on drafts this run created
  --allow-load                 P10: bursts of up to 16 concurrent reads
  --allow-external-forward     P15: a forwarding rule to --forward-target, removed afterwards
  --forward-target <address>   a mailbox you control outside this account
  --poll-limit-seconds <n>     how long to wait for a sent copy or an NDR (default: 180)

Run only against a throwaway mailbox you own. Nothing is written but the redacted evidence file.`;

export function parseConfig(argv: string[]): Config {
  const { values } = parseArgs({
    args: argv,
    options: {
      authority: { type: "string" },
      "client-id": { type: "string" },
      probes: { type: "string", default: "all" },
      out: { type: "string", default: "probe-evidence" },
      port: { type: "string", default: "8400" },
      "allow-mutation": { type: "boolean", default: false },
      "allow-destructive": { type: "boolean", default: false },
      "allow-load": { type: "boolean", default: false },
      "allow-external-forward": { type: "boolean", default: false },
      "confirm-mailbox": { type: "string" },
      "forward-target": { type: "string" },
      "poll-limit-seconds": { type: "string", default: "180" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help || values.authority == null || values["client-id"] == null) throw new UsageError(USAGE);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UsageError("--port must be 1024 to 65535");
  const limit = Number(values["poll-limit-seconds"]);
  if (!Number.isFinite(limit) || limit < 10 || limit > 1800)
    throw new UsageError("--poll-limit-seconds must be 10 to 1800");
  const known = new Set(PROBES.map((p) => p.id));
  const probes = values.probes === "all" ? [...known] : values.probes.split(",").map((s) => s.trim());
  const unknown = probes.filter((p) => !known.has(p) && !(p in MANUAL_PROBES));
  if (unknown.length > 0) throw new UsageError(`unknown probe ids: ${unknown.join(", ")}`);
  const cfg: Config = {
    auth: { authority: checkAuthority(values.authority), clientId: values["client-id"], port },
    probes,
    out: values.out,
    allowMutation: values["allow-mutation"],
    allowDestructive: values["allow-destructive"],
    allowLoad: values["allow-load"],
    allowExternalForward: values["allow-external-forward"],
    pollIntervalMs: 3_000,
    pollLimitMs: limit * 1000,
  };
  if (values["confirm-mailbox"] != null) cfg.confirmMailbox = values["confirm-mailbox"];
  if (values["forward-target"] != null) cfg.forwardTarget = values["forward-target"];
  return cfg;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Why a probe may not run under this configuration, or null when it may. */
export function blockedBy(kind: Kind, cfg: Config): string | null {
  switch (kind) {
    case "read":
    case "token":
      return null;
    case "load":
      return cfg.allowLoad ? null : "needs --allow-load";
    case "mutation":
      return cfg.allowMutation ? null : "needs --allow-mutation";
    case "destructive":
      return cfg.allowMutation && cfg.allowDestructive ? null : "needs --allow-mutation and --allow-destructive";
    case "external":
      if (!cfg.allowMutation || !cfg.allowExternalForward) return "needs --allow-mutation and --allow-external-forward";
      return cfg.forwardTarget == null ? "needs --forward-target" : null;
  }
}

export interface Deps {
  fetch: typeof fetch;
  login: (cfg: AuthConfig) => Promise<TokenSet>;
  print: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Defaults to writing the evidence file; tests capture the record instead. */
  write?: (run: RunRecord) => string;
  evidenceKind?: RunRecord["evidenceKind"];
}

export async function execute(cfg: Config, deps: Deps): Promise<RunRecord> {
  const runTag = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  const gate: Gate = { allowMutation: cfg.allowMutation, allowDestructive: cfg.allowDestructive };
  const run: RunRecord = {
    harness: "outlook-probes",
    version: 1,
    runTag,
    startedAt: new Date().toISOString(),
    authorityKind: cfg.auth.authority === "consumers" ? "consumers" : "tenant",
    gates: {
      allowMutation: cfg.allowMutation,
      allowDestructive: cfg.allowDestructive,
      allowLoad: cfg.allowLoad,
      allowExternalForward: cfg.allowExternalForward,
    },
    evidenceKind: deps.evidenceKind ?? "live",
    probes: [],
  };

  let tokens = await deps.login(cfg.auth);
  const first = tokens;
  const graph = new GraphClient(() => Promise.resolve(tokens.accessToken), gate, deps.fetch);

  const me = await graph.call("GET", "/v1.0/me?$select=mail,userPrincipalName");
  const self = str(me.body, "mail") ?? str(me.body, "userPrincipalName");
  if (self == null) throw new Error("could not read the signed-in mailbox address");
  if (cfg.allowMutation && cfg.confirmMailbox?.toLowerCase() !== self.toLowerCase()) {
    throw new UsageError("--confirm-mailbox must equal the signed-in mailbox before anything is changed");
  }
  if (cfg.forwardTarget != null && cfg.forwardTarget.toLowerCase() === self.toLowerCase()) {
    throw new UsageError("--forward-target must be a different mailbox");
  }

  for (const id of cfg.probes) {
    const startedAt = new Date().toISOString();
    if (id in MANUAL_PROBES) {
      run.probes.push(skipped(id, "manual", MANUAL_PROBES[id] ?? "", startedAt));
      continue;
    }
    const probe = PROBES.find((p) => p.id === id) as Probe;
    const blocked = blockedBy(probe.kind, cfg);
    if (blocked != null) {
      run.probes.push(skipped(probe.id, probe.kind, blocked, startedAt, probe.title));
      deps.print(`${probe.id}  skipped  ${blocked}`);
      continue;
    }
    const rec = new Recorder();
    const from = graph.exchanges.length;
    const ctx: ProbeContext = {
      graph,
      rec,
      runTag,
      self,
      opts: {
        pollIntervalMs: cfg.pollIntervalMs,
        pollLimitMs: cfg.pollLimitMs,
        ...(cfg.forwardTarget == null ? {} : { forwardTarget: cfg.forwardTarget }),
      },
      sleep: deps.sleep,
      firstTokens: first,
    };
    if (tokens.refreshToken != null) {
      const rt = tokens.refreshToken;
      ctx.refresh = async () => {
        tokens = await refresh(cfg.auth, rt, deps.fetch);
        return tokens;
      };
    }
    const t0 = Date.now();
    const record: ProbeRecord = {
      id: probe.id,
      title: probe.title,
      kind: probe.kind,
      outcome: "observed",
      startedAt,
      ms: 0,
      facts: {},
      exchanges: [],
    };
    try {
      await probe.run(ctx);
    } catch (e) {
      record.outcome = e instanceof Refused ? "refused" : "error";
      record.reason = redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      if (!(e instanceof Refused || e instanceof ProbeFailed)) deps.print(`${probe.id}  unexpected error`);
    }
    record.ms = Date.now() - t0;
    record.facts = rec.snapshot();
    record.exchanges = graph.exchanges.slice(from);
    run.probes.push(record);
    deps.print(`${probe.id}  ${record.outcome}${record.reason ? `  ${record.reason}` : ""}`);
  }

  const created = graph.created.size;
  if (created > 0) {
    deps.print(
      `\nThis run left ${created} probe item(s) in the mailbox, each with "[probe ${runTag}]" in the subject.`,
    );
  }
  const file = (deps.write ?? ((r) => writeRun(cfg.out, r)))(run);
  deps.print(`Evidence written to ${file}`);
  return run;
}

function skipped(id: string, kind: string, reason: string, startedAt: string, title = id): ProbeRecord {
  return { id, title, kind, outcome: "skipped", reason, startedAt, ms: 0, facts: {}, exchanges: [] };
}

async function main(): Promise<void> {
  const print = (line: string) => void process.stdout.write(`${line}\n`);
  let cfg: Config;
  try {
    cfg = parseConfig(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
    return;
  }
  await execute(cfg, {
    fetch,
    login: (auth) => interactiveLogin(auth, print),
    print,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(`${redact(e instanceof Error ? e.message : String(e))}\n`);
    process.exitCode = 1;
  });
}
