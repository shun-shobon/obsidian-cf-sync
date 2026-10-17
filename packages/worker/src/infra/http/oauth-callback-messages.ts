import type { Context } from "hono";
import { accepts } from "hono/accepts";
import { createInstance } from "i18next";

// oxlint-disable-next-line import/no-empty-named-blocks, unicorn/require-module-specifiers -- Root tests type-check this module without the worker tsconfig, so the augmentation is imported explicitly.
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

type Locale = keyof typeof resources;

const i18n = createInstance();

void i18n.init({
	initAsync: false,
	lng: "en",
	fallbackLng: false,
	ns: ["callback"],
	defaultNS: "callback",
	resources,
});

export function getOAuthCallbackMessages(c: Context) {
	const locale = preferredLocale(c);

	return { locale, t: i18n.getFixedT(locale, "callback") };
}

function preferredLocale(c: Context): Locale {
	const accepted = accepts(c, {
		header: "Accept-Language",
		supports: Object.keys(resources),
		default: "en",
		match: (languages, config) => {
			for (const language of languages) {
				const base = language.type.toLowerCase().split("-")[0];

				if (language.q > 0 && isLocale(base)) {
					return base;
				}
			}

			return config.default;
		},
	});

	if (isLocale(accepted)) {
		return accepted;
	}

	return "en";
}

function isLocale(value: string | undefined): value is Locale {
	return value !== undefined && Object.hasOwn(resources, value);
}
