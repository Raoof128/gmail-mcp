export const PAGE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  pragma: "no-cache",
  // Not no-referrer, which would be the stricter-looking choice. Under that policy a browser
  // serialises the Origin of its own same-origin, non-CORS POST as the string "null", and
  // checkOrigin refuses "null", so every form on these pages refused itself. same-origin sends no
  // referrer off this origin, which is the property no-referrer was chosen for, and keeps the
  // Origin header that the CSRF defence reads.
  "referrer-policy": "same-origin",
  // form-action also governs where a form submission may be *redirected* (Chrome enforces this),
  // so the identity provider is listed: /reauth and /connect answer a form post with a 303 to Google.
  "content-security-policy":
    "default-src 'none'; style-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
};

/** Page headers with additional form-action origins, for the consent page's redirect back to the client. */
export function pageHeaders(extraFormActions: string[] = []): Record<string, string> {
  if (extraFormActions.length === 0) return PAGE_HEADERS;
  const csp = PAGE_HEADERS["content-security-policy"]!.replace(
    "form-action 'self' https://accounts.google.com",
    `form-action 'self' https://accounts.google.com ${extraFormActions.join(" ")}`,
  );
  return { ...PAGE_HEADERS, "content-security-policy": csp };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The same class limits.ts uses: control characters and the bidi overrides and isolates. Matching
// them is the point, so the lint rule is off for this one line.
// eslint-disable-next-line no-control-regex
const VISIBLE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** For anything an email could have written. Escapes HTML, then shows control and bidi code points as text. */
export function escapeVisible(s: string): string {
  return escapeHtml(s).replace(VISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);
}

export type Chrome = { logoutCsrf: string; reauthCsrf: string } | null;

// The nav marks its own page so the current section is legible without a script. Matching on the
// title is enough because these three pages title themselves after their link.
const NAV: readonly (readonly [string, string])[] = [
  ["/accounts", "Accounts"],
  ["/policy", "Policy"],
  ["/audit", "Audit"],
];

export function layout(title: string, body: string, chrome: Chrome): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · gmail-mcp</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>${NAV.map(([href, label]) => `<a href="${href}"${label === title ? ' aria-current="page"' : ""}>${label}</a>`).join(" ")}
${
  chrome
    ? `<form method="post" action="/reauth" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(chrome.reauthCsrf)}"><button>Re-authenticate</button></form>
<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(chrome.logoutCsrf)}"><button>Log out</button></form>`
    : ""
}</header>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

export function htmlResponse(
  title: string,
  body: string,
  chrome: Chrome,
  status = 200,
  extraFormActions: string[] = [],
): Response {
  return new Response(layout(title, body, chrome), {
    status,
    headers: { ...pageHeaders(extraFormActions), "content-type": "text/html; charset=utf-8" },
  });
}

/** Redirects stay on this origin. Anything that could leave it is a programming error, not a request error. */
export function redirect(location: string): Response {
  if (!isInternalPath(location)) throw new Error(`refusing external redirect: ${location}`);
  return new Response(null, { status: 303, headers: { ...PAGE_HEADERS, location } });
}

// A URL parser strips tab, CR and LF from anywhere in a reference before resolving it, so checking
// only the character after the leading slash is not enough: "/\t//evil.test" passes that check and
// then resolves to https://evil.test. Matching the control range is the point, so the rule is off here.
// eslint-disable-next-line no-control-regex
const CONTROL_IN_PATH = /[\u0000-\u001f\u007f]/;

export function isInternalPath(p: string): boolean {
  return /^\/(?![/\\])/.test(p) && !CONTROL_IN_PATH.test(p);
}
