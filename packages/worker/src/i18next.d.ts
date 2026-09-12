import type { en } from "./infra/http/oauth-callback-messages";

declare module "i18next" {
  interface AppResources {
    callback: typeof en;
  }

  interface CustomTypeOptions {
    enableSelector: true;
    resources: AppResources;
  }
}
