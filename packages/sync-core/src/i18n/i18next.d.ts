import "i18next";
import type { resources } from "./index";

declare module "i18next" {
  interface AppResources {
    syncCore: (typeof resources)["en"]["syncCore"];
  }
  interface CustomTypeOptions {
    enableSelector: true;
    resources: AppResources;
  }
}
