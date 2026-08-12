/**
 * The wiring layer's status-item lane assignment: the two wiring modules
 * that construct status items claim DISTINCT slots (wiring/ui.ts the
 * connection item, wiring/dashboard.ts the usage item), each exactly once
 * per activation. The slot registry's own semantics under a double claim
 * (self-heal with a replacement log) are pinned in statusItemRegistry.test.ts;
 * this suite pins the layer the wiring split introduced - that composing
 * both modules yields one live item per slot, both slots.
 */

import * as assert from "node:assert";
import * as vscode from "vscode";
import type { UsagePoller } from "../../../extension/servers/usage";
import { liveStatusItemSlots, realStatusItemCreationCount } from "../../../extension/ui/status";
import { wireUsageSurfaces } from "../../../extension/wiring/dashboard";
import { wireStatusSurfaces } from "../../../extension/wiring/ui";
import { Logger } from "../../../shared/logger";

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
		} as unknown as Pick<UsagePoller, "store" | "onDidRefresh">;
		try {
			// The usage wiring registers the openUsage command, which the activated
			// dev extension already owns in this host; capture instead of colliding.
			// Stubbed inside the try so a throw below still restores it.
			(vscode.commands as Record<string, unknown>).registerCommand = () => ({ dispose() {} });
			wireStatusSurfaces(context, logger, () => false);
			wireUsageSurfaces(context, logger, {
				usagePoller: fakePoller,
				dashboard: { open: () => {}, refresh: () => {} },
			});
			// One live item per slot, both slots, and no self-heal replacement
			// fired: each wiring module stayed in its own lane. The delta pins
			// the wiring layer's whole status-item inventory - one connection
			// item plus one usage item; a new slot or a conditional surface must
			// update this count deliberately.
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
