# CF Sync

自分のCloudflare環境でObsidian Vaultを同期するプラグイン。MarkdownはYjsで同時編集し、通常ファイルの最新版をR2へ保存します。

対応対象はmacOS・Windows・Linux・iOS・Androidです。実装は開発段階で、実機の検証結果は[検証記録](docs/validation.md)を参照してください。仕様は[初版仕様](docs/spec.md)にあります。

## 構成

| ディレクトリ        | 内容                                                       |
| ------------------- | ---------------------------------------------------------- |
| `src/shared`        | 通信データの型・検証、ファイルパスの検証                   |
| `src/worker`        | Access認証、端末・Vault管理、DO、添付転送、R2反映          |
| `src/plugin/auth`   | Managed OAuthとトークン更新                                |
| `src/plugin/sync`   | ローカル状態、未送信変更、Yjs、差分照合                    |
| `src/plugin/editor` | ObsidianのCodeMirrorとの接続                               |
| `src/plugin/ui`     | 設定、初回確認、競合一覧                                   |
| `tests`             | 同期・認証・エディターとCloudflareローカル実行環境のテスト |

## 開発

[mise](https://mise.jdx.dev/)を導入して実行します。Node.jsとpnpmの版は`mise.toml`で固定しています。

```sh
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm typecheck
mise exec -- pnpm lint
mise exec -- pnpm test
mise exec -- pnpm build
```

プラグインの成果物は`dist/main.js`と`dist/manifest.json`です。ObsidianとCodeMirrorはホストが提供するものを使い、Yjs等はビルドへ同梱します。

Workerのデプロイ内容だけを確認する場合は次を実行します。

```sh
mise exec -- pnpm exec wrangler deploy --dry-run --outdir dist/worker
```

## サーバーの準備

1. CloudflareでR2を有効にし、`wrangler.jsonc`の`bucket_name`を自分のバケット名へ変更します。新規作成には`mise exec -- pnpm exec wrangler r2 bucket create <バケット名>`を使います。
2. 自分のHTTPSホスト名をWorkerのカスタムドメインへ割り当てます。プラグインにはパスを含まないこのオリジンを設定します。
3. Accessのself-hosted applicationで同期APIの`/api/*`を保護し、自分のメールアドレスだけを許可します。Managed OAuthを有効にします。
4. OAuthの許可リダイレクトURIを`https://<ホスト名>/oauth/callback`に設定します。public clientのDynamic Client RegistrationとPKCEによる認可コード交換を利用します。ルートの`/.well-known/oauth-authorization-server`からそのアプリのOAuthメタデータが取得できることも確認します。Accessのパス設定によって発見URLが届かない場合は、同じAccessアプリの対象にメタデータのパスも含めます。
5. アクセストークンの寿命は15分、Grant sessionは30日を希望値として設定します。アカウントの設定で30日が許可されるか確認してください。
6. `/oauth/callback`と`/ws`は通常のAccessログインで遮断しません。コールバックは認可コードをObsidianへ渡し、`/ws`はWorkerが短命・一回限りの接続券を検証します。
7. 以下のWorker環境変数を設定します。ローカル開発では同名の値を`.dev.vars`に記載します。このファイルはGitの対象外です。

| 変数                 | 値                                                       |
| -------------------- | -------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | `example.cloudflareaccess.com`の形式。スキームは付けない |
| `ACCESS_AUD`         | AccessアプリのApplication Audience                       |
| `OWNER_EMAIL`        | 同期を許可する自分のメールアドレス                       |

```sh
mise exec -- pnpm exec wrangler login
mise exec -- pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
mise exec -- pnpm exec wrangler secret put ACCESS_AUD
mise exec -- pnpm exec wrangler secret put OWNER_EMAIL
mise exec -- pnpm deploy
```

DOはSQLiteバックエンドで作成されます。HTTP APIはAccess JWTの署名・issuer・audience・所有者を検証し、設定が不足している場合も認証を省略しません。端末の失効はAPIと既存WebSocketへ反映します。

Managed OAuthと実際のAccessパス設定を含む手順は、利用するCloudflareアカウントでの確認が必要です。[CloudflareのManaged OAuth資料](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)も参照してください。

## プラグインの導入

公開リリースが用意されたら、各端末のObsidianにBRATを導入し、このGitHubリポジトリを追加します。BRATによる導入・更新は[作者の手順](https://tfthacker.com/brat-plugins)を参照してください。

手元で試す場合は、テスト用Vaultの`.obsidian/plugins/cf-sync/`へ`dist/main.js`と`dist/manifest.json`を配置し、コミュニティプラグイン設定でCF Syncを有効にします。

1. CF Sync設定にサーバーURLと端末名を設定し、ログインします。
2. ブラウザのAccess認証を終え、中間ページからObsidianへ戻ります。
3. 最初の端末でリモートVaultを作成します。追加端末では同じリモートVaultを選びます。
4. 既存ファイルが競合する場合は、初回の確認画面を確認します。異なる内容は別名で保持します。

1つのローカルVaultを1つのリモートVaultへ接続します。別のリモートVaultを使う場合は別のローカルVaultを用意します。`.obsidian`内のプラグイン設定には認証情報が入るため、別の同期ツールで複製しないでください。

除外はファイルまたはフォルダーの相対パスを1行ずつ指定します。ワイルドカードは使いません。Vault全端末で共通となり、除外しても端末とR2の既存ファイルは削除しません。

モバイル回線でも添付を取得します。アプリ終了後の同期は保証せず、次に開いたときに再接続します。一時停止・再開と手動同期は設定画面またはコマンドパレットから実行できます。

## 保存状態と競合

表示は未送信、DO保存済み・R2反映待ち、R2反映済みを区別します。R2には`vaults/<Vault ID>/files/<元のパス>`として通常ファイルを保存します。`staging/`は添付転送とDOが参照する内部データで、手動で削除・変更しないでください。

競合する添付や同名の新規ファイルは`(conflict <ID>)`を付けた別名で保持します。削除と編集が競合した場合も内容を復旧コピーに残します。R2はファイル単位の最新版であり、過去版の履歴やDO障害後の同期状態の復旧機能はありません。

## リリース

`package.json`、`manifest.json`、`versions.json`の版を更新し、同じバージョンのタグを付けて公開すると、GitHub Actionsがテスト・ビルドし、BRAT用のリリース添付ファイルを作成します。タグは`0.1.0`の形式です。通常のCIは検証と成果物の生成だけを行い、Cloudflareへの自動デプロイは行いません。
