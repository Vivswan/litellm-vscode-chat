/**
 * The l10n bootstrap seam: bootstrapL10n reads the bundle the extension's
 * HTML shell injected and configures @vscode/l10n before the first render.
 * @vscode/l10n's configuration is module-global and sticky, so ordering is
 * load-bearing: the unconfigured-fallback case runs first, the rejection
 * cases run after a successful configuration (proving a bad injection cannot
 * clobber it), and the afterAll resets to an empty bundle for whatever runs
 * later in the process.
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

test("malformed injections are rejected wholesale and the configured bundle survives", () => {
	const badBundles: unknown[] = [
		{ "Manage LiteLLM Provider": 42 },
		// The {message, comment} shape is legal only in the generated English
		// reference; an injected bundle must be flat strings.
		{ "Manage LiteLLM Provider": { message: "clobbered", comment: ["c"] } },
		["Manage LiteLLM Provider"],
		"Manage LiteLLM Provider",
		null,
	];
	for (const bad of badBundles) {
		window.__l10nBundle = bad;
		bootstrapL10n();

		expect(l10n.t("Manage LiteLLM Provider")).toBe("translated-title");
	}
});

test("prototype-polluting keys are dropped while honest keys still configure", () => {
	// JSON.parse creates an own "__proto__" property, matching what a hostile
	// injected payload would carry.
	window.__l10nBundle = JSON.parse('{"__proto__": "polluted", "Manage LiteLLM Provider": "safe-title"}');
	bootstrapL10n();

	expect(l10n.t("Manage LiteLLM Provider")).toBe("safe-title");
	// The dropped key resolves like any absent key, and nothing leaked into
	// the object prototype.
	expect(l10n.t("__proto__")).toBe("__proto__");
	expect(Object.getPrototypeOf({})).toBe(Object.prototype);
});
