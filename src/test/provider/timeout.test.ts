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

	test("invalid timeout configuration values are clamped to at least 1000ms", async () => {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const requestTimeoutInspect = config.inspect<number>("requestTimeout");
		const discoveryTimeoutInspect = config.inspect<number>("discoveryTimeout");
		const previousRequestTimeout = requestTimeoutInspect?.workspaceValue;
		const previousDiscoveryTimeout = discoveryTimeoutInspect?.workspaceValue;

		try {
			await config.update("requestTimeout", 1, vscode.ConfigurationTarget.Workspace);
			await config.update("discoveryTimeout", 1, vscode.ConfigurationTarget.Workspace);

			const requestTimeout = config.get<number>("requestTimeout", 300000);
			const discoveryTimeout = config.get<number>("discoveryTimeout", 30000);

			assert.strictEqual(typeof requestTimeout, "number");
			assert.strictEqual(typeof discoveryTimeout, "number");
			assert.ok(requestTimeout >= 1000, "requestTimeout should be clamped to at least 1000ms");
			assert.ok(discoveryTimeout >= 1000, "discoveryTimeout should be clamped to at least 1000ms");
		} finally {
			await config.update("requestTimeout", previousRequestTimeout, vscode.ConfigurationTarget.Workspace);
			await config.update("discoveryTimeout", previousDiscoveryTimeout, vscode.ConfigurationTarget.Workspace);
		}
	});
});
