/**
 * The status-item slot registry's pins: the singleton-creation-points source scan, the
 * one-live-item-per-slot lifecycle, and the self-heal on double construction. The
 * lifecycle tests create REAL items on purpose - each ends with every created item
 * disposed, so nothing survives into the shared host's status bar.
 */

import * as assert from "node:assert";
import * as vscode from "vscode";
import type { StatusItemView } from "../../../extension/ui/status";
import {
	liveStatusItemSlots,
	realStatusItemCreationCount,
	StatusBarManager,
	StatusItem,
} from "../../../extension/ui/status";
import type { UsageStatusBarOptions } from "../../../extension/ui/usageStatusItem";
import { UsageStatusBar } from "../../../extension/ui/usageStatusItem";
import { Logger } from "../../../shared/logger";
import { countOccurrences, shippedSources } from "../../sourceScan";

/**
 * Each singleton vscode surface and the one file allowed to create it. A second creation
 * point bypasses the surface's ownership: a status item outside the slot registry escapes
 * the one-live-item-per-slot invariant, a second output channel splits the log stream the
 * issue-report buffer taps, and a second webview panel escapes the one-panel lifecycle.
 */
const SINGLETON_CREATION_POINTS: readonly { readonly api: string; readonly file: string }[] = [
	{ api: "createStatusBarItem", file: "src/extension/ui/status.ts" },
	{ api: "createOutputChannel", file: "src/extension.ts" },
	{ api: "createWebviewPanel", file: "src/extension/dashboard/panel.ts" },
];

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

