/**
 * Moves OAuth client secret stamps from the token URL alone to secretDestination's current form
 * (shared/serverEntry.ts). The one place that knows the earlier form: the undo of a settings import restores recorded
 * stamps through upgradedStamp too, so a snapshot taken before this release restores a secret its entry can still use.
 *
 *   stamp equals the entry's token URL      -> re-stamped (a token URL never starts with "[", so this never re-fires)
 *   stamp names another token URL, or none  -> a mismatch or the unstamped state under both rules; untouched
 */

import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { Logger } from "../../shared/logger";
import type { SecretDestinationEntry, SecretFieldId } from "../../shared/serverEntry";
import { errorLabel } from "../../shared/util/errorLabel";
import type { SecretStore } from "../servers/serverSync/secrets";
import { readServerSecretsRecord, restampServerSecretOwner, secretDestination } from "../servers/serverSync/secrets";
import { parseServersSetting } from "../servers/serverSync/setting";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

export function upgradedStamp(entry: SecretDestinationEntry, field: SecretFieldId, owner: string): string {
	return field === "oauthClientSecret" && owner === entry.oauthTokenUrl ? secretDestination(entry, field) : owner;
}

export async function stampOauthClientIdsFor(
	readServersSetting: () => unknown,
	secrets: SecretStore,
	logger: Logger
): Promise<MigrationOutcome> {
	const { entries } = parseServersSetting(readServersSetting());
	let restamped = 0;
	let failures = 0;
	for (const entry of entries) {
		let record: Awaited<ReturnType<typeof readServerSecretsRecord>>;
		try {
			record = await readServerSecretsRecord(secrets, entry.label);
		} catch (error) {
			failures += 1;
			logger.log("Reading a blob to re-stamp an OAuth client secret failed; retrying on next activation", {
				error: errorLabel(error),
			});
			continue;
		}
		const owner = record.owners.oauthClientSecret;
		if (owner === undefined) {
			continue;
		}
		const upgraded = upgradedStamp(entry, "oauthClientSecret", owner);
		if (upgraded === owner) {
			continue;
		}
		try {
			await restampServerSecretOwner(secrets, entry.label, "oauthClientSecret", owner, upgraded);
			restamped += 1;
		} catch (error) {
			failures += 1;
			logger.log("Re-stamping an OAuth client secret's ownership failed; retrying on next activation", {
				error: errorLabel(error),
			});
		}
	}
	if (failures > 0) {
		return "in-progress";
	}
	return restamped > 0 ? "migrated" : "nothing-to-do";
}

/** Migrates away from: OAuth client secret stamps of v0.6.7 and earlier, which named the token URL alone. */
export const oauthStampClientIdMigration: ExtensionMigration<"token-url-only-oauth-stamps"> = {
	state: "token-url-only-oauth-stamps",
	description: "Re-stamped stored OAuth client secrets with the client id beside the token URL",
	sourceRelease: "0.6.7",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return stampOauthClientIdsFor(
			() => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
			ctx.secrets,
			ctx.logger
		);
	},
};
