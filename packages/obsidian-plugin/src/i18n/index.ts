import { enErrors, jaErrors } from "@cf-sync/sync-core/i18n/errors";
import { setSyncLanguage } from "@cf-sync/sync-core/i18n/index";
import { enSync, jaSync } from "@cf-sync/sync-core/i18n/sync";
import { createInstance } from "i18next";

import type {} from "./i18next";
import { enUI, jaUI } from "./ui";

export const resources = {
  en: { plugin: { ui: enUI, errors: enErrors, sync: enSync } },
  ja: { plugin: { ui: jaUI, errors: jaErrors, sync: jaSync } },
} as const;

const i18n = createInstance();

void i18n.init({
  resources,
  lng: "en",
  supportedLngs: ["en", "ja"],
  defaultNS: "plugin",
  ns: ["plugin"],
  initAsync: false,
  fallbackLng: false,
  interpolation: { escapeValue: false },
});

export const t = i18n.getFixedT(null, "plugin");

export function setLanguage(code: string): void {
  let language: "en" | "ja" = "en";

  if (code.toLowerCase().split("-")[0] === "ja") {
    language = "ja";
  }

  void i18n.changeLanguage(language);
  setSyncLanguage(language);
}
