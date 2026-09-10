import type {
  AnyToolHandler,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Action, Modifier } from "@gmail-mcp/shared/actions";
import type { InlineAttachment } from "@gmail-mcp/shared/schemas";
import type { AuditFacts } from "../audit/log";
import type { Env } from "../env";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { resolveAccount, type AccountRef } from "./accounts";
import { decodeInline, intentArgs, type DecodedInline } from "./compose";
import { registerExecutor, replayIfKnown, resumeGated, runGated, type Executor, type ToolContext } from "./gate";
import { guarded, withAlias } from "./results";

export type Plan = {
  modifiers: Modifier[];
  summary: string;
  facts: AuditFacts;
  idempotencyKey?: string | undefined;
  build: () => Promise<{ payload: Record<string, unknown>; handles: string[] }>;
};

export type ToolSpec<S extends z.ZodObject<z.ZodRawShape> & StandardSchemaWithJSON> = {
  name: string;
  version: number;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  action: Action;
  journal: boolean;
  plan: (env: Env, t: ToolContext, account: AccountRef, args: z.infer<S>, inline: DecodedInline[]) => Promise<Plan>;
  execute: Executor;
};

/**
 * Every Gmail tool is registered through here so none can reach Gmail without the gate. The intent
 * hash covers what the client asked for and nothing the server generated, so a resume never re-plans:
 * what executes is the stored row, and the retried arguments only have to match the intent it came from.
 */
export function defineTool<S extends z.ZodObject<z.ZodRawShape> & StandardSchemaWithJSON>(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
  spec: ToolSpec<S>,
): void {
  registerExecutor(spec.name, spec.version, spec.execute);
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
    // The SDK derives the argument type from the schema, and S is a type parameter here, so the
    // derivation stays unresolved and nothing satisfies it. The handler takes the parsed arguments as
    // unknown and is named as the SDK's own handler type at the boundary.
    (async (args: unknown, ctx: ServerContext) => {
      const t = toolContext(ctx);
      return guarded(t, async () => {
        const a = args as Record<string, unknown> & { account?: string; inline_attachments?: InlineAttachment[] };
        const account = await resolveAccount(env, t.principal.userId, a.account);
        try {
          return await planAndRun(account, a);
        } catch (e) {
          throw withAlias(e, account.alias);
        }
      });

      async function planAndRun(
        account: AccountRef,
        a: Record<string, unknown> & { inline_attachments?: InlineAttachment[] },
      ) {
        const inline = await decodeInline(a.inline_attachments);
        const { account: _alias, ...rest } = intentArgs(a, inline);
        const intentHash = await hashCanonical(
          canonicalize({ tool: spec.name, v: spec.version, account: account.alias, args: rest }),
        );
        const state = t.round.requestState();
        if (state) return resumeGated(t, { tool: spec.name, account, intentHash, state });
        // Before planning, because a plan reads the staged handles and a replayed send's handles are
        // already consumed. A known key answers with what it did the first time and writes nothing.
        const idempotencyKey = typeof a.idempotency_key === "string" ? a.idempotency_key : undefined;
        const replayed = await replayIfKnown(t, { tool: spec.name, account, intentHash, idempotencyKey });
        if (replayed) return replayed;
        const plan = await spec.plan(env, t, account, args as z.infer<S>, inline);
        return runGated(t, {
          tool: spec.name,
          version: spec.version,
          action: spec.action,
          journal: spec.journal,
          account,
          intentHash,
          idempotencyKey: plan.idempotencyKey,
          modifiers: plan.modifiers,
          summary: plan.summary,
          facts: plan.facts,
          build: plan.build,
        });
      }
    }) as AnyToolHandler<S>,
  );
}
