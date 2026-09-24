import { PAGE_HEADERS } from "./html";

/** One stylesheet, served from this origin because the CSP allows nothing else. */
export const CSS = `
/* gmail-mcp owner console.
   The CSP is default-src 'none'; style-src 'self', so there is no script, no webfont and no image
   here by design: every texture below is drawn with gradients and every face is one the machine
   already has. The look is an audit ledger rather than a dashboard, because that is what these
   pages are: a record of who was trusted with what, and a place to refuse. Saturated colour is
   spent only on risk, so that when something is red it means something. */

:root {
  color-scheme: light dark;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", Georgia, serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;

  --paper: #f2efe7;
  --panel: #fbfaf6;
  --sunk: #e9e5da;
  --ink: #191b1f;
  --ink-2: #5a5e67;
  --ink-3: #8d9099;
  --rule: #d9d4c6;
  --rule-hard: #b9b2a0;
  --grid: #00000008;

  --danger: #9a2b20;
  --danger-on: #fffaf9;
  --danger-wash: #9a2b2012;
  --safe: #1c5e46;
  --safe-on: #f6fffb;
  --signal: #8a6212;
  --signal-wash: #8a621214;

  --step: 0.5rem;
  --measure: 74rem;
  --radius: 3px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0c0e11;
    --panel: #14171c;
    --sunk: #0a0c0f;
    --ink: #e7e3d9;
    --ink-2: #9aa0ab;
    --ink-3: #6a7079;
    --rule: #262b33;
    --rule-hard: #39404b;
    --grid: #ffffff08;

    --danger: #e8685a;
    --danger-on: #1a0c0a;
    --danger-wash: #e8685a1c;
    --safe: #56c39a;
    --safe-on: #04140e;
    --signal: #d7a33c;
    --signal-wash: #d7a33c1c;
  }
}

/* ---------- canvas ---------- */

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0 1.25rem 6rem;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--serif);
  font-size: 1.0625rem;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

/* Graph paper, drawn rather than fetched, faded out at the edges so it never competes with data. */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    repeating-linear-gradient(0deg, transparent 0 27px, var(--grid) 27px 28px),
    repeating-linear-gradient(90deg, transparent 0 27px, var(--grid) 27px 28px);
  -webkit-mask-image: radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 100%);
  mask-image: radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 100%);
}

/* ---------- header ---------- */

header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 1.5rem;
  max-width: var(--measure);
  margin: 0 auto;
  padding: 0.85rem 0 0.7rem;
  border-bottom: 1px solid var(--rule);
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  backdrop-filter: blur(9px) saturate(1.3);
  font-family: var(--mono);
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

header a {
  position: relative;
  padding: 0.25rem 0;
  color: var(--ink-2);
  text-decoration: none;
  transition: color 120ms ease;
}

header a::after {
  content: "";
  position: absolute;
  left: 0;
  right: 100%;
  bottom: -0.72rem;
  height: 2px;
  background: var(--ink);
  transition: right 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

header a:hover { color: var(--ink); }
header a:hover::after { right: 0; }

header a[aria-current="page"] { color: var(--ink); }
header a[aria-current="page"]::after { right: 0; background: var(--signal); }

header form.inline:first-of-type { margin-left: auto; }

header button {
  padding: 0.3rem 0.7rem;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
}

/* ---------- main ---------- */

main {
  position: relative;
  z-index: 1;
  max-width: var(--measure);
  margin: 0 auto;
  padding-top: 2.5rem;
}

main h1 {
  margin: 0 0 2rem;
  font-size: clamp(1.9rem, 1.2rem + 2.2vw, 2.9rem);
  font-weight: 400;
  line-height: 1.1;
  letter-spacing: -0.02em;
  text-wrap: balance;
}

/* A hairline that starts under the title and runs the measure: the ledger rule. */
main h1::after {
  content: "";
  display: block;
  width: 100%;
  height: 1px;
  margin-top: 1.1rem;
  background: linear-gradient(90deg, var(--rule-hard) 0 4rem, var(--rule) 4rem 100%);
}

main > p { max-width: 62ch; color: var(--ink-2); }
main > p strong { color: var(--ink); }

h2 {
  margin: 0 0 0.35rem;
  font-size: 1.35rem;
  font-weight: 400;
  letter-spacing: -0.01em;
}

h3 {
  margin: 1.6rem 0 0.5rem;
  font-family: var(--mono);
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-3);
}

a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--rule-hard); }
a:hover { text-decoration-color: currentColor; }

code, pre, .mono { font-family: var(--mono); }

code {
  padding: 0.1em 0.35em;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--sunk);
  font-size: 0.86em;
}

pre {
  overflow-x: auto;
  margin: 0.6rem 0;
  padding: 0.85rem 1rem;
  border: 1px solid var(--rule);
  border-left: 3px solid var(--rule-hard);
  border-radius: var(--radius);
  background: var(--sunk);
  font-size: 0.82rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.muted { color: var(--ink-3); opacity: 1; }

/* ---------- panels ---------- */

section[data-account] {
  position: relative;
  margin: 1.5rem 0;
  padding: 1.4rem 1.5rem 1.6rem;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: 0 1px 0 var(--rule), 0 12px 28px -26px #0009;
}

/* The tab down the left edge is the panel's index mark, the way a ledger tabs a section. */
section[data-account]::before {
  content: "";
  position: absolute;
  top: 1.5rem;
  left: -1px;
  width: 3px;
  height: 2.1rem;
  border-radius: 0 2px 2px 0;
  background: var(--rule-hard);
}

section[data-account] h2 .muted {
  font-family: var(--mono);
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

section[data-account] ul {
  margin: 0.4rem 0 0.9rem;
  padding: 0;
  list-style: none;
  font-family: var(--mono);
  font-size: 0.85rem;
}

section[data-account] li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0;
  border-bottom: 1px dashed var(--rule);
}

section[data-account] li:last-child { border-bottom: 0; }
section[data-account] li form { margin-left: auto; }

/* ---------- forms ---------- */

form { margin: 0.55rem 0; }
form.grant { margin: 1rem 0 1.5rem; }
form.grant p { margin: 0.4rem 0; max-width: 62ch; }
form.inline { display: inline-block; margin: 0.2rem 0.35rem 0.2rem 0; }

label {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--mono);
  font-size: 0.76rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-2);
}

input, select {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--rule-hard);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 0.86rem;
  text-transform: none;
  letter-spacing: 0;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

input { min-width: 15rem; }
input[type="number"] { min-width: 9rem; }
input::placeholder { color: var(--ink-3); }

input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
  border-color: var(--signal);
}

input:hover:not(:focus), select:hover:not(:focus) { border-color: var(--ink-3); }

button {
  padding: 0.45rem 0.9rem;
  border: 1px solid var(--rule-hard);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
}

button:hover:not(:disabled) { background: var(--sunk); border-color: var(--ink-3); }
button:active:not(:disabled) { transform: translateY(1px); }

button:disabled {
  color: var(--ink-3);
  border-style: dashed;
  border-color: var(--rule);
  background: transparent;
  cursor: not-allowed;
}

.approve { border-color: var(--safe); background: var(--safe); color: var(--safe-on); }
.approve:hover:not(:disabled) { background: color-mix(in srgb, var(--safe) 85%, #000); border-color: var(--safe); }

.deny { border-color: var(--danger); background: var(--danger); color: var(--danger-on); }
.deny:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 85%, #000); border-color: var(--danger); }

/* A revoke button sitting inline among ordinary controls should not read as ordinary. */
section[data-account] .deny { background: transparent; color: var(--danger); border-color: var(--danger); }
section[data-account] .deny:hover:not(:disabled) { background: var(--danger); color: var(--danger-on); }

.danger { border: 1px solid var(--danger); background: var(--danger-wash); }

/* The decision pair is spaced apart on purpose: approving sends mail, and the two should not sit
   a stray pixel from each other. */
form[action^="/approve"] {
  display: flex;
  gap: 2.5rem;
  margin-top: 2rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--rule);
}

form[action^="/approve"] button { padding: 0.7rem 2rem; font-size: 0.85rem; }

/* ---------- tables: the ledger ---------- */

table {
  width: 100%;
  margin: 1rem 0;
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  /* clip, not hidden: hidden makes the table the scroll container for its sticky th, so top: 3.1rem
     was measured from the table's own edge and the header row sat over the first data row. */
  overflow: clip;
  font-family: var(--mono);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.45;
}

th, td {
  padding: 0.5rem 0.7rem;
  border: 0;
  border-bottom: 1px solid var(--rule);
  text-align: left;
  vertical-align: top;
}

th {
  position: sticky;
  top: 3.1rem;
  z-index: 2;
  background: var(--sunk);
  border-bottom: 1px solid var(--rule-hard);
  font-weight: 500;
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-2);
  white-space: nowrap;
}

tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(even) td, table tr:nth-child(even) td { background: color-mix(in srgb, var(--ink) 2.5%, transparent); }
table tr:hover td { background: var(--signal-wash); }

/* The approve page's summary table is a two-column definition, not a ledger: let the label column
   sit narrow and quiet so the value is what the eye lands on. */
table tr > th:only-of-type {
  position: static;
  width: 1%;
  background: transparent;
  border-bottom: 1px solid var(--rule);
  color: var(--ink-3);
}

td:empty::after { content: "-"; color: var(--ink-3); }

/* ---------- untrusted content ---------- */

.untrusted-label {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  max-width: 62ch;
  margin: 1.6rem 0 0;
  font-family: var(--mono);
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--danger);
  text-transform: none;
  letter-spacing: 0;
}

.untrusted-label::before {
  content: "!";
  flex: none;
  width: 1.15rem;
  height: 1.15rem;
  border: 1px solid var(--danger);
  border-radius: 50%;
  font-weight: 700;
  text-align: center;
  line-height: 1.05rem;
}

/* Evidence in a bag: hazard-striped, monospaced, and visibly not part of the interface. The stripes
   are a border-image rather than a background layer, because a background gradient on border-box
   shows through the padding area unless the layer above it is fully opaque, and a wash faint enough
   to read through is not opaque enough to hide it. Measured: the first attempt striped the text. */
.untrusted {
  margin: 0.7rem 0 1.2rem;
  padding: 1rem 1.1rem;
  border: 4px solid var(--danger);
  border-image: repeating-linear-gradient(135deg, var(--danger) 0 9px, transparent 9px 18px) 4;
  border-radius: 0;
  background: var(--danger-wash);
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---------- page load ---------- */

@media (prefers-reduced-motion: no-preference) {
  main > * {
    animation: rise 420ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  main > *:nth-child(1) { animation-delay: 0ms; }
  main > *:nth-child(2) { animation-delay: 45ms; }
  main > *:nth-child(3) { animation-delay: 90ms; }
  main > *:nth-child(4) { animation-delay: 135ms; }
  main > *:nth-child(5) { animation-delay: 180ms; }
  main > *:nth-child(n + 6) { animation-delay: 220ms; }

  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
}

/* ---------- narrow ---------- */

@media (max-width: 40rem) {
  body { padding: 0 0.9rem 4rem; }
  header { font-size: 0.7rem; gap: 0.2rem 1rem; }
  header form.inline:first-of-type { margin-left: 0; }
  main { padding-top: 1.75rem; }
  input, input[type="number"] { min-width: 0; width: 100%; }
  label { display: flex; align-items: stretch; flex-direction: column; gap: 0.3rem; }
  section[data-account] { padding: 1.1rem 1rem 1.2rem; }
  table { display: block; overflow-x: auto; }
  th { position: static; }
  /* Stacked and full-bleed puts Approve directly above Deny with one finger-width between them.
     Sizing them to their content keeps the two decisions visibly separate on a phone. */
  form[action^="/approve"] { flex-direction: column; align-items: flex-start; gap: 1.25rem; }
}

/* ---------- print: the audit page is evidence, so let it print like evidence ---------- */

@media print {
  header, form, button { display: none !important; }
  body { background: #fff; color: #000; padding: 0; }
  body::before { display: none; }
  main { max-width: none; padding-top: 0; }
  main > * { animation: none; }
  table { font-size: 8pt; border-color: #999; }
  th { background: #eee; color: #000; position: static; }
  th, td { border-bottom: 1px solid #ccc; }
  a { text-decoration: none; color: #000; }
}
`;

export function staticHandler(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/static/app.css") return null;
  return new Response(CSS, {
    headers: { ...PAGE_HEADERS, "content-type": "text/css; charset=utf-8" },
  });
}
