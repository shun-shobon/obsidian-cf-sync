export interface SyncPlan {
  uploads: { path: string; action: "create" | "edit" | "delete" | "move" }[];
  downloads: { path: string; action: "write" | "delete" }[];
}
