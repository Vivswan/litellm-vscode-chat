/**
 * Budget alert toasts (docs/usage.md#alerts): one warning per server entry
 * and newly crossed threshold set, evaluated on every fetch - background
 * polls and manual refreshes alike. The store's newlyCrossedThresholds IS the
 * dedup (budget.ts re-arms a threshold when spend drops back below it), so
 * this module keeps no state of its own; when one poll jumps several
 * thresholds at once only the highest fires, and every budget notification
 * uses the one warning severity - the escalating color story lives in the
 * status bar item.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { INTERNAL_CMD } from "../../shared/config/commandIds";
import type { UsageStore } from "../servers/usage/store";
import type { MessageAction } from "./notifier";
import { dismissAction, showActionableMessage } from "./notifier";

/** The toast's deep link to the dashboard's Servers page, where spend lives. */
function openUsageAction(): MessageAction {
	return {
		label: l10n.t("Open Usage"),
		run: () => void vscode.commands.executeCommand(INTERNAL_CMD.openUsage),
	};
}

export class UsageAlerts implements vscode.Disposable {
	private readonly subscription: { dispose(): void };

	constructor(
		store: UsageStore,
		private readonly show: typeof showActionableMessage = showActionableMessage
	) {
		this.subscription = store.onDidChange((event) => {
			if (event.kind !== "updated" || event.newlyCrossedThresholds.length === 0) {
				return;
			}
			const highest = Math.max(...event.newlyCrossedThresholds);
			const spentPercent = Math.round((event.state.budget.spentFraction ?? highest) * 100);
			void this.show(
				"warning",
				l10n.t(
					'LiteLLM: "{0}" has used {1}% of its budget (alert at {2}%)',
					event.label,
					spentPercent,
					Math.round(highest * 100)
				),
				[openUsageAction(), dismissAction()]
			);
		});
	}

	dispose(): void {
		this.subscription.dispose();
	}
}
