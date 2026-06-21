import * as assert from "assert";
import * as vscode from "vscode";

suite("Timeout Configuration", () => {
	test("requestTimeout default is 300000ms", () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const defaultValue = config.inspect<number>("requestTimeout")?.defaultValue;
		assert.strictEqual(defaultValue, 300000, "requestTimeout default should be 300000ms");
	});

	test("discoveryTimeout default is 30000ms", () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const defaultValue = config.inspect<number>("discoveryTimeout")?.defaultValue;
		assert.strictEqual(defaultValue, 30000, "discoveryTimeout default should be 30000ms");
	});

	test("headers default is empty object", () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const defaultValue = config.inspect<Record<string, string>>("headers")?.defaultValue;
		assert.deepStrictEqual(defaultValue, {}, "headers default should be an empty object");
	});

	test("timeout configuration can be read from workspace settings", () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const requestTimeout = config.get<number>("requestTimeout", 300000);
		const discoveryTimeout = config.get<number>("discoveryTimeout", 30000);

		// Verify defaults are sensible
		assert.strictEqual(typeof requestTimeout, "number");
		assert.strictEqual(typeof discoveryTimeout, "number");
		assert.ok(requestTimeout >= 1000);
		assert.ok(discoveryTimeout >= 1000);
	});

	test("custom headers configuration can be read from workspace settings", () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const headers = config.get<Record<string, unknown>>("headers", {});
		assert.strictEqual(typeof headers, "object");
		assert.ok(headers !== null);
		assert.ok(!Array.isArray(headers));
	});
});
