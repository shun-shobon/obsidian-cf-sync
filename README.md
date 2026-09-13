# CF Sync

English | [日本語](README.ja.md)

An Obsidian plugin that syncs notes and attachments across devices using Cloudflare Workers, Durable Objects, and R2. You host the server in your own Cloudflare account.

https://github.com/user-attachments/assets/b756b66e-3c62-4bcb-9710-f038a03f7667

## Features

- **Concurrent editing**: Edit the same Markdown note on multiple devices, with changes synced while you type.
- **Live cursors**: Share your active editing pane and always see other devices’ cursors, selections, and names in the same note.
- **R2 storage**: Store the latest versions of notes and attachments as regular files in your own R2 bucket.
- **Offline support**: Save changes locally while offline and sync them when you reconnect.
- **Conflict preservation**: Keep attachments and other files that cannot be merged automatically under separate names.
- **Mobile support**: Works with Obsidian on iOS and Android.

For up to five devices, the targets are about 0.5 seconds for text and 0.2 seconds for cursors. These targets have not been measured; the collaboration changes still need testing on desktop, iOS, and Android devices.

## Getting started

1. [Set up the server on Cloudflare](#server-setup).
2. [Install the plugin on each device](#plugin-installation).
3. Sign in and create a remote vault on your first device. Select the same remote vault on your other devices.

## Server setup

Clone this repository and install dependencies with `pnpm install --frozen-lockfile`.

1. Enable R2 in Cloudflare and set `bucket_name` in `packages/worker/wrangler.toml` to your bucket name. To create a bucket, run `pnpm --filter @cf-sync/worker exec wrangler r2 bucket create <bucket-name>`.
2. Assign your HTTPS hostname to the Worker as a custom domain. Use this origin, without a path, as the server URL in the plugin.
3. Protect the sync API at `/api/*` with an Access self-hosted application, allow only your email address, and enable Managed OAuth.
4. Set the allowed OAuth redirect URI to `https://<hostname>/oauth/callback`.
5. Set the desired access token lifetime to 15 minutes and the Grant session duration to 30 days.
6. Configure the Worker environment variables below. For local development, put the same values in `packages/worker/.dev.vars`.

| Variable             | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | Your team domain, such as `example.cloudflareaccess.com`, without a scheme |
| `ACCESS_AUD`         | The Application Audience of your Access application                        |

```sh
pnpm --filter @cf-sync/worker exec wrangler login
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_AUD
pnpm deploy
```

## Plugin installation

In Obsidian, open **Settings → Community plugins → Browse**, search for **CF Sync**, and install and enable it. If restricted mode is on, turn on community plugins first.

1. Enter your server URL and device name in the CF Sync settings, then sign in.
2. Complete Access authentication in your browser and return to Obsidian from the callback page.
3. Create a remote vault on your first device. Select the same remote vault on additional devices.
4. If existing files conflict, review the initial confirmation screen. Files with different contents are kept under separate names.

Each local vault connects to one remote vault. To use a different remote vault, create a separate local vault.

## Updating to 0.2.0

Version 0.2.0 sends sync operations and cursor information over WebSocket, so you must also redeploy the Worker from the 0.2.0 source. Keep your existing settings in `packages/worker/wrangler.toml`, run `pnpm install --frozen-lockfile` and `pnpm deploy`, then update the plugin on each device. The 0.2.0 plugin cannot sync with the 0.1.3 Worker.

## Requirements and costs

CF Sync requires a Cloudflare account and a server that you deploy and maintain in that account, using Workers, Durable Objects, R2, and Cloudflare Access with Managed OAuth. You also need a custom domain for the server and an email address allowed by your Access policy.

Cloudflare charges may apply depending on your plan and usage. Review the pricing for [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [R2](https://developers.cloudflare.com/r2/pricing/) before deploying.

## Network access and data

The plugin communicates with your configured server over HTTPS and secure WebSockets. It sends synced file contents and paths, edits and deletion operations, file metadata, remote vault names and identifiers, device names and identifiers, cursor positions and selections in the active note, and sync exclusion settings. Your server processes this data in Cloudflare Workers and Durable Objects and stores files in your R2 bucket. Cursor information is used only for live display and is not stored in files, edit history, or R2. Durable Objects retain the Yjs state of deleted notes to recover edits made concurrently with deletion.

Sign-in uses your server's Cloudflare Access OAuth endpoints and, in your browser, the identity provider configured in Access. OAuth registration, authorization, and token exchange send the information needed to authenticate. Your Access policy controls who can sync, and your server verifies the Access JWT's signature, issuer, audience, and expiration.

CF Sync does not provide end-to-end encryption. Transport is encrypted, but the server can read synced content, and the latest notes and attachments are stored in R2 as regular files.
