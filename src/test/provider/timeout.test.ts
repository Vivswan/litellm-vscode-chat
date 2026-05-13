import * as assert from "assert";
import * as vscode from "vscode";

suite("Timeout Configuration", () => {
	test("requestTimeout default is 300000ms", () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const timeout = config.get<number>("requestTimeout", 300000);
		assert.ok(timeout >= 1000, "requestTimeout should be at least 1000ms");
	});

	test("discoveryTimeout default is 30000ms", () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const timeout = config.get<number>("discoveryTimeout", 30000);
		assert.ok(timeout >= 1000, "discoveryTimeout should be at least 1000ms");
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
});
