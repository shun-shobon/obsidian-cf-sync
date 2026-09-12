# Obsidian CF Sync 初版仕様

本プラグインは、自分の複数端末にあるObsidian Vaultを同期する。Cloudflare WorkersをAPIと認証の入口、Durable Objects（DO）を同期の調整役、R2を最新版のファイル保存先として使う。Markdownは文字単位で同時編集でき、オフラインの編集も再接続時に統合する。

この文書は2026年9月9日の仕様面談で合意した初版の範囲を記録する。初期実装と自動テストを追加しており、実施済みの検証と残る制約は[検証記録](validation.md)に記載する。技術検証が必要な項目を末尾に区別している。

## 利用範囲

- 単一ユーザーの個人利用とする。複数Vaultを独立して同期できる。
- 他人への共有、招待、利用者別の権限は設けない。
- 対応対象はmacOS、Windows、Linux、iOS、Androidとする。
- 初版の実機検証はmacOSとiOSで行う。Windows、Linux、Androidは実機未検証であることを明記する。
- 1 Vaultあたり1万ファイル、合計1 GB、5端末を検証目標とする。
- 添付は20 MBまでを検証範囲とし、それを超えても同期を試す。20 MBを製品のサイズ上限にはしない。
- Workersの月5ドル程度の基本費用を許容する。R2等の従量料金は別途見積もり、月5ドル以内を保証するものではない。

## 構成と保存先

推奨構成は次のとおりとする。DOの分割など、試作で性能を確認すべき事項は実装済みの事実として扱わない。

| 要素               | 責務                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Obsidianプラグイン | ローカルファイル、エディター連携、同期済みの基準状態、未送信変更、同期UI                     |
| Worker             | HTTP API、認証、接続券の発行・検証、DOへのルーティング                                       |
| VaultごとのDO      | ファイル識別・パスの管理、変更の調整、Markdownの同時編集状態、永続保存、端末への配信、R2反映 |
| R2                 | 元のパスが分かる形式で保存された最新のMarkdownと添付などの通常ファイル                       |

Markdownの同時編集はYjsを第一候補とする。ノート単位の状態を必要に応じて読み込み、Vault全体の本文を常時メモリーへ載せる前提にしない。

変更は端末からDOへ送り、DOへの永続保存とR2への反映を分ける。メモリーに受け取っただけでサーバー保存済みと扱わない。

- 通常回線で、Markdown編集が別端末へおおむね1秒以内に反映されることを目標とする。
- DOが受理した変更は、通常時におおむね10秒以内にR2へ反映する。連続編集中も反映を続ける。
- 通信やR2に障害がある場合、この時間を保証せず、未反映状態を表示して再試行する。
- R2への書き込み失敗を同期完了として表示しない。

R2はファイルごとの保存済み最新版を取り出すための保存先とする。複数ファイルを厳密に同一時点へ戻す保証は設けない。同時編集の内部状態をR2から復元して既存端末との同期をそのまま再開する機能も含めない。

R2の直接編集を変更の入力元にしない。変更受付はプラグイン経由に統一する。R2の閲覧・取り出しは可能とするが、DOの状態を失った場合の専用復旧コマンド、復旧画面、自動復旧は初版に含めない。

## 無操作時の通信

無操作時の定期同期、heartbeat、時間経過によるWebSocketの強制再接続は行わない。接続を維持し、DOはWebSocket Hibernation APIで休眠できる構成とする。

同期はローカル編集・変更通知・起動・復帰・手動操作を契機に行う。切断や通信失敗を検知した場合は、待機時間を段階的に延ばして再接続する。検知できない回線断があるときは、操作・復帰・手動同期まで他端末の変更反映が遅れることを許容する。

接続時は認証し、端末失効時には既存接続を切断する。Accessの認証期限だけでは接続済みWebSocketを切断しない。HTTP操作と次回接続には引き続き認証を要求する。

## 同期対象と除外

通常ファイル全体を同期する。Markdownは文字単位、画像・PDF・Canvasその他のファイルはファイル単位で扱う。`.obsidian`とその他の隠し管理ファイルは初版の同期対象から外す。

同期から除外するパスを指定できる。除外設定はVault単位で全端末に共通とする。

- 同期済みのパスを除外しても、端末・サーバーの既存データは削除しない。
- 除外後は、そのパスの変更を同期しない。
- 除外を解除したら差分を照合し、競合する内容を保護する。

モバイルでも添付を含む全体を自動ダウンロードする。モバイル回線でも同期し、必要に応じてユーザーが一時停止する。添付の必要時取得やWi-Fi限定同期は作らない。