suite("extension/ui statusItemRegistry", () => {
	test("every singleton vscode surface has exactly one creation call in src/", () => {
		const sources = shippedSources();
		for (const { api, file } of SINGLETON_CREATION_POINTS) {
			// Match call expressions, not bare names: prose comments may name an
			// API without calling it.
			const call = `${api}(`;
			const callers = sources.filter((source) => source.text.includes(call));
			assert.deepStrictEqual(
				callers.map((source) => source.file),
				[file],
				api
			);
			assert.strictEqual(
				countOccurrences(callers[0]?.text ?? "", call),
				1,
				`${api} must have exactly one call in ${file}`
			);
		}
	});

	test("creating into an occupied slot disposes the previous holder and logs the replacement", () => {
		const before = realStatusItemCreationCount();
		const lines: string[] = [];
		const log = (message: string) => lines.push(message);
		const first = new StatusItem({
			slot: "usage",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 99,
			command: "litellm.openDashboard",
			log,
		});
		try {
			assert.deepStrictEqual(liveStatusItemSlots(), ["usage"]);
			const second = new StatusItem({
				slot: "usage",
				alignment: vscode.StatusBarAlignment.Right,
				priority: 99,
				command: "litellm.openDashboard",
				log,
			});
			try {
				// One live item per slot survives, and the double construction is
				// observable in the log rather than as twin items.
				assert.deepStrictEqual(liveStatusItemSlots(), ["usage"]);
				assert.deepStrictEqual(lines, ["status-item slot replaced: usage"]);
				// The stale holder's late dispose must not evict the live item.
				first.dispose();
				assert.deepStrictEqual(liveStatusItemSlots(), ["usage"]);
			} finally {
				second.dispose();
			}
		} finally {
			first.dispose();
		}
		assert.deepStrictEqual(liveStatusItemSlots(), []);
		assert.strictEqual(realStatusItemCreationCount() - before, 2);
	});

	test("constructing StatusBarManager twice leaves one live connection item", () => {
		const lines: string[] = [];
		const logger = makeLogger(lines);
		const makeManager = () => {
			const context = makeContext();
			const manager = new StatusBarManager(
				context,
				logger,
				() => false,
				() => [],
				new StatusItem({
					slot: "connection",
					alignment: vscode.StatusBarAlignment.Right,
					priority: 100,
					command: "litellm.openDashboard",
					log: (message) => lines.push(message),
				})
			);
			return { manager, context };
		};
		const first = makeManager();
		const second = makeManager();
		try {
			// The double construction healed itself: exactly one live item.
			assert.deepStrictEqual(liveStatusItemSlots(), ["connection"]);
			assert.ok(lines.includes("status-item slot replaced: connection"));
		} finally {
			for (const { context } of [first, second]) {
				for (const disposable of context.subscriptions) {
					disposable.dispose();
				}
			}
		}
		assert.deepStrictEqual(liveStatusItemSlots(), []);
	});

	test("render maps severities onto the theme backgrounds without leaking items", () => {
		const item = new StatusItem({
			slot: "usage",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 99,
			command: "litellm.openDashboard",
		});
		try {
			const view: StatusItemView = { text: "42%", tooltip: "tooltip", severity: "warning" };
			item.render(view);
			item.show();
			item.hide();
			// Double dispose is safe (the finally below runs it again).
			item.dispose();
		} finally {
			item.dispose();
		}
		assert.deepStrictEqual(liveStatusItemSlots(), []);
	});

	test("a slot self-heal tears down the superseded OWNER: onDidDispose fires and stale writes no-op", () => {
		// Disposing the stale ITEM is only half the fix: a superseded
		// UsageStatusBar also holds a store subscription and a stale-edge timer,
		// and without the hook it would keep rendering into a disposed item.
		const first = new StatusItem({
			slot: "usage",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 99,
			command: "litellm.openDashboard",
		});
		let ownerTeardowns = 0;
		first.onDidDispose(() => {
			ownerTeardowns += 1;
		});
		const second = new StatusItem({
			slot: "usage",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 99,
			command: "litellm.openDashboard",
		});
		try {
			assert.strictEqual(ownerTeardowns, 1);
			// The stale holder's surface writes are no-ops, never touches on a
			// disposed vscode item (which would throw).
			first.render({ text: "stale", tooltip: "stale", severity: "error" });
			first.show();
			first.hide();
			// The hook fires once; a late double dispose stays silent.
			first.dispose();
			assert.strictEqual(ownerTeardowns, 1);
			assert.deepStrictEqual(liveStatusItemSlots(), ["usage"]);
		} finally {
			second.dispose();
		}
		assert.deepStrictEqual(liveStatusItemSlots(), []);
	});

	test("UsageStatusBar unhooks its store subscription when the slot registry disposes its item", () => {
		const listeners: (() => void)[] = [];
		let subscriptionDisposes = 0;
		const store = {
			onDidChange: (listener: () => void) => {
				listeners.push(listener);
				return {
					dispose: () => {
						subscriptionDisposes += 1;
					},
				};
			},
			getStates: () => [],
		};
		const usageBar = new UsageStatusBar({
			store: store as unknown as UsageStatusBarOptions["store"],
			item: new StatusItem({
				slot: "usage",
				alignment: vscode.StatusBarAlignment.Right,
				priority: 99,
				command: "litellm.openDashboard",
			}),
			getMode: () => "alerts-only",
			getThresholds: () => [],
			getPollIntervalMs: () => 0,
			getPollingOffWindowMs: () => 600_000,
			getCurrencySymbol: () => "$",
		});
		// A second construction into the slot (the double-activation shape) must
		// tear the first owner down entirely.
		const replacement = new StatusItem({
			slot: "usage",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 99,
			command: "litellm.openDashboard",
		});
		try {
			assert.strictEqual(subscriptionDisposes, 1);
			// A late store event still finds the superseded bar inert.
			for (const listener of listeners) {
				listener();
			}
			usageBar.dispose();
			assert.strictEqual(subscriptionDisposes, 1, "the owner's dispose is idempotent after the self-heal");
		} finally {
			replacement.dispose();
		}
		assert.deepStrictEqual(liveStatusItemSlots(), []);
	});
});
