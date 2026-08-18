/**
 * The shared status-bar test harness: a recording render surface and a
 * StatusBarManager factory over an in-memory context, so every suite that
 * drives the status bar injects a fake instead of re-implementing one (and
 * can never create a real, visible item in the shared test host).
 */

import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { StatusItemLike, StatusItemView } from "../../../extension/ui/status";
import { StatusBarManager } from "../../../extension/ui/status";
import { LAST_CONNECTION_STATUS_KEY } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";

/** A recording status-bar surface, so suites can pin rendered text and severity. */
export class RecordingItem implements StatusItemLike {
	command: string | vscode.Command | undefined = undefined;
	views: StatusItemView[] = [];
	dispose(): void {}
	render(view: StatusItemView): void {
		this.views.push(view);
	}
	show(): void {}
	hide(): void {}

	get last(): StatusItemView {
		const view = this.views.at(-1);
		if (view === undefined) {
			throw new assert.AssertionError({ message: "nothing was rendered" });
		}
		return view;
	}
}

/**
 * A StatusBarManager over a fresh in-memory Memento, ALWAYS on a recording
 * surface unless the caller injects its own StatusItemLike. The context is
 * returned so the caller owns disposing its subscriptions.
 */
export function createStatusBarManager(
	options: {
		persistedStatus?: unknown;
		hasConfiguredServers?: (() => boolean) | undefined;
		recorder?: { appendLog(line: string): void; recordError(source: string, error: unknown): void } | undefined;
		item?: StatusItemLike | undefined;
	} = {}
): { manager: StatusBarManager; context: vscode.ExtensionContext } {
	const store = new Map<string, unknown>();
	if (options.persistedStatus !== undefined) {
		store.set(LAST_CONNECTION_STATUS_KEY, options.persistedStatus);
	}
	const context = {
		subscriptions: [],
		globalState: {
			get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
			update: async (key: string, value: unknown) => {
				store.set(key, value);
			},
		},
	} as unknown as vscode.ExtensionContext;
	const manager = new StatusBarManager(
		context,
		new Logger({ info() {}, error() {} }, options.recorder),
		options.hasConfiguredServers ?? (() => false),
		options.item ?? new RecordingItem()
	);
	return { manager, context };
}