Obsidian以外のエディターや他プラグインによるファイル変更も取り込む。取り込む変更の基準を判断できない場合は、推測で内容を上書きせず、別名のファイルとして保護して通知する。

## 編集とオフライン

MarkdownのソースモードとLive Previewで同時編集する。日本語IME、同じノートを開く複数ペイン、自端末の操作だけを取り消すUndoを検証対象とする。別端末のカーソル・選択範囲は表示しない。

オフラインでも編集でき、未送信変更をローカルに保持する。アプリ終了時の処理だけに保存を依存させない。モバイルではObsidianを開いている間に同期し、起動・復帰・再接続で再開する。バックグラウンドやアプリ終了後の同期は保証しない。

長期未接続の端末にも期間による再登録を要求しない。同期は次の方針とする。

1. 端末に最後に同期した基準状態と未送信変更を保持する。
2. 利用可能な差分があれば差分同期する。
3. 古い差分が残っていなければ、サーバーの最新一覧と端末の基準状態を照合する。
4. 未送信編集を保持して、下記の競合方針に従って取り込む。

全操作ログや削除した本文の履歴を永久保存する設計にはしない。ただし、本文の履歴とCRDTの統合に必要な内部状態は区別する。ファイル一覧の照合だけで文字単位の統合が成立するとはみなさず、長期オフライン端末の編集と状態整理の両立を試作で確認する。

CRDTで編集操作が収束しても文章の意味が自然になる保証はない。同じ文章への同時変更によって手直しが必要になることは許容する。

## ファイル操作と競合

ファイルはパスだけでなく識別子で追跡し、名前変更・移動と本文編集を区別する。

| 状況                           | 初版の動作                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| 同じMarkdownへの同時編集       | 文字単位で統合する                                                                       |
| 削除と未反映の編集が競合       | 元ファイルは削除し、編集内容を別名の復旧コピーに残して通知する                           |
| 同じファイルを異なる場所へ移動 | 先にサーバーで確定した移動を採用する。本文は同じファイルに統合し、競合した移動を通知する |
| 添付・Canvas等の同時変更       | 一方を別名の競合コピーにして両方保持し、通知する                                         |
| 別端末で同じパスに新規作成     | 両方を別名で保持する。独立に作ったMarkdownを同名という理由だけで統合しない               |

既存ファイルのあるVaultも初めての接続先にできる。初回は差分を確認し、同じパス・同じ内容は同一として扱う。内容が異なるものは確認画面を出し、別名で保護する。

過去の本文履歴や世代別の添付は保存しない。競合時の復旧コピーは現在のファイルとして保持するもので、履歴機能とは区別する。

## 認証と端末管理

ログインにはCloudflare AccessのManaged OAuthを使う。外部ブラウザのCookieとObsidian内部のCookieの共有を前提にしない。

1. プラグインからブラウザを開き、Accessでログインする。
2. HTTPSの中間ページを経由してObsidianへ認可コードを引き渡す。
3. プラグインでトークンを取得し、認証済みHTTPでWebSocket接続券を要求する。
4. 短命・一回限りの接続URLを使い、Workerが接続前に検証・消費する。
5. 再接続時は新しい接続券を取得する。

接続券は端末と接続先Vaultに紐づける。有効期限30秒は推奨初期値であり、合意した固定要件ではない。OAuthのアクセストークンやリフレッシュトークン自体は接続URLへ入れない。

接続券発行のHTTP APIはAccessで保護し、WebSocket入口はWorker自身が接続券を認証する。独自の接続券をCloudflare Accessが認識する前提にしない。

端末の一覧確認・失効はプラグイン設定から行う。接続中のWebSocketも端末失効を反映できるようにする。接続後の認証期限、再認証方法、認可コード交換の保護、トークンのローカル保存方法は認証試作で具体化する。

再ログイン間隔は30日を希望条件とする。Managed OAuthの設定として実現可能か確認する。期限切れや失効時もローカルの未送信編集は失わず、認証できるまで同期を停止する。

E2EEは導入しない。自分のCloudflare環境で本文を処理することを許容し、通信暗号化と認証を使う。

## 操作画面と配布

初版のUIは次の範囲にする。

- ローカルの未送信状態、DOへの保存、R2反映待ち・反映完了、認証や通信のエラーを区別する状態表示。
- 同期の一時停止・再開と手動同期。
- 競合ファイルの一覧。
- 認証、接続先Vault、端末管理、除外設定を扱う設定画面。

競合内容を編集する専用の差分画面や履歴画面は設けない。

