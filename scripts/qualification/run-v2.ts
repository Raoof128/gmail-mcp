import { z } from "zod";
import {
  CaseReport,
  CommonCases,
  RunIdentity,
  requiredProof,
  type CaseAdapter,
  type CaseId,
  type Controller,
  type VerifiedControllerContext,
} from "./contracts.ts";
export const RunReportV2 = z
  .object({
    version: z.literal(2),
    identity: RunIdentity,
    report: CaseReport,
    exitCode: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
export function selectRunCase(input: RunIdentity, caseIds: readonly CaseId[]): CaseId {
  const identity = RunIdentity.parse(input);
  const selected = caseIds[0];
  if (
    caseIds.length !== 1 ||
    !selected ||
    (identity.purpose === "recovery-mode"
      ? selected !== requiredProof(identity.mode!)
      : !CommonCases.some((id) => id === selected))
  )
    throw new Error("case selection refused");
  return selected;
}
export async function runV2Case(
  context: VerifiedControllerContext,
  caseIds: readonly CaseId[],
  controller: Controller,
  adapter: CaseAdapter,
  port: { write(report: CaseReport): Promise<void> },
): Promise<z.infer<typeof RunReportV2>> {
  const identity = RunIdentity.parse(context.identity);
  const caseId = selectRunCase(identity, caseIds);
  const report = CaseReport.parse(await adapter.run(context, caseId, controller));
  if (report.caseId !== caseId || JSON.stringify(report.identity) !== JSON.stringify(identity))
    throw new Error("identity_drift");
  await port.write(report);
  return RunReportV2.parse({ version: 2, identity, report, exitCode: report.result === "pass" ? 0 : 1 });
}
