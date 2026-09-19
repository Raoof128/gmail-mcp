import { DEFAULT_POLICY } from "@gmail-mcp/shared/actions";
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
// Appended from the action's default level rather than written into each description, so the 38
// tools cannot drift apart on the one thing an agent most needs to know. A sweep of all of them
// found that not one said what pending_approval means or what to do next.
const APPROVAL_NOTE =
  " Approval-gated by default: the result is status pending_approval carrying approval.url and action_id. The owner opens that URL; call execute_pending with the action_id once they approve, or cancel_pending to withdraw it. get_policy shows the levels actually in force.";

export function defineTool<S extends z.ZodObject<z.ZodRawShape> & StandardSchemaWithJSON>(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
  spec: ToolSpec<S>,
): void {
  registerExecutor(spec.name, spec.version, spec.execute);
  server.registerTool(
    spec.name,
    // Strict, centrally, so no tool can be registered without it. zod strips unknown keys by
    // default, which made a misspelled argument a silent nothing: a send_message carrying `text`
    // rather than `body` was accepted and queued with no body at all, and the approval page
    // truthfully showed an empty message. Measured on the first live send this system ever made.
    // It also puts additionalProperties: false in the advertised schema, so a client can catch the
    // mistake before spending a call. Hashing is unaffected: the intent hash covers parsed
    // arguments, and a key that used to be dropped now never reaches the parse at all.
    {
      description: spec.description + (DEFAULT_POLICY[spec.action] === "ask" ? APPROVAL_NOTE : ""),
      inputSchema: spec.input.strict() as typeof spec.input,
      annotations: spec.annotations,
    },
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
