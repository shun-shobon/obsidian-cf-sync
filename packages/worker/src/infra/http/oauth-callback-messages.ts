import type { Context } from "hono";
import { accepts } from "hono/accepts";
import { createInstance } from "i18next";

import type {} from "../../i18next";

export const en = {
  invalidCallback: "Invalid OAuth callback",
  heading: "Return to Obsidian",
  openObsidian: "Open Obsidian to finish signing in",
} as const;

const ja = {
  invalidCallback: "無効な OAuth コールバックです",
  heading: "Obsidian に戻る",
  openObsidian: "Obsidian を開いてログインを完了する",
} satisfies Record<keyof typeof en, string>;

const resources = { en: { callback: en }, ja: { callback: ja } };
const i18n = createInstance();

void i18n.init({
  initAsync: false,
  lng: "en",
  fallbackLng: false,
  ns: ["callback"],
  defaultNS: "callback",
  resources,
  interpolation: { escapeValue: false },
});

export function getOAuthCallbackMessages(c: Context) {
  const acceptedLanguage = accepts(c, {
    header: "Accept-Language",
    supports: ["en", "ja"],
    default: "en",
    match: (languages, config) => {
      for (const language of languages) {
        const base = language.type.toLowerCase().split("-")[0];

        if (language.q > 0 && (base === "ja" || base === "en")) {
          return base;
        }
      }

      return config.default;
    },
  });
  let locale: keyof typeof resources = "en";

  if (acceptedLanguage === "ja") {
    locale = "ja";
  }

  return { locale, t: i18n.getFixedT(locale, "callback") };
}
