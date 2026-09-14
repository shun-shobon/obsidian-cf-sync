import { createInstance } from "i18next";

import { enErrors, jaErrors } from "./errors";
import type {} from "./i18next";
import { enSync, jaSync } from "./sync";

export const resources = {
  en: { syncCore: { errors: enErrors, sync: enSync } },
  ja: { syncCore: { errors: jaErrors, sync: jaSync } },
} as const;
const i18n = createInstance();
void i18n.init({
  resources,
  lng: "en",
  supportedLngs: ["en", "ja"],
  defaultNS: "syncCore",
  ns: ["syncCore"],
  initAsync: false,
  fallbackLng: false,
  interpolation: { escapeValue: false },
});
export const t = i18n.getFixedT(null, "syncCore");
export function setSyncLanguage(language: "en" | "ja"): void {
  void i18n.changeLanguage(language);
}
