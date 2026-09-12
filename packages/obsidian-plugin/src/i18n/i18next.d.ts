import "i18next";
import type { resources } from "./index";

declare module "i18next" {
  interface AppResources {
    plugin: (typeof resources)["en"]["plugin"];
  }

  interface CustomTypeOptions {
    enableSelector: true;
    resources: AppResources;
  }
}
