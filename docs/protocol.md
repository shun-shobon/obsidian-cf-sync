# 通信と永続化

通信データの正本は[`packages/protocol/src`](../packages/protocol/src)のValibotスキーマとする。Worker・プラグインの双方で入力を検証する。

## 認証と接続

Accessは`/api/*`を保護する。WorkerはJWTの署名・issuer・audience・所有者を検証する。Account DOが端末とVaultの登録を管理し、Vault DOが同期状態を管理する。Workerは端末とVaultの登録を確認し、検証済みの識別子をDOのRPCメソッドへ渡す。DOでも端末失効を確認する。

`/oauth/callback`は公開HTTPS中間ページから認可コードとstateをObsidianへ戻す。プラグインはPKCE verifierでコードを交換する。外部ブラウザとObsidianでCookieを共有する前提は置かない。

`/ws`はAccessの通常ログインを通さず、WorkerとDOが接続券を検証する。接続券は端末・Vaultに紐づき、30秒間有効で一度だけ使える。接続後も最長15分で閉じ、認証済みAPIで新しい接続券を取得する。端末失効時は既存接続も閉じる。

WebSocketはサーバーからの変更通知に使う。編集は250ms単位でHTTPへまとめ、通知を受けた端末はメタデータと本文を取得する。添付データをWebSocketには流さない。

## WorkerとDOの内部通信

公開APIはHonoで認証・入力検証・HTTP応答を扱い、Account DOとVault DOの型付きRPCメソッドを呼ぶ。端末失効のDO間通知もRPCを使う。WebSocketのUpgradeだけはDOの`fetch`へ渡す。

編集データ・全文・スナップショット・添付はRPCのストリームで渡し、通常のRPCシリアライズ上限に制限されないようにする。登録・失効・保存競合などの業務エラーは種類とメッセージを結果に含め、公開APIでHTTPステータスへ変換する。

## HTTP API

下表のパスは設定したサーバーオリジンを起点とする。Vault APIには`X-Device-Id`が必須で、未登録・失効済み端末を拒否する。

| メソッドとパス                      | 入力・結果                                               |
| ----------------------------------- | -------------------------------------------------------- |
| `POST /api/devices`                 | `{id,name}`で端末を登録。失効したIDは再登録不可          |
| `GET /api/devices`                  | 端末一覧                                                 |
| `DELETE /api/devices/:id`           | 端末を失効し、各Vaultの接続も閉じる                      |
| `GET /api/vaults`                   | Vault一覧                                                |
| `POST /api/vaults`                  | `{id,name}`でVaultを作成                                 |
| `GET /api/vaults/:id/snapshot`      | 全ファイルのメタデータ、除外、保存進捗                   |
| `GET /api/vaults/:id/files/:fileId` | Yjsの全状態または変更不能な添付参照                      |
| `POST /api/vaults/:id/operations`   | `Operation`を受け取り、DO保存後に`OperationResult`を返す |
| `PUT /api/vaults/:id/blobs/:uuid`   | 生バイト列を転送し、`BlobRef`を返す                      |
| `GET /api/vaults/:id/blobs/:uuid`   | 添付の生バイト列                                         |
| `PUT /api/vaults/:id/exclusions`    | `{exclusions:string[]}`で共有除外を更新                  |
| `POST /api/vaults/:id/tickets`      | 完全な接続URLと有効期限を返す                            |
| `GET /ws?vault=uuid&ticket=secret`  | WebSocketへ接続                                          |

添付PUTには`X-Content-Digest`（SHA-256）と`X-Content-Size`（バイト数）を付ける。サーバーは内容と長さを検証し、確定した長さのストリームとしてR2へ書く。同じID・同じ内容の再送は認め、異なる内容でのID再利用を拒否する。20MBをアプリケーションの上限にはしない。

## 編集と競合

ファイルIDとパスを分離する。`revision`と`pathRevision`はサーバーが単調増加で割り当てる。応答の`previousRevision`と`previousPathRevision`は、適用前の値を表す。クライアントは他端末の変更を含む応答で、未送信操作の競合判定基準を無条件に更新しない。

テキスト更新はbase64のYjs updateとする。作成と削除後の復旧には全状態を送れるようにし、本文は`getText('content')`へ格納する。再接続でも保存済みY.Docを使う。Undoはその端末のエディター操作だけを追跡する。

古い`baseRevision`による削除は、現在の本文を競合コピーへ保護してから元のIDを削除する。削除済みIDへの編集は、新しいIDの競合コピーとして受け入れる。古い`basePathRevision`による移動は現在のパスを返し、先に受理した移動を維持する。同じパスへの独立した新規作成も別名で保持する。

クライアントはIndexedDBへYjs状態・ファイルの基準状態・未送信操作を永続化する。送信を試した操作の`opId`と内容を固定し、同一操作の再送を可能にする。サーバーは受理結果を永続化して重複を排除する。

受信本文を書き込む前に、受信状態をIndexedDBへ記録する。起動時はローカル変更の走査より先にこの記録を回復し、本文だけ書込み済みの中断を独立した新規編集として取り込まない。

## R2反映

最新版は`vaults/<vaultId>/files/<path>`へ通常ファイルとして保存する。`staging/<vaultId>/<blobUUID>`は添付の内部保存先で、DOが参照する間は保持する。

変更とdirty登録・alarm設定を永続化し、通常10秒後にR2へ反映する。VaultのRPC処理・WebSocket接続処理・alarmを直列化し、古い反映処理が新しい変更を保存済み扱いにしない。移動は新しいパスへの書込み後に旧パスを消す。除外した既存ファイルはR2に残す。`r2Revision`はVaultの反映完了位置を示す。

R2はCRDT状態や履歴のバックアップではない。R2の直接編集を同期へ取り込む機能も持たない。
