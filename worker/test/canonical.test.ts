import { describe, it, expect } from "vitest";
import { canonicalize, hashCanonical } from "../src/crypto/canonical";

/** RFC 8785 section 3.2.3 test vector, built from code points so the source holds no control characters. */
const RFC_STRING = String.fromCharCode(0x20ac, 0x24, 0xf, 0xa, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f);

describe("JCS canonicalize", () => {
  it("matches the RFC 8785 example", () => {
    const input = {
      // eslint-disable-next-line no-loss-of-precision -- the RFC vector asserts this rounding
      numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
      string: RFC_STRING,
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });
  it("sorts keys by UTF-16 code units", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], é: 0, z: 0 })).toBe('{"a":[true,null,"x"],"b":1,"z":0,"é":0}');
  });
  it("rejects non I-JSON input instead of guessing", () => {
    expect(() => canonicalize({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalize([1, undefined])).toThrow(TypeError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalize({ n: NaN })).toThrow(TypeError);
    expect(() => canonicalize({ d: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalize({ s: String.fromCharCode(0xd800) })).toThrow(TypeError);
    expect(() => canonicalize({ b: 1n })).toThrow(TypeError);
  });
  it("hashes the exact stored string", async () => {
    const c1 = canonicalize({ to: ["a@x.test"], subject: "s" });
    const c2 = canonicalize({ subject: "s", to: ["a@x.test"] });
    expect(c1).toBe(c2);
    expect(await hashCanonical(c1)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashCanonical(c1)).toBe(await hashCanonical(c2));
  });
});
