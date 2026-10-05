import * as assert from "node:assert";
import * as vscode from "vscode";
import type { SecretStore } from "../../../extension/servers/serverSync/secrets";
import { updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import { wireKnownSecrets } from "../../../extension/wiring/knownSecrets";
import { Logger } from "../../../shared/logger";

/** A SecretStorage whose reads wait on `gate`, so the window between a setting change and its blob read is testable. */
function gatedSecrets(blob: string): { secrets: vscode.SecretStorage; open(): void } {
	let open = (): void => {};
	let gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	return {
		secrets: {
			get: async () => {
				await gate;
				gate = new Promise<void>((resolve) => {
					open = resolve;
				});
				return blob;
			},
			store: async () => {},
			delete: async () => {},
			onDidChange: () => new vscode.Disposable(() => {}),
		} as unknown as vscode.SecretStorage,
		open: () => open(),
	};
}

suite("extension/wiring knownSecrets", () => {
	test("a key typed into the setting, or written into a blob, is known before any read lands", async () => {
		// The blob reads are asynchronous; a line quoting the new key between the setting change and their return
		// would otherwise reach the channel and the issue report with the key in it. A value this window writes is
		// known from the write itself: SecretStorage's change event carries no value.
		const origGet = vscode.workspace.getConfiguration;
		const origOn = vscode.workspace.onDidChangeConfiguration;
		let raw: unknown = [{ label: "Fast", baseUrl: "http://fast.test", auth: { apiKey: "old-key-Q7" } }];
		let listener: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
		(vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({ get: () => raw });
		(vscode.workspace as { onDidChangeConfiguration: unknown }).onDidChangeConfiguration = (
			handler: (event: vscode.ConfigurationChangeEvent) => void
		) => {
			listener = handler;
			return new vscode.Disposable(() => {});
		};
		const gated = gatedSecrets(JSON.stringify({ apiKey: "stored-Q7" }));
		const context = { subscriptions: [], secrets: gated.secrets } as unknown as vscode.ExtensionContext;
		const published: (readonly string[])[] = [];
		try {
			const activation = wireKnownSecrets(context, new Logger({ info() {}, error() {} }), (values) =>
				published.push(values)
			);
			gated.open();
			await activation;
			raw = [{ label: "Fast", baseUrl: "http://fast.test", auth: { apiKey: "new-key-Q7" } }];
			(listener as (event: vscode.ConfigurationChangeEvent) => void)({
				affectsConfiguration: () => true,
			} as unknown as vscode.ConfigurationChangeEvent);
			const atReturn = published.length;
			// A write whose store is still pending while the refresh's read lands: the refresh began before the landing,
			// so it must not retire the value; the next refresh, begun after the landing, may.
			const memory = new Map<string, string>();
			let landStore = (): void => {};
			const storeGate = new Promise<void>((resolve) => {
				landStore = resolve;
			});
			const store: SecretStore = {
				get: async (key) => memory.get(key),
				store: async (key, value) => {
					await storeGate;
					memory.set(key, value);
				},
				delete: async (key) => {
					memory.delete(key);
				},
			};
			const write = updateServerSecret(store, "Other", "apiKey", "written-Q7", undefined);
			await new Promise((resolve) => setTimeout(resolve, 0));
			gated.open();
			await new Promise((resolve) => setTimeout(resolve, 0));
			const whilePending = published.length;
			landStore();
			await write;
			(listener as (event: vscode.ConfigurationChangeEvent) => void)({
				affectsConfiguration: () => true,
			} as unknown as vscode.ConfigurationChangeEvent);
			gated.open();
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.deepStrictEqual(
				{ atReturn, whilePending, published },
				{
					atReturn: 3,
					whilePending: 5,
					published: [
						["old-key-Q7"],
						["old-key-Q7", "stored-Q7"],
						["new-key-Q7", "stored-Q7"],
						["new-key-Q7", "stored-Q7", "written-Q7"],
						["new-key-Q7", "stored-Q7", "written-Q7"],
						["new-key-Q7", "stored-Q7", "written-Q7"],
						["new-key-Q7", "stored-Q7"],
					],
				}
			);
		} finally {
			(vscode.workspace as { getConfiguration: unknown }).getConfiguration = origGet;
			(vscode.workspace as { onDidChangeConfiguration: unknown }).onDidChangeConfiguration = origOn;
		}
	});
});
