export const enSync = {
  moveRejected: "Move rejected: path changed or destination occupied",
  editPreserved: "Concurrent edit preserved before deletion",
  contentPreserved: "Concurrent contents preserved as conflict copy",
  conflictPreserved: "Conflicting content was preserved under a different name.",
  deletedRecovered:
    "Incoming content that conflicted with a deletion was preserved in a recovery copy.",
  interruptedRecovered: "Content changed during the interruption was preserved in a recovery copy.",
  conflictReceived: "A conflict file was synced.",
} as const;

export const jaSync = {
  moveRejected: "パスが変更されたか移動先が使用中のため、移動できませんでした",
  editPreserved: "同時に編集された内容を削除前に保護しました",
  contentPreserved: "同時に変更された内容を競合コピーとして保護しました",
  conflictPreserved: "競合内容を別名で保護しました",
  deletedRecovered: "削除と競合した受信内容を復旧コピーへ保護しました",
  interruptedRecovered: "中断中に変更された内容を復旧コピーへ保護しました",
  conflictReceived: "競合ファイルを同期しました",
} as const satisfies Record<keyof typeof enSync, string>;
