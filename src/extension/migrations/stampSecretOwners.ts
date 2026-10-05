/**
 * Back-fills ownership stamps onto SecretStorage blobs written before stamps existed: a declared entry's unstamped
 * value is stamped with the entry's CURRENT destination, the pairing every earlier version trusted unconditionally,
 * so the rerun is a no-op. stampServerSecretOwner never overwrites an existing stamp, so racing a deliberate pairing
 * action is harmless.
 *
 *   blob whose label no entry declares          -> stays unstamped; SecretStorage cannot enumerate keys, and a future
 *                                                  re-add resolves it exactly as before
 *   OAuth client secret on an entry, no token URL -> waits for an activation where the entry declares one; an empty
 *                                                  destination now would refuse the pairing the user is completing
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
			// Classification only: a SecretStorage error could echo what it was handed, and log lines feed the public
			// issue-report buffer.
			logger.log("Reading a blob to stamp secret ownership failed; retrying on next activation", {
				error: errorLabel(error),
			});
			continue;
		}
		for (const field of SECRET_FIELD_IDS) {
			if (record.values[field] === undefined || record.owners[field] !== undefined) {
				continue;
			}
			if (field === "oauthClientSecret" && entry.oauthTokenUrl === undefined) {
				continue;
			}
			try {
				await stampServerSecretOwner(secrets, entry.label, field, secretDestination(entry, field));
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
 * Migrates away from: the unstamped SecretStorage blobs of v0.4.7 and earlier. Deletable once installs with
 * pre-stamping blobs are judged extinct - though as long as it lives, a rerun also re-stamps blobs an interim DOWNGRADE
 * rewrote (an old version's read-modify-write drops the whole `_owner` map), so ownership protection converges again on
 * the next activation rather than staying erased.
 */
export const stampSecretOwnersMigration: ExtensionMigration<"unstamped-server-secrets"> = {
	state: "unstamped-server-secrets",
	description: "Stamped stored server secrets with the destinations their entries pair them with",
	sourceRelease: "0.4.7",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return stampSecretOwnersFor(
			() => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
			ctx.secrets,
			ctx.logger
		);
	},
};
