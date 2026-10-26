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
 *
 * Deletable once installs with pre-stamping blobs are judged extinct. As long as it lives, a rerun also re-stamps
 * blobs an interim DOWNGRADE rewrote (an old version's read-modify-write drops the whole `_owner` map), so ownership
 * protection converges again on the next activation rather than staying erased.
 */

import type { Logger } from "../../shared/logger";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { errorLabel } from "../../shared/util/errorLabel";
import type { SecretStore } from "../servers/serverSync/secrets";
import { readServerSecretsRecord, secretDestination, stampServerSecretOwner } from "../servers/serverSync/secrets";
import type { DeclaredServer } from "../servers/serverSync/setting";
import { parseServersSetting } from "../servers/serverSync/setting";
import { readRawServersSetting } from "../servers/serverSync/vscodeEnv";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

/**
 * Stamps one entry's unstamped stored fields with the entry's current destination; an OAuth client secret waits for
 * an activation where the entry declares a token URL. Returns the stamps written and the reads or writes that failed,
 * each logged by classification only: a SecretStorage error could echo what it was handed, and log lines feed the
 * public issue-report buffer.
 */
async function stampEntry(
	entry: DeclaredServer,
	secrets: SecretStore,
	logger: Logger
): Promise<{ stamped: number; failures: number }> {
	let record: Awaited<ReturnType<typeof readServerSecretsRecord>>;
	try {
		record = await readServerSecretsRecord(secrets, entry.label);
	} catch (error) {
		logger.log("Reading a blob to stamp secret ownership failed; retrying on next activation", {
			error: errorLabel(error),
		});
		return { stamped: 0, failures: 1 };
	}
	let stamped = 0;
	let failures = 0;
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
	return { stamped, failures };
}

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
		const outcome = await stampEntry(entry, secrets, logger);
		stamped += outcome.stamped;
		failures += outcome.failures;
	}
	if (failures > 0) {
		return "in-progress";
	}
	return stamped > 0 ? "migrated" : "nothing-to-do";
}

/** Migrates away from the unstamped blobs of v0.4.7 and earlier; a rerun also heals an interim downgrade's erasure. */
export const stampSecretOwnersMigration: ExtensionMigration<"unstamped-server-secrets"> = {
	state: "unstamped-server-secrets",
	description: "Stamped stored server secrets with the destinations their entries pair them with",
	sourceRelease: "0.4.7",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return stampSecretOwnersFor(readRawServersSetting, ctx.secrets, ctx.logger);
	},
};
