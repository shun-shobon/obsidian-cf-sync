# CF Sync

[English](README.md) | 日本語

Cloudflare Workers・Durable Objects・R2を使って、複数端末のノートと添付ファイルを同期するObsidianプラグインです。自分のCloudflareアカウントにサーバーを構築して使います。

https://github.com/user-attachments/assets/b756b66e-3c62-4bcb-9710-f038a03f7667

## 特徴

- **同時編集**：複数端末で同じMarkdownノートを編集し、変更をリアルタイムに反映します。
- **R2への保存**：最新版のノートと添付ファイルを、自分のR2バケットに通常のファイルとして保存します。
- **オフライン対応**：接続がない間の変更は端末に保存し、再接続後に同期します。
- **競合ファイルの保持**：自動統合できない添付ファイルなどは、別名で保存します。
- **モバイル対応**：iOS・AndroidのObsidianでも利用できます。

## 導入の流れ

1. [Cloudflareにサーバーを構築する](#サーバーの準備)。
2. [各端末にプラグインをインストールする](#プラグインの導入)。
3. ログインし、最初の端末で同期先を作成する。ほかの端末でも同じ同期先を選択する。

## サーバーの準備

このリポジトリを取得し、`pnpm install --frozen-lockfile`で依存パッケージをインストールします。

1. CloudflareでR2を有効にし、`packages/worker/wrangler.toml`の`bucket_name`を自分のバケット名へ変更します。新規作成には`pnpm --filter @cf-sync/worker exec wrangler r2 bucket create <バケット名>`を使います。
2. 自分のHTTPSホスト名をWorkerのカスタムドメインへ割り当てます。プラグインにはパスを含まないこのオリジンを設定します。
3. Accessのself-hosted applicationで同期APIの`/api/*`を保護し、自分のメールアドレスだけを許可します。Managed OAuthを有効にします。
4. OAuthの許可リダイレクトURIを`https://<ホスト名>/oauth/callback`に設定します。
5. アクセストークンの寿命は15分、Grant sessionは30日を希望値として設定します。
6. 以下のWorker環境変数を設定します。ローカル開発では同名の値を`packages/worker/.dev.vars`に記載します。

| 変数                 | 値                                                       |
| -------------------- | -------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | `example.cloudflareaccess.com`の形式。スキームは付けない |
| `ACCESS_AUD`         | AccessアプリのApplication Audience                       |
| `OWNER_EMAIL`        | 同期を許可する自分のメールアドレス                       |

```sh
pnpm --filter @cf-sync/worker exec wrangler login
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_AUD
pnpm --filter @cf-sync/worker exec wrangler secret put OWNER_EMAIL
pnpm deploy
```

## プラグインの導入

[BRAT](https://tfthacker.com/brat-plugins)に`shun-shobon/obsidian-cf-sync`を追加し、CF Syncをインストールします。

1. CF Sync設定にサーバーURLと端末名を設定し、ログインします。
2. ブラウザのAccess認証を終え、中間ページからObsidianへ戻ります。
3. 最初の端末でリモートVaultを作成します。追加端末では同じリモートVaultを選びます。
4. 既存ファイルが競合する場合は、初回の確認画面を確認します。異なる内容は別名で保持します。

1つのローカルVaultを1つのリモートVaultへ接続します。別のリモートVaultを使う場合は別のローカルVaultを用意します。
