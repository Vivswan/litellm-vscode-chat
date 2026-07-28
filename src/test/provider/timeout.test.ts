import * as assert from "node:assert";
import * as vscode from "vscode";
import { CONFIG_SECTION, MIN_TIMEOUT_MS, NUMBER_SETTING_SPECS } from "../../shared/settingSpec";

suite("Timeout Configuration", () => {
	// The extension host registered package.json's contributed configuration;
	// these tests pin the registered defaults to the shared setting spec
	// (settingSpec.test.ts pins the same numbers against the file on disk).
	test("requestTimeout default matches the setting spec", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const defaultValue = config.inspect<number>("requestTimeout")?.defaultValue;
		assert.strictEqual(defaultValue, NUMBER_SETTING_SPECS.requestTimeout.default);
	});

	test("discoveryTimeout default matches the setting spec", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const defaultValue = config.inspect<number>("discoveryTimeout")?.defaultValue;
		assert.strictEqual(defaultValue, NUMBER_SETTING_SPECS.discoveryTimeout.default);
	});

	test("headers default is empty object", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const defaultValue = config.inspect<Record<string, string>>("headers")?.defaultValue;
		assert.deepStrictEqual(defaultValue, {}, "headers default should be an empty object");
	});

	test("timeout configuration can be read from workspace settings", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const requestTimeout = config.get<number>("requestTimeout", NUMBER_SETTING_SPECS.requestTimeout.default);
		const discoveryTimeout = config.get<number>("discoveryTimeout", NUMBER_SETTING_SPECS.discoveryTimeout.default);

		// Verify defaults are sensible
		assert.strictEqual(typeof requestTimeout, "number");
		assert.strictEqual(typeof discoveryTimeout, "number");
		assert.ok(requestTimeout >= MIN_TIMEOUT_MS);
		assert.ok(discoveryTimeout >= MIN_TIMEOUT_MS);
	});

	test("custom headers configuration can be read from workspace settings", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const headers = config.get<Record<string, unknown>>("headers", {});
		assert.strictEqual(typeof headers, "object");
		assert.ok(headers !== null);
		assert.ok(!Array.isArray(headers));
	});
});
