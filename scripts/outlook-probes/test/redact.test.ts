import { describe, expect, it } from "vitest";
import { CONSUMER_TID, hashId, idCharset, redact, shapePath } from "../redact.ts";

describe("redact", () => {
  it("removes addresses, tenant ids and opaque runs, and keeps the public consumer tenant", () => {
    const out = redact(
      `mail for a.b+c@uni.edu.au in tenant 72f988bf-86f1-41af-91ab-2d7cd011db47 (${CONSUMER_TID}) id AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZi=`,
    );
    expect(out).not.toContain("uni.edu.au");
    expect(out).not.toContain("72f988bf");
    expect(out).toContain(CONSUMER_TID);
    expect(out).toMatch(/<opaque:\d+>/);
  });

  it("truncates long text", () => {
    expect(redact("a ".repeat(400), 20)).toHaveLength(21);
  });
});

describe("shapePath", () => {
  it("replaces id segments and keeps the route", () => {
    expect(
      shapePath("/v1.0/me/messages/AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZi=/attachments/AAMkAGUzY5QKjAAABEgAQ="),
    ).toBe("/v1.0/me/messages/{id}/attachments/{id}");
    expect(shapePath("/api/v2.0/Users('abc')/Messages('def')")).toBe("/api/v2.0/Users('{id}')/Messages('{id}')");
  });

  it("keeps parameter names and drops literal values and tokens", () => {
    const shaped = shapePath(
      `/v1.0/me/messages?$filter=${encodeURIComponent("internetMessageId eq '<x@y.z>'")}&$search=${encodeURIComponent('"hello"')}&$deltatoken=abc&authtoken=xyz&includeHiddenFolders=true`,
    );
    expect(shaped).toContain("$filter=internetMessageId eq '…'");
    expect(shaped).toContain('$search="…"');
    expect(shaped).toContain("$deltatoken=<opaque>");
    expect(shaped).toContain("authtoken=<opaque>");
    expect(shaped).toContain("includeHiddenFolders=<value>");
    expect(shaped).not.toContain("x@y.z");
  });
});

describe("idCharset", () => {
  it("reports the classes an id set uses", () => {
    const c = idCharset(["AAMk_x-1=", "Zz9"]);
    expect(c).toEqual({
      count: 2,
      maxLength: 9,
      minLength: 3,
      classes: ["-", "0-9", "=", "A-Z", "_", "a-z"],
      others: [],
    });
    expect(idCharset([]).minLength).toBe(0);
    expect(idCharset(["a+b/c"]).classes).toEqual(expect.arrayContaining(["+", "/"]));
  });
});

describe("hashId", () => {
  it("is short, stable and not the id", () => {
    expect(hashId("AAMk=")).toMatch(/^[0-9a-f]{12}$/);
    expect(hashId("AAMk=")).toBe(hashId("AAMk="));
    expect(hashId("AAMk=")).not.toBe(hashId("AAMl="));
  });
});
