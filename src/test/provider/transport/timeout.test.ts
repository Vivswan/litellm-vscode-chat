import * as assert from "node:assert";
import * as vscode from "vscode";
import { CONFIG_SECTION, MIN_TIMEOUT_MS, NUMBER_SETTING_SPECS } from "../../../shared/config/settingSpec";

suite("Timeout Configuration", () => {
	// The extension host registered package.json's contributed configuration;
	// these tests pin the registered defaults to the shared setting spec
	// (settingSpec.test.ts pins the same numbers against the file on disk).
	test("chat.timeout default matches the setting spec", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const defaultValue = config.inspect<number>("chat.timeout")?.defaultValue;
		assert.strictEqual(defaultValue, NUMBER_SETTING_SPECS["chat.timeout"].default);
	});

	test("discovery.timeout default matches the setting spec", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const defaultValue = config.inspect<number>("discovery.timeout")?.defaultValue;
		assert.strictEqual(defaultValue, NUMBER_SETTING_SPECS["discovery.timeout"].default);
	});

	test("timeout configuration can be read from workspace settings", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const requestTimeout = config.get<number>("chat.timeout", NUMBER_SETTING_SPECS["chat.timeout"].default);
		const discoveryTimeout = config.get<number>("discovery.timeout", NUMBER_SETTING_SPECS["discovery.timeout"].default);

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