公開GitHubリポジトリのReleasesとBRATで配布する。リリースには`main.js`、`manifest.json`、必要な場合は`styles.css`を添付する。モバイルを含む導入・更新手順と、自分のCloudflare環境へのサーバーデプロイ手順を用意する。認証情報はリポジトリや配布物へ含めない。

公開リポジトリで配布する方針への合意は、今回の文書化作業で外部公開・デプロイを実行する指示ではない。

## 実装前の検証と完了条件

次の順序で技術検証する。成立しない点を無断で別方式へ置き換えず、結果を示して必要な仕様だけ見直す。

1. **エディター連携**：YjsとObsidianの日本語IME、Live Preview、複数ペイン、Undo、外部ファイル変更の組み合わせを確認する。
2. **認証**：macOS・iOSでブラウザ認証、中間ページからの復帰、トークン取得・更新、再起動後の保持、短命URLによる接続、端末失効を確認する。Managed OAuthはBetaであり、30日の設定も確認する。
3. **同期状態**：異なる順序・重複した更新、オフライン編集、古い差分がない場合の一覧照合を検証する。CRDT状態の整理後も長期離脱端末の変更を扱えるか確認する。
4. **ファイル操作**：削除対編集、移動対編集、移動先の競合、同名作成、添付競合、初回照合、除外解除を検証する。大文字小文字やOSで扱えないパスの判定も具体化する。
5. **耐久保存**：DO再起動、R2反映中の失敗・再試行、モバイルの中断・再開を検証する。R2への再試行で新しい内容を古い内容へ戻さないことを確認する。
6. **規模と配布**：合意した規模と反映時間を検証し、利用量から費用を見積もる。GitHub ReleasesとBRATによるmacOS・iOSの導入・更新を確認する。

実装前に確定していない内部事項には、ローカル状態の保存形式、差分保持の具体的な期間、CRDT状態の整理方法、R2キー配置、転送の分割方法、除外指定の構文、最小Obsidianバージョンがある。これらは上記要件を満たす最小構成で決める。利用時の動作や保証範囲が変わる場合は再確認する。

## 調査資料

以下は設計判断に参照した資料であり、このプラグインの実機検証結果ではない。

### Obsidianと同時編集

- [モバイル開発](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)：Node.js・Electron依存をモバイルへ持ち込めない制約。
- [公開API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)：Vaultイベント、エディター拡張、終了処理の保証範囲。
- [エディター拡張](https://docs.obsidian.md/Plugins/Editor/Editor%20extensions)と[YjsのCodeMirror連携](https://github.com/yjs/y-codemirror.next)：同時編集の候補。Obsidianとの組み合わせは要検証。
- [Yjs更新API](https://docs.yjs.dev/api/document-updates/)：更新の統合とstate vector。更新の結合だけでは削除済み内容のGCにならない。
- [Remotely Save](https://github.com/remotely-save/remotely-save)：R2・モバイル対応の既存例と、大きなファイル・設定同期の留意点。
- [Self-hosted LiveSyncの競合仕様](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_conflict_resolution.md)：本文以外のファイル操作を独立に扱う参考。

### Cloudflareと認証

- [DO WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)と[DOストレージ](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)：休眠時のメモリー消失と永続化。
- [DO Alarm](https://developers.cloudflare.com/durable-objects/api/alarms/)：再試行の保証範囲。
- [R2整合性](https://developers.cloudflare.com/r2/reference/consistency/)、[R2制限](https://developers.cloudflare.com/r2/platform/limits/)、[Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：保存順序、同一キーの書き込み頻度、条件付き書き込み。
- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)：認可・更新、HTTPSリダイレクト、opaque token。
- [WebSocket認証](https://developers.cloudflare.com/agents/runtime/operations/cross-domain-authentication/)：短命URLとCookieの条件。
- [ObsidianのCookie報告](https://forum.obsidian.md/t/requesturl-and-cookies-and-redirects/107820)：2025年11月の開発者報告。モバイルのWebSocketとのCookie共有を証明するものではない。
- [Workerを対象としたAccess設定でのWebSocket失敗報告](https://github.com/cloudflare/cloudflare-docs/issues/31885)：2026年7月の利用者報告。公式仕様や現在の全環境の挙動としては扱わない。
- [Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[DO料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[R2料金](https://developers.cloudflare.com/r2/pricing/)：実装時の見積もりで再確認する。

### 配布

- [BRAT利用手順](https://tfthacker.com/brat-plugins)
- [BRAT開発者資料](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)
- [Obsidianリリース要件](https://docs.obsidian.md/plugins/releasing/submit-plugin)
