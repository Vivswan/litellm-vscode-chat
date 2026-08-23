/**
 * Back-fills ownership stamps onto SecretStorage blobs written before stamps
 * existed. State-detecting and idempotent: a declared entry whose blob holds
 * an unstamped value is the legacy state, and stamping it with the entry's
 * CURRENT destination (exactly the pairing every earlier version trusted
 * unconditionally) makes the rerun a no-op while putting the blob under the
 * ownership check from now on. stampServerSecretOwner never overwrites an
 * existing stamp, so racing a deliberate pairing action is harmless.
 *
 * Two states stay untouched on purpose. A leftover blob whose label no entry
 * declares has no derivable destination, so it stays unstamped (it resolves
 * for a future re-add exactly as before; only post-stamping writes are
 * protected against the re-add-at-another-host hazard). SecretStorage cannot
 * enumerate keys, so no migration can even find such a blob; refusing every
 * unstamped value instead would turn a failed stamping pass into a
 * whole-session credential outage while still trusting whatever pairing
 * stands when stamping eventually succeeds. The residual is narrow: the
 * dashboard's create and upsert paths wipe a label's leftover blob outright,
 * so only a hand-written settings.json re-declaration can pair a
 * pre-stamping leftover with a new host, once, until the blob is touched.
 * And a field whose destination is unknowable on this entry (an OAuth client
 * secret on an entry with no token URL) waits for an activation where the
 * entry declares one - stamping "" now would refuse the pairing the user is
 * about to complete.
 */

import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { Logger } from "../../shared/logger";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { errorLabel } from "../../shared/util/errorLabel";
import type { SecretStore } from "../servers/serverSync/secrets";
import { readServerSecretsRecord, secretDestination, stampServerSecretOwner } from "../servers/serverSync/secrets";
import { parseServersSetting } from "../servers/serverSync/setting";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

/** The migration body over injectable reads; the wrapper below supplies the real ones. */
export async function stampSecretOwnersFor(
	readServersSetting: () => unknown,
	secrets: SecretStore,
	logger: Logger
): Promise<MigrationOutcome> {
	const { entries } = parseServersSetting(readServersSetting());
	let stamped = 0;
	let failures = 0;
	for (const entry of entries) {
		let record: Awaited<ReturnType<typeof readServerSecretsRecord>>;
		try {
			record = await readServerSecretsRecord(secrets, entry.label);
		} catch (error) {
			failures += 1;
			// Classification only: a SecretStorage error could echo what it was
			// handed, and log lines feed the public issue-report buffer.
			logger.log("Reading a blob to stamp secret ownership failed; retrying on next activation", {
				error: errorLabel(error),
			});
			continue;
		}
		for (const field of SECRET_FIELD_IDS) {
			if (record.values[field] === undefined || record.owners[field] !== undefined) {
				continue;
			}
			const destination = secretDestination(entry, field);
			if (destination === "") {
				continue;
			}
			try {
				await stampServerSecretOwner(secrets, entry.label, field, destination);
				stamped += 1;
			} catch (error) {
				failures += 1;
				logger.log("Stamping a stored secret's ownership failed; retrying on next activation", {
					error: errorLabel(error),
				});
			}
		}
	}
	if (failures > 0) {
		return "in-progress";
	}
	return stamped > 0 ? "migrated" : "nothing-to-do";
}

/**
 * Migrates away from: the unstamped SecretStorage blobs of v0.4.7 and earlier.
 * Deletable once installs with pre-stamping blobs are judged extinct - though
 * as long as it lives, a rerun also re-stamps blobs an interim DOWNGRADE
 * rewrote (an old version's read-modify-write drops the whole `_owner` map),
 * so ownership protection converges again on the next activation rather than
 * staying erased. Runs pre-registration, after the settings redesign in the
 * same phase, so the entries it derives destinations from are already in the
 * redesigned shape.
 */
export const stampSecretOwnersMigration: ExtensionMigration = {
	state: "unstamped-server-secrets",
	description: "Stamped stored server secrets with the destinations their entries pair them with",
	sourceRelease: "0.4.7",
	phase: "pre-registration",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return stampSecretOwnersFor(
			() => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
			ctx.secrets,
			ctx.logger
		);
	},
};
