# CF Sync

[English](README.md) | 日本語

Cloudflare Workers・Durable Objects・R2を使って、複数端末のノートと添付ファイルを同期するObsidianプラグインです。自分のCloudflareアカウントにサーバーを構築して使います。

https://github.com/user-attachments/assets/b756b66e-3c62-4bcb-9710-f038a03f7667

## 特徴

- **同時編集**：複数端末で同じMarkdownノートを編集し、連続入力中も変更を反映します。
- **ライブカーソル**：操作中の編集ペインの位置を共有し、同じノートに他端末のカーソル・選択範囲・端末名を常時表示します。
- **R2への保存**：最新版のノートと添付ファイルを、自分のR2バケットに通常のファイルとして保存します。
- **オフライン対応**：接続がない間の変更は端末に保存し、再接続後に同期します。
- **競合ファイルの保持**：自動統合できない添付ファイルなどは、別名で保存します。
- **モバイル対応**：iOS・AndroidのObsidianでも利用できます。

最大5端末で本文は約0.5秒、カーソルは約0.2秒以内の反映を目標としています。速度は未実測で、今回の共同編集改善はPC・iOS・Androidの実機検証が必要です。

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

```sh
pnpm --filter @cf-sync/worker exec wrangler login
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_AUD
pnpm deploy
```

## プラグインの導入

Obsidianの**設定 → コミュニティプラグイン → 閲覧**から**CF Sync**を検索し、インストールして有効化します。制限モードが有効な場合は、先にコミュニティプラグインを有効にしてください。

1. CF Sync設定にサーバーURLと端末名を設定し、ログインします。
2. ブラウザのAccess認証を終え、中間ページからObsidianへ戻ります。
3. 最初の端末でリモートVaultを作成します。追加端末では同じリモートVaultを選びます。
4. 既存ファイルが競合する場合は、初回の確認画面を確認します。異なる内容は別名で保持します。

1つのローカルVaultを1つのリモートVaultへ接続します。別のリモートVaultを使う場合は別のローカルVaultを用意します。

## CLI

ObsidianなしでVaultを同期できます（macOS・Linux、Node.js 24以上）。Accessで**Service Auth**を許可した[サービストークン](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)を用意します。

```sh
npm install -g obsidian-cf-sync
export CF_SYNC_SERVER_URL=https://sync.example.com
export CF_ACCESS_CLIENT_ID='your-client-id'
export CF_ACCESS_CLIENT_SECRET='your-client-secret'

obsidian-cf-sync vault list
obsidian-cf-sync init ./vault --vault REMOTE_VAULT_ID
obsidian-cf-sync sync ./vault
```

その他の使い方は`obsidian-cf-sync --help`を参照してください。

## 利用要件と料金

Cloudflareアカウントと、そのアカウント内に自分で構築・管理するサーバーが必要です。サーバーではWorkers・Durable Objects・R2と、Managed OAuthを有効にしたCloudflare Accessを使います。サーバー用のカスタムドメインと、Accessポリシーで許可するメールアドレスも必要です。

契約プランや使用量に応じてCloudflareの利用料金が発生する場合があります。構築前に[Workers](https://developers.cloudflare.com/workers/platform/pricing/)・[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)・[R2](https://developers.cloudflare.com/r2/pricing/)の料金を確認してください。

## 外部通信とデータの扱い

プラグインは、設定したサーバーとHTTPSおよび暗号化されたWebSocketで通信します。同期対象のファイル内容とパス、編集・削除操作、ファイルのメタデータ、リモートVaultの名前と識別子、端末名と識別子、操作中のノートのカーソル・選択範囲、同期除外設定を送信します。サーバーはこれらのデータをCloudflare WorkersとDurable Objectsで処理し、ファイルを自分のR2バケットに保存します。カーソル情報は接続中の表示にだけ使い、ファイル・編集履歴・R2には保存しません。削除と同時に行われた編集を復元できるよう、削除済みノートのYjs内部状態はDurable Objectsに保持します。

ログイン時には、サーバーのCloudflare Access OAuthエンドポイントと、Accessに設定した認証プロバイダー（ブラウザ内）へ接続します。OAuthのクライアント登録・認可・トークン交換に必要な情報を送信します。同期を許可するユーザーはAccessポリシーで制限し、サーバーはAccessのJWTの署名・発行元・宛先・有効期限を検証します。

CF Syncはエンドツーエンド暗号化に対応していません。通信は暗号化されますが、サーバーは同期内容を読み取ることができ、最新版のノートと添付ファイルは通常のファイルとしてR2に保存されます。
