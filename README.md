# google-accounts-mcp

An MCP (Model Context Protocol) server that lets your AI agents use several Google accounts at once, both gmail.com accounts and Google Workspace accounts from any organization. The official Google connectors allow one account per client. With this server, one connection from Claude, Claude Code, or ChatGPT can reach every account you allow.

You run it as a Cloudflare Worker on your own Cloudflare account, on the Workers Paid plan, with your own Google Cloud OAuth client. Agent clients connect to `https://<your host>/mcp`. It supports Gmail, Google Calendar, and Google Chat. With a Workspace account, agents can list Chat conversations, read and search their messages, send messages and replies in threads, and open direct messages.

## What you control

You sign in to the server's pages through Cloudflare Access.

- **Accounts** (`/accounts`). You connect each Google account here and choose any of Gmail, Calendar, and Chat. Chat works only with Google Workspace accounts. Reconnect an account to change its services.
- **Connections** (`/connections`). Each time an agent client signs in to the server, it becomes a new connection. For each account, you set each of its tools to Not allowed, Ask first, or Allowed. A new connection starts with every tool set to Not allowed, and it sees only the tools you set to Ask first or Allowed.
- **Approvals** (`/approvals/:id`). With Ask first, the agent gets a link to an approval page instead of a result. The tool runs only after you approve it there, and the agent then collects the result with `get_approval`. An approval expires after one hour.
- **Activity** (`/activity`). The server records every tool call, with the connection that made it, the account, the outcome, and the reason for each refusal or failure.

The Gmail tools list labels, search and read threads, change labels, write drafts, send, reply, forward, move messages to the trash and back, delete them permanently, download attachments, and attach files. Each tool's description tells the agent its inputs and limits. You cannot undo a send or a permanent deletion, so the Connections page asks you to confirm before it sets such a tool to Allowed.

## Deploy

You deploy from a copy of this repository on your own computer. You need Node.js 26 with pnpm (`npm install --global pnpm`), a Cloudflare account on the Workers Paid plan, and a hostname in a zone of that account, such as `mcp.example.com`.

Set up these first, with your hostname in place of `<host>`:

- **A Google Cloud OAuth client.** Enable the Gmail API, the Google Calendar API, and the Google Chat API in your Google Cloud project, and create a web application client. Register `https://<host>/google/callback` as a redirect URI. The server asks only for the scopes of the services you choose for each account:
  - Gmail: `gmail.readonly`, `gmail.compose`, `gmail.send`, `gmail.modify`, and `https://mail.google.com/`.
  - Calendar: `calendar.calendarlist.readonly`, `calendar.events`, and `calendar.events.freebusy`.
  - Chat: `chat.spaces.readonly`, `chat.messages.readonly`, `chat.messages.create`, `chat.users.readstate.readonly`, `chat.memberships.readonly`, and `chat.spaces.create`.

  Except for `https://mail.google.com/`, each scope starts with `https://www.googleapis.com/auth/`. The admin of a Workspace organization can block your client for that organization's accounts, or block Calendar or Chat alone. You can then connect the account without the blocked service.

  For Chat, also save a Chat app configuration. Open the Google Chat API's Configuration page in the Google Cloud console, enter an app name, an avatar URL, and a description, and choose who can see the app. Reading Chat works without the configuration. Sending Chat messages and opening direct messages need it.

- **Two Cloudflare Access self-hosted applications** on `<host>`, both with managed OAuth turned off:
  1. One for the whole hostname, with an Allow policy for your email address only.
  2. One for `/mcp`, `/oauth/*`, `/.well-known/*`, and `/uploads/*`, with a Bypass policy for everyone. Agent clients and file uploads call these paths without a browser, and the server checks its own connection and upload credentials there.

Then download or clone this repository and run, from its folder:

```sh
pnpm install
pnpm exec wrangler login
pnpm run deploy <host>
```

The first time, the command asks for these settings and stores them as secrets of the Worker:

| Setting                | Value                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `OWNER_EMAIL`          | Your email address. The first request with a valid Access token for it makes you the owner. |
| `ACCESS_ISSUER`        | Your Access team domain, exactly `https://<team>.cloudflareaccess.com`.                     |
| `ACCESS_AUDIENCE`      | The Application Audience (AUD) tag of the first Access application.                         |
| `GOOGLE_CLIENT_ID`     | The OAuth client ID.                                                                        |
| `GOOGLE_CLIENT_SECRET` | The OAuth client secret.                                                                    |

It also generates `TOKEN_KEY`, the key that encrypts Google tokens. Only the Worker keeps it, and the Worker cannot read your connected accounts without it. To keep your own copy, generate one with `openssl rand -hex 32` before the first deploy and set it in the environment. The command takes any of these settings from an environment variable of the same name instead of asking, and it checks each value before it changes anything.

The command then builds the server, deploys it to `<host>`, and turns off its `workers.dev` address. The deploy creates the D1 database, the KV namespaces, and a cron trigger that removes expired approvals, uploads, and repeat records every ten minutes. The command applies the database migrations and checks that `/mcp`, `/.well-known/`, `/oauth/`, and `/uploads/` on `<host>` answer as this server does. When Access sends one of them to its sign-in page, the command names it: it is missing from the second Access application.

To update, get the new version of the repository and run `pnpm run deploy <host>` again. The command applies the new migrations before it deploys, and asks only for a setting the Worker does not have yet. Set `CLOUDFLARE_ACCOUNT_ID` when your Cloudflare login reaches several accounts. On a machine without a browser, set `CLOUDFLARE_API_TOKEN` instead of running `wrangler login`.

To change a setting, run `pnpm exec wrangler secret put <NAME>`. To change the owner, set the new `OWNER_EMAIL` this way, which applies it to all traffic at once. Never use a gradual deployment for it, because an older version would still accept the old owner. The server refuses every request until you run `pnpm owner:reset`, which asks for confirmation before it clears the stored owner. The new owner then signs in.

If you already run this server, enable the Google Calendar API and the Google Chat API in its Google Cloud project, and save the Chat app configuration. Then reconnect each account that needs Calendar or Chat, with that service checked. Existing accounts keep the services they have; they gain no other service until you reconnect them.

## Before you use it

An agent that controls a browser where you are signed in can approve its own calls or change its own settings. The server cannot tell those browser actions from yours.

The server encrypts Google tokens, and the arguments and results it keeps for approvals, in D1. It encrypts downloaded and uploaded files in KV, and KV deletes them within about 75 minutes. The name of an uploaded file is part of its upload address, so it appears in the Worker's request log.

## Development

See [AGENTS.md](AGENTS.md) for how to install, run, and test the project.
