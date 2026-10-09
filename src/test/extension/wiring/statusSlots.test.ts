import * as assert from "node:assert";
import * as vscode from "vscode";
import type { UsagePoller } from "../../../extension/servers/usage/poller";
import { liveStatusItemSlots, realStatusItemCreationCount } from "../../../extension/ui/status";
import { wireUsageSurfaces } from "../../../extension/wiring/dashboard";
import { wireStatusSurfaces } from "../../../extension/wiring/ui";
import { Logger } from "../../../shared/logger";
import { windowVerdict } from "../ui/verdictHarness";

function makeContext(): vscode.ExtensionContext {
	const store = new Map<string, unknown>();
	return {
		subscriptions: [],
		globalState: {
			get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
			update: async (key: string, value: unknown) => {
				store.set(key, value);
			},
		},
	} as unknown as vscode.ExtensionContext;
}

function makeLogger(lines: string[]): Logger {
	return new Logger(
		{
			info(message: string) {
				lines.push(message);
			},
			error() {},
		},
		{ appendLog: (line: string) => lines.push(line), recordError() {} }
	);
}

suite("extension/wiring statusSlots", () => {
	test("the two wiring modules claim distinct slots, each exactly once", () => {
		const before = realStatusItemCreationCount();
		const lines: string[] = [];
		const logger = makeLogger(lines);
		const context = makeContext();
		const origRegister = vscode.commands.registerCommand;
		const fakePoller = {
			store: {
				onDidChange: () => ({ dispose() {} }),
				getStates: () => [],
			},
			onDidRefresh: () => ({ dispose() {} }),
			onDidStartRefresh: () => ({ dispose() {} }),
		} as unknown as Pick<UsagePoller, "store" | "onDidRefresh" | "onDidStartRefresh">;
		try {
			// The usage wiring registers openUsage, which the activated dev extension already owns in this host;
			// capture instead of colliding. Stubbed inside the try so a throw below still restores it.
			(vscode.commands as Record<string, unknown>).registerCommand = () => ({ dispose() {} });
			wireStatusSurfaces(context, logger, () => false, windowVerdict().verdict);
			wireUsageSurfaces(context, logger, {
				usagePoller: fakePoller,
				dashboard: { open: () => {}, refresh: () => {} },
			});
			// The delta pins the wiring layer's whole status-item inventory, so a new slot must update it deliberately.
			assert.deepStrictEqual([...liveStatusItemSlots()].sort(), ["connection", "usage"]);
			assert.strictEqual(realStatusItemCreationCount() - before, 2);
			assert.ok(
				!lines.some((line) => line.includes("status-item slot replaced")),
				"composing the wiring modules must not double-claim a slot"
			);
		} finally {
			(vscode.commands as Record<string, unknown>).registerCommand = origRegister;
			for (const disposable of context.subscriptions) {
				disposable.dispose();
			}
		}
		assert.deepStrictEqual(liveStatusItemSlots(), []);
	});
});
