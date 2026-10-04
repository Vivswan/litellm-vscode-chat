import * as vscode from "vscode";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../../shared/config/settings";
import { isServerSecretsKey } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import { type CollectableEntry, collectKnownSecretValues } from "../../shared/util/knownSecrets";
import { onServerSecretWritten, readDeclaredSecretValues } from "../servers/serverSync/secrets";
import { collectableEntries, rawDeclaredLabels } from "../servers/serverSync/setting";

/**
 * Keep the Logger's known-secret list current from every raw record read by the parser's own readers (accepted or
 * not, so a rejected entry's credentials count) plus each declared label's SecretStorage blob, so a key just typed
 * into the setting ("new-key-Q7") is known to the first line that quotes it.
 *   activation                                 -> awaited until the latest refresh has published
 *   a servers-setting edit                     -> the setting's values publish before the listener returns, with
 *                                                 the last blob read's values still in force; the fresh blobs follow
 *   a server-secret change                     -> the same two publishes
 *   a value this window writes into a blob     -> known at once; retired only by a refresh begun after it landed
 *   an older read resolving after a newer one  -> only the latest refresh publishes the blob values (the ordinal)
 *   one blob read failing                      -> a logged error; the set never shrinks: the previous blob values
 *                                                 stay in force until a read of every label lands
 */
export async function wireKnownSecrets(
	context: vscode.ExtensionContext,
	logger: Logger,
	publish: (values: readonly string[]) => void
): Promise<void> {
	let latest = 0;
	let pending: Promise<void> = Promise.resolve();
	let stored: readonly (string | undefined)[] = [];
	let written: readonly { readonly value: string; landedUnder: number | undefined }[] = [];
	let entries: readonly CollectableEntry[] = [];
	const knownNow = (): readonly string[] =>
		collectKnownSecretValues(entries, [...stored, ...written.map((w) => w.value)]);
	const refresh = async (): Promise<void> => {
		const ordinal = ++latest;
		const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY);
		entries = collectableEntries(raw);
		publish(knownNow());
		let failed = false;
		const read = await readDeclaredSecretValues(context.secrets, [...rawDeclaredLabels(raw)], (_label, error) => {
			failed = true;
			logger.error("Known-secret blob read failed", error);
		});
		if (ordinal === latest) {
			if (failed) {
				stored = [...new Set([...stored, ...read])];
			} else {
				stored = read;
				// A write that landed before this refresh began is in these blobs; a pending one, or one that landed under
				// this refresh, may have missed the read.
				written = written.filter((entry) => entry.landedUnder === undefined || entry.landedUnder >= ordinal);
			}
			publish(knownNow());
		}
	};
	const schedule = (): void => {
		pending = refresh();
	};
	context.subscriptions.push(
		onServerSecretWritten((values, landed) => {
			const entries = values.map((value) => ({ value, landedUnder: undefined as number | undefined }));
			// The entries are mutated when the write lands; the list itself is replaced, never mutated.
			written = [...written, ...entries];
			publish(knownNow());
			void landed.then(() => {
				for (const entry of entries) {
					entry.landedUnder = latest;
				}
			});
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`)) {
				schedule();
			}
		}),
		context.secrets.onDidChange((event) => {
			if (isServerSecretsKey(event.key)) {
				schedule();
			}
		})
	);
	schedule();
	// A refresh superseded while awaited publishes no blob values, so wait until the newest one has run.
	let awaited: Promise<void>;
	do {
		awaited = pending;
		await awaited;
	} while (awaited !== pending);
}
