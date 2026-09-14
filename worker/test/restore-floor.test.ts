import { expect, it } from "vitest";
import { testEnv } from "./test-env";
import { assertInstallation } from "../src/operations/installation";
import { createWorker } from "../src/index";
import { createExecutionContext } from "cloudflare:test";
const e = testEnv();
it("refuses a restored old generation and a frozen current marker", async () => {
  await e.DB.prepare("DELETE FROM recovery_installation").run();
  await expect(assertInstallation(e)).rejects.toThrow();
  await e.DB.prepare("INSERT INTO recovery_installation VALUES(1,5,'old','active')").run();
  await expect(assertInstallation(e)).rejects.toThrow();
  await e.DB.prepare("UPDATE recovery_installation SET restore_generation=?,mutation_state='frozen'")
    .bind(e.RESTORE_GENERATION)
    .run();
  await expect(assertInstallation(e)).rejects.toThrow();
});
it("maintenance refuses OAuth and MCP mutation ingress without contacting providers", async () => {
  let calls = 0;
  const worker = createWorker({
    googleFetch: () => {
      calls++;
      return Promise.reject(new Error("must not call"));
    },
    sleep: () => Promise.resolve(),
    approvalWait: { intervalMs: 1, deadlineMs: 1 },
  });
  for (const path of ["/mcp", "/register", "/token", "/connect/callback", "/staging/intent"]) {
    const res = await worker.fetch(
      new Request(`https://${e.WORKER_HOSTNAME}${path}`, { method: "POST" }),
      e,
      createExecutionContext(),
    );
    expect(res.status).toBe(503);
  }
  expect(calls).toBe(0);
  const health = await worker.fetch(new Request(`https://${e.WORKER_HOSTNAME}/healthz`), e, createExecutionContext());
  expect(await health.json()).toEqual({ status: "maintenance" });
});
it("stamps health and maintenance responses with the serving identity", async () => {
  const worker = createWorker();
  const response = await worker.fetch(new Request(`https://${e.WORKER_HOSTNAME}/healthz`), e, createExecutionContext());
  expect(response.headers.get("x-recovery-build")).toBe(e.BUILD_ID);
});
