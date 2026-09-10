import { describe, it, expect } from "vitest";
import { escapeHtml, escapeVisible, htmlResponse, redirect, PAGE_HEADERS } from "../src/web/html";
import { staticHandler } from "../src/web/static";

describe("html primitives", () => {
  it("escapes the five entities", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
  it("renders bidi and control characters as visible escapes", () => {
    expect(escapeVisible("thesis\u202Efdp.exe")).toBe("thesis\\u{202E}fdp.exe");
    expect(escapeVisible("a\u0000b\u2066c")).toBe("a\\u{0}b\\u{2066}c");
    expect(escapeVisible("<b>")).toBe("&lt;b&gt;");
  });
  it("page responses carry the security headers and no-store", async () => {
    const res = htmlResponse("T", "<p>x</p>");
    const withClient = htmlResponse("T", "<p>x</p>", 200, ["http://localhost:5555"]);
    expect(withClient.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://accounts.google.com http://localhost:5555",
    );
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(PAGE_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain('<link rel="stylesheet" href="/static/app.css">');
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/ style=/i);
  });
  it("redirect only accepts internal paths", () => {
    expect(redirect("/accounts").headers.get("location")).toBe("/accounts");
    expect(redirect("/accounts").status).toBe(303);
    expect(() => redirect("https://evil.test/")).toThrow();
    expect(() => redirect("//evil.test/")).toThrow();
    expect(() => redirect("/\\evil.test")).toThrow();
  });
  it("serves the stylesheet with nosniff and no-store", () => {
    const res = staticHandler(new Request("https://x.test/static/app.css"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(staticHandler(new Request("https://x.test/static/other.css"))).toBeNull();
  });
});
