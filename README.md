# CF Sync

English | [日本語](README.ja.md)

An Obsidian plugin that syncs notes and attachments across devices using Cloudflare Workers, Durable Objects, and R2. You host the server in your own Cloudflare account.

https://github.com/user-attachments/assets/b756b66e-3c62-4bcb-9710-f038a03f7667

## Features

- **Concurrent editing**: Edit the same Markdown note on multiple devices, with changes synced in real time.
- **R2 storage**: Store the latest versions of notes and attachments as regular files in your own R2 bucket.
- **Offline support**: Save changes locally while offline and sync them when you reconnect.
- **Conflict preservation**: Keep attachments and other files that cannot be merged automatically under separate names.
- **Mobile support**: Works with Obsidian on iOS and Android.

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
| `OWNER_EMAIL`        | Your email address, allowed to sync                                        |

```sh
pnpm --filter @cf-sync/worker exec wrangler login
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_AUD
pnpm --filter @cf-sync/worker exec wrangler secret put OWNER_EMAIL
pnpm deploy
```

## Plugin installation

Add `shun-shobon/obsidian-cf-sync` to [BRAT](https://tfthacker.com/brat-plugins) to install CF Sync.

1. Enter your server URL and device name in the CF Sync settings, then sign in.
2. Complete Access authentication in your browser and return to Obsidian from the callback page.
3. Create a remote vault on your first device. Select the same remote vault on additional devices.
4. If existing files conflict, review the initial confirmation screen. Files with different contents are kept under separate names.

Each local vault connects to one remote vault. To use a different remote vault, create a separate local vault.
