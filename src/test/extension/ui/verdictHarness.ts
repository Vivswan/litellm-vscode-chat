/**
 * The verdict owner over a test's own status window: production binds ServerVerdict to the provider's window, the
 * engine's views, and the servers setting; a suite binds it to the window it hands the bar or the notifier, so the
 * owner and the consumer read one window the way they do in production.
 */

import type { DeclaredServerView, ServerEntryReport } from "../../../extension/servers/serverSync";
import { ServerVerdict } from "../../../extension/servers/syncFailureOverlay";
import { Notifier } from "../../../extension/ui/notifier";
import type { AggregatedStatus, ServerStatus } from "../../../shared/servers";
import type { Timer } from "../../../shared/util/timer";

export interface VerdictSourceOptions {
	/** The declared views (engine-tagged); none by default. */
	readonly getDeclared?: (() => readonly DeclaredServerView[]) | undefined;
	/** The servers setting's entry reports; none by default. */
	readonly entryReports?: (() => readonly ServerEntryReport[]) | undefined;
}

export interface WindowVerdict {
	readonly verdict: ServerVerdict;
	/** Publishes a window: what the owner's statuses() answers from now on. */
	publish(statuses: readonly ServerStatus[]): void;
}

export function windowVerdict(options: VerdictSourceOptions = {}): WindowVerdict {
	let window: readonly ServerStatus[] = [];
	return {
		verdict: new ServerVerdict({
			statuses: () => window,
			declared: () => ({ source: "engine", views: options.getDeclared?.() ?? [] }),
			entryReports: () => options.entryReports?.() ?? [],
		}),
		publish: (statuses) => {
			window = statuses;
		},
	};
}

/**
 * Binds a consumer to its window owner: every aggregated status the test hands the consumer is published to the owner
 * first, as the provider's window backs both in production.
 */
export function fedByWindow<T extends { handleAggregatedStatus(status: AggregatedStatus): void }>(
	consumer: T,
	window: WindowVerdict
): T {
	const handle = consumer.handleAggregatedStatus.bind(consumer);
	consumer.handleAggregatedStatus = (status) => {
		window.publish(status.serverStatuses);
		handle(status);
	};
	return consumer;
}

/** A notifier over its own window owner; `graceMs` and `timer` default like the constructor's. */
export function windowNotifier(
	hasConfiguredServers: () => boolean,
	options: VerdictSourceOptions & { readonly graceMs?: number | undefined; readonly timer?: Timer | undefined } = {}
): Notifier {
	const window = windowVerdict(options);
	return fedByWindow(new Notifier(hasConfiguredServers, window.verdict, options.graceMs, options.timer), window);
}
