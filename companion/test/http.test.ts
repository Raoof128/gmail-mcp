import { it, expect, vi } from "vitest";
import { Authority, validateCallback } from "../src/http.ts";
it("requires exact state and issuer and rejects duplicate security parameters", () => {
  const origin = "https://worker.example.test",
    redirect = "http://127.0.0.1:61234/callback";
  const url = redirect + "?code=one&state=state&iss=" + encodeURIComponent(origin);
  expect(validateCallback(url, redirect, "state", origin)).toBe("one");
  for (const bad of [
    url + "&code=two",
    url + "&iss=" + encodeURIComponent(origin),
    url.replace("state=state", "state=wrong"),
    url.replace(encodeURIComponent(origin), encodeURIComponent(origin + "/")),
  ])
    expect(() => validateCallback(bad, redirect, "state", origin)).toThrow();
  expect(() => validateCallback(redirect + "?code=one&state=state", redirect, "state", origin)).toThrow();
});
it("disables redirects for authenticated calls and bounds control bodies", async () => {
  // eslint-disable-next-line @typescript-eslint/require-await -- This test double implements an async interface.
  const fetcher = vi.fn(async (_url: any, init: any) => {
    expect(init.redirect).toBe("error");
    return new Response("x".repeat(65537));
  });
  const api = new Authority("https://worker.example.test", fetcher);
  await expect(api.json("/staging/identity", "test-only")).rejects.toThrow(/response_size/);
  expect(fetcher).toHaveBeenCalledOnce();
  await expect(api.json("https://other.test/", "test-only")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});
