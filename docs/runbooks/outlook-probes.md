# Outlook Phase 0 probes

The [Outlook provider design](../superpowers/specs/2026-10-05-outlook-provider-design.md) rests on facts
that no document can settle: whether a draft's id survives send, what DELETE does, what an upload session
URL looks like, how the service throttles. Phase 0 measures them. This runbook sets up the Microsoft side,
runs the harness in `scripts/outlook-probes`, and turns its output into evidence.

Nothing here is needed to run or develop the Gmail server. The harness holds no production code.

## Rules

- Use a **throwaway** mailbox you own: a new personal Microsoft account, and optionally a Microsoft 365
  developer tenant you administer. Never a real mailbox, never someone else's.
- Every probe that changes the mailbox is off unless you pass its flag, and any change at all requires
  `--confirm-mailbox` to name the signed-in address.
- Probe mail goes only to the account itself. P15 is the one exception, and it sends only to the
  `--forward-target` you name, which must be a second mailbox you control.
- The harness never sends `permanentDelete`, never touches `/users/` or `/beta/`, never sends a `$batch`,
  and only DELETEs a message this run created, behind `--allow-destructive`. Its tests prove each refusal
  by mutation.
- Tokens stay in memory. The only file written is the redacted evidence file. It keeps shapes, status
  codes and error codes, never addresses, subjects, bodies, ids or tokens. It still describes a private
  mailbox, so it is written with owner-only permissions and `probe-evidence/` is git-ignored.
- A run against the synthetic Graph in the harness tests is never evidence. Only a live run is, and the
  evidence file says which it is.

## 1. Register the personal-account app

Portal labels below are as of October 2026 and may move. The facts behind each step are in the design's
section 5.

1. In the Microsoft Entra admin center, open **App registrations** and choose **New registration**.
2. Name it `outlook-probes-personal`. For supported account types choose **Personal Microsoft accounts
   only**. If the portal does not offer it, choose the option that includes personal accounts; the harness
   signs in through `/consumers` either way.
3. Add a platform of type **Mobile and desktop applications** with the redirect URI
   `http://127.0.0.1:8400/callback`. The harness is a public client with PKCE and holds no secret.
4. Under **API permissions**, add Microsoft Graph delegated permissions: `openid`, `profile`,
   `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send` and `MailboxSettings.ReadWrite`. Add
   nothing else. In particular, no `Mail-Advanced.*`, `*.Shared` or `MailboxItem.*`.
5. Copy the **Application (client) id**. It is not a secret.

## 2. Register the single-tenant app (optional)

Only if you administer a developer tenant. Repeat step 1 in that tenant with the name
`outlook-probes-tenant` and **Accounts in this organizational directory only**. Copy the client id and the
**Directory (tenant) id**. As the tenant's administrator, grant admin consent for the permissions, because
the default tenant policy blocks user consent to `Mail.*` and `MailboxSettings.*`.

## 3. Run the read-only probes

```bash
npm ci
cd scripts/outlook-probes
node cli.ts --authority consumers --client-id <client-id>
```

The harness prints a sign-in URL. Open it, sign in with the throwaway account and consent. With no flags,
it runs P3, P5, P6, P11, P12 and P16, which only read, and records every other probe as skipped with the
flag it needs. For the tenant registration, pass the tenant id as `--authority`.

## 4. Consent (P7, by hand)

Record what each consent screen showed and whether it completed:

- the personal registration, signed in with the personal account;
- the tenant registration, signed in as an ordinary user before admin consent is granted, and after;
- if available, an ordinary work or school account in a tenant you do not administer. The design expects
  "admin approval required". Do not ask anyone's administrator to approve a probe app.

## 5. Run the mutating probes

These create drafts tagged `[probe <run-tag>]`, send mail to the account itself, and create and delete a
category.

```bash
node cli.ts --authority consumers --client-id <client-id> \
  --allow-mutation --confirm-mailbox <the-throwaway-address> \
  --probes P1,P8,P9,P12m,P13
```

Then, separately and deliberately:

```bash
# P4: DELETE on a draft this run created, then on its Deleted Items copy.
node cli.ts ... --allow-mutation --allow-destructive --confirm-mailbox <address> --probes P4

# P10: bursts of 4, 8 and 16 concurrent reads.
node cli.ts ... --allow-load --probes P10

# P15: a forwarding rule to a second mailbox you control, deleted at the end.
node cli.ts ... --allow-mutation --allow-external-forward --forward-target <your-other-mailbox> \
  --confirm-mailbox <address> --probes P15
```

For P15, check the target mailbox by hand and record whether the forward arrived. The harness can only
see whether a non-delivery report came back.

The harness leaves its drafts and sent probe mail behind, because it will not delete what it did not
need to. Delete them in Outlook when the run is done; the summary line gives the run tag to search for.

## 6. Credential failures (P14, by hand)

These need the confidential client the Worker will use, so they wait for the Phase 2 runbook. Record the
token endpoint's response body for an expired certificate and for a tenant that blocks the credential type.
The design's error taxonomy in section 5.5 is the table to fill in.

## 7. Change notifications (P17, deferred)

Subscriptions need a public HTTPS endpoint that answers the validation handshake within 10 seconds, so
they are measured against a deployed Worker in Phase 6, not here.

## 8. Turning a run into evidence

1. Read the evidence file before keeping it. If anything identifying survived redaction, delete the file,
   fix the harness and run again.
2. Keep evidence outside the repository. It describes a private mailbox.
3. Transcribe each probe into a dated evidence document in the format of the
   [Plan 6 feasibility review](../superpowers/reviews/2026-09-16-plan-6-feasibility.md): the measure, the
   falsifier, what was observed, and the run tag.
4. A probe recorded as `skipped`, `refused` or `error` is not a result. Neither is a synthetic run.

| Probe | Question                                                    | Decides                                 |
| ----- | ----------------------------------------------------------- | --------------------------------------- |
| P1    | Does the draft id find the Sent copy after send?            | Which observation key the Worker trusts |
| P2    | Does the stamped `Message-ID` reach the recipient?          | Whether the second key works            |
| P3    | Does `$filter` on `internetMessageId` work?                 | Same                                    |
| P4    | What does DELETE do?                                        | Whether DELETE stays refused            |
| P5    | Which `$search`, `$filter`, `$orderby` mixes are accepted?  | Search and thread design                |
| P6    | Do refresh tokens rotate? What claims arrive?               | Token storage, identity verifier        |
| P8    | What is the upload URL's shape and behaviour?               | The upload validator                    |
| P9    | Where are the size boundaries?                              | Attachment path choice                  |
| P10   | When does throttling start?                                 | Limiter settings                        |
| P11   | Does the plain-text preference apply? Which attachments?    | Read path                               |
| P12   | What characters do ids use? Do they survive moves?          | `ProviderId` schema                     |
| P13   | How do categories, `If-Match` and rename behave?            | Category writes                         |
| P15   | Does an external forwarding rule deliver, bounce or vanish? | Rule policy                             |
| P16   | How do delta links page, expire and fail?                   | `sync_folder` cursors                   |
| P18   | Does deleting a category definition touch tagged items?     | `delete_label` on Outlook               |
