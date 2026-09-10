import { PAGE_HEADERS } from "./html";

/** One stylesheet, served from this origin because the CSP allows nothing else. */
export const CSS = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; max-width: 60rem; padding: 1rem; }
header { display: flex; gap: 1rem; align-items: center; border-bottom: 1px solid #8884; padding-bottom: .5rem; }
header form.inline { margin-left: auto; }
main h1 { font-size: 1.4rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #8884; padding: .3rem .5rem; text-align: left; vertical-align: top; }
.untrusted { border: 3px dashed #c33; padding: .5rem; margin: 1rem 0; white-space: pre-wrap; font-family: ui-monospace, monospace; }
.untrusted-label { color: #c33; font-weight: bold; }
.approve { background: #2a7; color: #fff; }
.deny { background: #c33; color: #fff; }
.danger { border: 2px solid #c33; }
.muted { opacity: .7; }
form.inline { display: inline; }
`;

export function staticHandler(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/static/app.css") return null;
  return new Response(CSS, {
    headers: { ...PAGE_HEADERS, "content-type": "text/css; charset=utf-8" },
  });
}
