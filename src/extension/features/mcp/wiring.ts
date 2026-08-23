/**
 * MCP publisher wiring. The provider is registered unconditionally, because
 * the opt-in is not a setting to watch but a field on the entries: with none
 * opted in the eager pass publishes an empty list, which is the correct answer
 * rather than a special case.
 *
 * What the change event announces is derived, not classified: after any signal
 * that could matter, the pass recomputes the descriptor list and fires only
 * when it actually differs from the one last published. Since the rotation
 * counter rides each descriptor, a credential rotation moves the list too, so
 * one comparison covers both "the servers changed" and "their credentials
 * did" - there is no second change classifier to drift from the first.
 */

import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { MCP_PROVIDER_ID } from "../../../shared/config/commandIds";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";
import { serverSecretsKey } from "../../../shared/config/storageKeys";
import type { Logger } from "../../../shared/logger";
import { createMcpServerDefinitionProvider, currentMcpEntries, mcpDescriptors } from "./provider";
import { McpVersionCounters } from "./versions";

/**
 * How many entries opt into the publisher, for the diagnostics snapshot. The
 * feature's seam rather than its internals: everything outside
 * features/<feature>/ reaches a feature through its wiring module.
 */
export function mcpEnabledEntryCount(): number {
	return currentMcpEntries().length;
}

/** The setting the publisher reads, as a configuration-change target. */
const SERVERS_SETTING_ID = `${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`;

export function wireMcpServers(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: { readonly oneShot: OneShotClient }
): void {
	const versions = new McpVersionCounters(context.globalState);
	// Seeding, by construction: a first sighting is never a rotation, so this
	// call records today's credential material without announcing anything.
	versions.observeCredentials(currentMcpEntries());

	const providerDeps = {
		secrets: context.secrets,
		oneShot: deps.oneShot,
		versions,
		advisory: (message: string, data?: unknown): void => {
			logger.advisory(message, data);
		},
		logError: (message: string, error: unknown): void => {
			logger.error(message, error);
		},
	};

	const changed = new vscode.EventEmitter<void>();
	// The last list published, as its serialization: descriptors are small,
	// JSON-safe, and ordered by the setting, so their rendering IS their
	// identity - no field-by-field walk a new descriptor field could fall out
	// of. Seeded here so activation itself never counts as a change.
	let published = JSON.stringify(mcpDescriptors(providerDeps));

	const fireIfChanged = (): void => {
		const next = JSON.stringify(mcpDescriptors(providerDeps));
		if (next !== published) {
			published = next;
			changed.fire();
		}
	};

	/**
	 * Labels whose counter write failed. The digest path re-detects its own
	 * outstanding rotations, but the SecretStorage path reports a label once and
	 * has no digest to re-compare, so without this a failed write there would
	 * lose the rotation for good. Every later event retries them.
	 */
	const unwritten = new Set<string>();

	/**
	 * Persist the observed rotations, then publish. The listeners below are
	 * VS Code events, which do not await what a handler returns, so this owns
	 * the whole async tail: a failed counter write is logged and the comparison
	 * still runs, because a swallowed rejection would also swallow the change
	 * event and leave the editor holding a list it should have refreshed.
	 */
	const bumpThenFire = async (rotated: readonly string[]): Promise<void> => {
		// A label the setting no longer declares is forgotten here as the digests
		// forget it: retrying a rotation for a server nobody publishes would write
		// a counter forever for a label that is gone.
		const declared = new Set(currentMcpEntries().map((entry) => entry.label));
		for (const label of [...unwritten]) {
			if (!declared.has(label)) {
				unwritten.delete(label);
			}
		}
		// Deduplicated: the digest path re-reports an unconfirmed rotation that is
		// already in `unwritten`, and one rotation must bump the counter once.
		for (const label of new Set([...unwritten, ...rotated])) {
			// Per label, so one failed write cannot abandon the rest of the batch.
			try {
				await versions.bump(label);
				versions.confirmRotation(label);
				unwritten.delete(label);
			} catch (error) {
				unwritten.add(label);
				logger.error("Failed to record an MCP credential rotation", error);
			}
		}
		fireIfChanged();
	};

	context.subscriptions.push(
		vscode.lm.registerMcpServerDefinitionProvider(
			MCP_PROVIDER_ID,
			createMcpServerDefinitionProvider(providerDeps, changed.event)
		),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(SERVERS_SETTING_ID)) {
				return;
			}
			// A settings-side credential edit rotates what a session would send
			// while changing no published field, so the counters move before the
			// comparison reads them.
			void bumpThenFire(versions.observeCredentials(currentMcpEntries()));
		}),
		// Every secure-side write lands here, whoever made it and in whichever
		// window - the rotation signal no write site can forget to send.
		context.secrets.onDidChange((event) => {
			const rotated = currentMcpEntries()
				.filter((entry) => serverSecretsKey(entry.label) === event.key)
				.map((entry) => entry.label);
			void bumpThenFire(rotated);
		}),
		changed
	);
}
