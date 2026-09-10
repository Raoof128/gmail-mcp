# Google Cloud setup

Two projects, per the design (section 4.4). Both use the same steps; only the publishing status differs.

| Project              | Publishing status                                 | Used by                                   |
| -------------------- | ------------------------------------------------- | ----------------------------------------- |
| `gmail-mcp-dev`      | Testing                                           | a scratch Gmail account, manual test runs |
| `gmail-mcp-personal` | In production, unverified, personal-use exemption | the owner's real accounts                 |

## Steps

1. Create the project and enable the Gmail API.
2. Configure the OAuth consent screen as **External**. Add the scopes `openid`, `email`, `profile` and
   `https://www.googleapis.com/auth/gmail.modify`. Do not add `https://mail.google.com/`.
3. In Testing status, add the Google accounts you will connect as test users. Refresh tokens issued by a
   Testing project expire after 7 days unless only profile scopes were requested, which is why the owner's
   login keeps working while a connected Gmail account in the dev project needs reconnecting weekly.
4. Create an OAuth client of type **Web application** with these redirect URIs, replacing the host:
   - `https://<WORKER_HOSTNAME>/oidc/callback`
   - `https://<WORKER_HOSTNAME>/connect/callback`
5. Put the client id and secret into the Worker with `wrangler secret put GOOGLE_CLIENT_ID` and
   `wrangler secret put GOOGLE_CLIENT_SECRET`.
6. For `gmail-mcp-personal`, move the consent screen to **In production** and leave it unverified. The
   personal-use exemption covers apps used by fewer than 100 users known to the owner. The unverified
   warning still appears during consent.

## First login

Deploy with `OWNER_GOOGLE_SUBS` empty and `OWNER_EMAILS` set to your address. Open the Worker, log in, and
the page shows your Google `sub`. Confirm it is the account you meant to trust, then
`wrangler secret put OWNER_GOOGLE_SUBS` with that value and log in again. `OWNER_EMAILS` is never consulted
once `OWNER_GOOGLE_SUBS` is set.

For an address that is not a Gmail or Workspace mailbox, `email_verified` means Google confirmed the address
once, not that Google remains authoritative for it. Bootstrap with an account you control at Google.

## Connecting a Gmail account

Log in, open `/accounts`, and connect an alias. Google returns a refresh token only on a consent screen, so
the Worker always asks for one. If Google declines to issue one, remove gmail-mcp under
[Google account permissions](https://myaccount.google.com/permissions) and connect again.

## Local development

`wrangler dev` serves plain HTTP on `localhost:8787`, and the Worker builds every redirect, audience and
`Origin` check as `https://<WORKER_HOSTNAME>`. The OAuth flows therefore cannot complete against a local dev
server as the code stands. Run the suite instead, which exercises every flow against an in-memory Google
inside the real Workers runtime, and use a deployed dev Worker for manual checks:

```bash
npm run verify
```

Making local HTTP work would mean a `WORKER_SCHEME` variable threaded through the audience, both redirect
URIs and the `Origin` check. That is deliberately deferred rather than half-done, because three of those four
are security boundaries.
