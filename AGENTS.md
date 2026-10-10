# 作業方針

- ユーザーへの返答は日本語で行う。
- 既存コードとテストを確認してから変更する。仕様書と実装が異なる場合は、実装済みの動作と未実装の設計を区別する。
- 独立して進められる調査やレビューにはサブエージェントを使う。委任した作業をメイン側で重複して行わない。
- 要件に影響する不明点は確認する。通常の実装判断は既存の方針に沿って進める。
- 要求されていない機能、互換レイヤ、別名、silent fallbackを追加しない。不要になった処理や参照は削除する。

## プロジェクト構成

CF Syncは、Cloudflare Workers・Durable Objects・R2を使うObsidian同期プラグインと、Obsidianを使わずにVaultを同期するCLI。pnpm workspaceで次のパッケージを管理する。仕様は`docs/spec.md`、通信プロトコルは`docs/protocol.md`にある。

| パス                       | 役割                                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| `packages/obsidian-plugin` | Obsidianの設定画面、認証、エディター連携、端末内保存                        |
| `packages/cli`             | Obsidianを使わずにVaultを同期するCLI。npmへ`obsidian-cf-sync`として公開する |
| `packages/sync-core`       | プラグインとCLIで共有する同期クライアントの処理                             |
| `packages/worker`          | HTTP API、認証、Durable Objects、同期操作の適用、R2への保存                 |
| `packages/protocol`        | クライアントとWorkerで共有する通信スキーマとデータ処理                      |
| `packages/*/tests`         | 各パッケージのテスト                                                        |
| `tests`                    | プラグイン・CLIとWorkerを接続する結合テストと共通のテスト補助               |

- Workerとクライアントは互いの実装を直接参照せず、共有部分は`@cf-sync/protocol`を通す。
- プラグインとCLIに共通する同期処理は`@cf-sync/sync-core`に置き、端末固有の処理は`ports`のインターフェースを通して各クライアントで実装する。
- `domain`にはドメインの型やルール、`usecase`には操作の手順、`service`には同期などの処理、`infra`には外部APIやストレージとの接続、`presentation`にはCLIのコマンドと出力を置く。
- UI、エディター連携、翻訳はそれぞれの責務に沿って分ける。エントリーポイントに処理を集約しない。

## コードの書き方

- 人が読んで処理を追えることを優先する。関数やファイルが長くなる場合は、責務ごとに分割する。
- import/exportのまとまりと、それ以外の宣言の間には空行を入れる。関数内も処理の区切りに空行を入れる。
- 長い条件式や三項演算子を詰め込まない。意味の分かる変数、早期return、小さな関数に分ける。
- 自前実装の前に、標準APIや既存ライブラリで扱えるか確認する。実行環境での対応状況も確認する。
- スキーマ検証はValibot、翻訳はi18next、HTTPルーティングはHono、HTML生成はHono JSX、CLIのコマンド定義はcittyを使う。
- Durable Objectsへの内部呼び出しはRPCを使う。内部メソッドを呼ぶためのHTTPルーティングを追加しない。
- バイト列の変換などは既存の共通処理を確認し、同じ処理を増やさない。
- プラグインと`sync-core`はモバイルでも動作する必要がある。Node.jsやデスクトップ固有APIに依存する処理を安易に追加しない。Node.js固有の処理はCLIに置く。

## 同期処理

- Markdownの同時編集にはYjsを使う。オフライン変更と、再接続後の同期を考慮する。
- R2にはノートと添付ファイルの最新版を保存する。保存履歴や同期状態の復旧が実装済みであるかのように扱わない。
- 変更のない間の定期同期、heartbeat、強制再接続を追加しない。Durable ObjectsのWebSocket Hibernationを維持する。
- 認証・同期処理を変更するときは、端末の再接続、競合、削除と編集の同時発生への影響を確認する。
- ログにノート本文、ファイルパス、トークン、認可コード、接続券を含めない。

## 依存関係と検証

- Node.jsとpnpmは`mise.toml`で管理する。依存操作にはpnpmを使い、lockfileも更新する。
- 複数パッケージで使う依存は`pnpm-workspace.yaml`のcatalogにまとめ、各パッケージから`catalog:`で参照する。
- ドキュメントのコマンドには`mise exec --`を付けない。
- フォーマットはOxfmt、lintはOxlint、テストはVitestを使う。

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

変更範囲に合った検証を行う。ドキュメントだけの変更ではフォーマットと差分の確認でよい。同期動作の変更には、その動作を確認するテストを追加・更新する。ローカルテストの成功を、実際のAccess認証やモバイル端末での動作確認として報告しない。

## ドキュメント

- `README.md`は英語、`README.ja.md`は日本語とし、冒頭の相互リンクを維持する。共通の説明を変更する場合は両方に反映する。
- READMEには概要、特徴、導入手順を簡潔に書く。宣伝的なコピーや、求められていない実装詳細・注意書きを増やさない。
- 操作動画は冒頭の説明文の直後に置き、動画用の見出しや説明文を追加しない。

## CIとリリース

- 外部GitHub Actionsの`uses`は完全なコミットSHAで固定し、対応する正確なバージョンタグをコメントに書く。
- miseと依存インストールは`.github/actions/setup`にまとめる。
- format、lint、typecheck、test、buildは別ジョブにする。ジョブを追加・削除したら、集約する`Status check`の`needs`も更新する。
- `Status check`は依存ジョブが失敗しても実行し、全ジョブが成功した場合だけ成功させる。
- CIのpush対象は`main`。
- リリースはeasy-releaseで行う。Releaseワークフローを手動実行するとバージョン更新PRが作られ、マージするとプラグインをGitHub Releaseへ添付し、CLIをnpmへ公開する。CIは再実行しない。
- バージョンはeasy-releaseが全パッケージの`package.json`と`manifest.json`へ揃えて反映する。タグは`0.1.1`のように`v`を付けない。`versions.json`は`minAppVersion`を変えたときだけ更新する。
- Workerのデプロイはプラグインのリリースとは別に行う。

## Git操作

- コミット、push、リリース、デプロイはユーザーから依頼された範囲で行う。コミットの依頼だけでpushしない。
- コミットには対象の変更だけを含める。メッセージは`docs: 説明`のように、種別と日本語の説明で書く。
- コミットの署名を無効化しない。コミット後は署名と作業ツリーの状態を確認する。
