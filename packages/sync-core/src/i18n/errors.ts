export const enErrors = {
	websocketDisconnected: "The WebSocket connection was lost.",
	missingAttachment: "Pending attachment data is missing.",
	missingIncoming: "Incoming file data is missing.",
	recoveryChanged: "The file changed during recovery. Retrying.",
	websocketTimeout: "The WebSocket connection timed out.",
	missingCrdt: "Local CRDT state for the conflicting note is missing.",
	syncFailed: "Sync failed.",
	serverUnavailable: "Could not connect to the sync server.",
	accessDenied: "Check your authentication and device permissions.",
	documentDeleted: "The requested file has been deleted.",
	apiFailed: "Sync API error ({{status}})",
} as const;

export const jaErrors = {
	websocketDisconnected: "WebSocket が切断されました",
	missingAttachment: "未送信の添付データがありません",
	missingIncoming: "受信中のファイルデータがありません",
	recoveryChanged: "受信回復中にファイルが変更されました。再試行します",
	websocketTimeout: "WebSocket 接続がタイムアウトしました",
	missingCrdt: "競合ノートのローカル CRDT 状態がありません",
	syncFailed: "同期処理に失敗しました",
	serverUnavailable: "同期サーバーに接続できません",
	accessDenied: "認証または端末の許可を確認してください",
	documentDeleted: "対象ファイルは削除されています",
	apiFailed: "同期 API エラー ({{status}})",
} as const satisfies Record<keyof typeof enErrors, string>;
