import { dirname } from "node:path";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Observation, RunIdentity, identityHash } from "../contracts.ts";
import { QualificationSource } from "../contracts-validation.ts";
import { createPrivateSink, readPrivateJson } from "../private-files.ts";

/** Imports one attributed observation. It performs no login, native mutation or power operation. */
export async function importDeviceObservation(path: string, expected: Readonly<RunIdentity>): Promise<Observation> {
  const identity = RunIdentity.parse(expected);
  const observation = Observation.parse(await readPrivateJson(path));
  const source = QualificationSource.parse(
    await (
      await createPrivateSink(dirname(path))
    ).read({
      name: `source-${observation.sourceSha256}.json`,
      sha256: observation.sourceSha256,
    }),
  );
  const { sourceSha256: _source, ...projection } = observation;
  const producer =
    observation.details.caseId === "physical-durability"
      ? "power-operator"
      : observation.details.caseId === "installed-clients"
        ? "installed-client-operator"
        : observation.details.caseId === "native"
          ? "native-helper"
          : null;
  if (
    identity.purpose !== "release-component" ||
    producer === null ||
    source.producer !== producer ||
    observation.surface !== (producer === "installed-client-operator" ? "installed-client" : "device") ||
    observation.identitySha256 !== identityHash("run", identity, canonicalize) ||
    observation.recordedAt < identity.startedAt ||
    source.identitySha256 !== observation.identitySha256 ||
    source.sampleId !== observation.sampleId ||
    source.recordedAt !== observation.recordedAt ||
    canonicalize(source.observation) !== canonicalize(projection)
  )
    throw new Error("invalid_evidence");
  return observation;
}
