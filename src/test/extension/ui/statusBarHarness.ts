/**
 * The shared status-bar test harness: a recording render surface and a StatusBarManager factory over an in-memory
 * context, so every suite that drives the status bar injects a fake instead of re-implementing one (and can never
 * create a real, visible item in the shared test host).
 */

import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { StatusItemLike, StatusItemView } from "../../../extension/ui/status";
import { StatusBarManager } from "../../../extension/ui/status";
import { LAST_CONNECTION_STATUS_KEY } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import type { VerdictSourceOptions } from "./verdictHarness";
import { fedByWindow, windowVerdict } from "./verdictHarness";

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

/** The context is returned so the caller owns disposing its subscriptions. */
export function createStatusBarManager(
	options: VerdictSourceOptions & {
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
	// The bar's verdict owner reads the window the test hands the bar (fedByWindow), as the provider's window backs
	// both in production.
	const window = windowVerdict(options);
	const manager = fedByWindow(
		new StatusBarManager(
			context,
			new Logger({ info() {}, error() {} }, options.recorder),
			options.hasConfiguredServers ?? (() => false),
			window.verdict,
			options.item ?? new RecordingItem()
		),
		window
	);
	return { manager, context };
}
