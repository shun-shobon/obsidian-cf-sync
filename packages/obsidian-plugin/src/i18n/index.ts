import { enErrors as enSyncErrors, jaErrors as jaSyncErrors } from "@cf-sync/sync-core/i18n/errors";
import { setSyncLanguage } from "@cf-sync/sync-core/i18n/index";
import { createInstance } from "i18next";

import { enErrors, jaErrors } from "./errors";
// oxlint-disable-next-line import/no-empty-named-blocks, unicorn/require-module-specifiers -- i18next.d.tsの型拡張を読み込むための型専用import
import type {} from "./i18next";
import { enUI, jaUI } from "./ui";

export const resources = {
	en: { plugin: { ui: enUI, errors: { ...enSyncErrors, ...enErrors } } },
	ja: { plugin: { ui: jaUI, errors: { ...jaSyncErrors, ...jaErrors } } },
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
