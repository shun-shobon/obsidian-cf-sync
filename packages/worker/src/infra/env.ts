export interface Env {
  ACCOUNT: DurableObjectNamespace;
  VAULTS: DurableObjectNamespace;
  BUCKET: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
}
