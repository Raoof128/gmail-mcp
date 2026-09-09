import { describe, it, expect } from "vitest";
import { parseAddress, isTrusted, recipientModifiers } from "../src/policy/recipients";

const consumer = { selfAddresses: ["raouf@gmail.com"], allowlist: ["Friend@example.com", "@uni.edu.au"], orgDomains: [] };
const workspace = { selfAddresses: ["me@corp.example"], allowlist: [], orgDomains: ["corp.example"] };

describe("parseAddress", () => {
  it("parses bare and display-name forms, lower-casing only the domain", () => {
    expect(parseAddress("A B <A.b@Example.COM>").normalized).toBe("A.b@example.com");
    expect(parseAddress("x@y.test").domain).toBe("y.test");
  });
  it("normalises gmail local parts only", () => {
    expect(parseAddress("Raouf+news@gmail.com").normalized).toBe("raouf@gmail.com");
    expect(parseAddress("ra.ouf@gmail.com").normalized).toBe("ra.ouf@gmail.com");
    expect(parseAddress("Someone+tag@example.com").normalized).toBe("Someone+tag@example.com");
  });
  it("converts IDN domains to punycode", () => {
    expect(parseAddress("a@bücher.example").domain).toBe("xn--bcher-kva.example");
  });
  it("rejects malformed, control characters, dot abuse and multiple addresses", () => {
    for (const bad of ["nope", "a@b@c", "a@b.test\r\nBcc: x@y", "a@b.test, c@d.test", "<a@b.test", ".a@b.test", "a.@b.test", "a..b@b.test", "\"quoted\"@b.test", "a@b"]) {
      expect(() => parseAddress(bad), bad).toThrow(/invalid_address/);
    }
  });
});

describe("isTrusted", () => {
  it("consumer: self, allowlist entries, exact allowlisted domain", () => {
    expect(isTrusted(parseAddress("raouf@gmail.com"), consumer)).toBe(true);
    expect(isTrusted(parseAddress("someone@gmail.com"), consumer)).toBe(false);
    expect(isTrusted(parseAddress("Friend@example.com"), consumer)).toBe(true);
    expect(isTrusted(parseAddress("friend@example.com"), consumer)).toBe(false);
    expect(isTrusted(parseAddress("prof@uni.edu.au"), consumer)).toBe(true);
    expect(isTrusted(parseAddress("prof@evil-uni.edu.au"), consumer)).toBe(false);
    expect(isTrusted(parseAddress("prof@sub.uni.edu.au"), consumer)).toBe(false);
  });
  it("workspace: org domains are internal", () => {
    expect(isTrusted(parseAddress("colleague@corp.example"), workspace)).toBe(true);
    expect(isTrusted(parseAddress("colleague@corp.example.evil"), workspace)).toBe(false);
  });
});

describe("recipientModifiers", () => {
  it("adds +external when any recipient is untrusted", () => {
    expect(recipientModifiers(["raouf@gmail.com", "stranger@x.test"], consumer)).toEqual(["+external"]);
    expect(recipientModifiers(["raouf@gmail.com"], consumer)).toEqual([]);
  });
  it("adds +bulk above 10 distinct recipients", () => {
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@uni.edu.au`);
    expect(recipientModifiers(many, consumer)).toEqual(["+bulk"]);
    const dup = Array.from({ length: 11 }, () => "p@uni.edu.au");
    expect(recipientModifiers(dup, consumer)).toEqual([]);
  });
  it("rejects more than 500 raw recipients even when they repeat", () => {
    const tooMany = Array.from({ length: 501 }, () => "p@uni.edu.au");
    expect(() => recipientModifiers(tooMany, consumer)).toThrow(/limit_exceeded/);
  });
});
