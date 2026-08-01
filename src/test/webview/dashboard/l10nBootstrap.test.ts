/**
 * The l10n bootstrap seam: bootstrapL10n reads the bundle the extension's
 * HTML shell injected and configures @vscode/l10n before the first render.
 * @vscode/l10n's configuration is module-global and sticky, so the
 * unconfigured-fallback tests run first and the afterAll resets to an empty
 * bundle for whatever runs later in the process.
 */
import { afterAll, expect, test } from "bun:test";
import * as l10n from "@vscode/l10n";
import { bootstrapL10n } from "../../../webview/dashboard/l10nBootstrap";

afterAll(() => {
	l10n.config({ contents: {} });
	delete window.__l10nBundle;
});

test("without an injected bundle t() falls back to the inline English message", () => {
	delete window.__l10nBundle;
	bootstrapL10n();

	expect(l10n.t("Manage LiteLLM Provider")).toBe("Manage LiteLLM Provider");
	expect(l10n.t("{0} models", 3)).toBe("3 models");
});

test("a malformed injected bundle is ignored", () => {
	window.__l10nBundle = { "Manage LiteLLM Provider": 42 };
	bootstrapL10n();

	expect(l10n.t("Manage LiteLLM Provider")).toBe("Manage LiteLLM Provider");
});

test("an injected bundle configures t() to resolve translations", () => {
	window.__l10nBundle = {
		"Manage LiteLLM Provider": "translated-title",
		"{0} models": "models: {0}",
	};
	bootstrapL10n();

	expect(l10n.t("Manage LiteLLM Provider")).toBe("translated-title");
	expect(l10n.t("{0} models", 3)).toBe("models: 3");
	// A key outside the bundle still falls back to its inline message.
	expect(l10n.t("Not in the bundle")).toBe("Not in the bundle");
});
