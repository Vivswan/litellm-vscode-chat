/**
 * Moves the stamp 0.6.7 and earlier wrote on an OAuth client secret (the token URL as a string) to secretDestination's
 * object (shared/serverEntry.ts), under the rule of serverSync/secrets.ts upgradedStamp, which every ownership check
 * already judges by; a blob with no string stamp on that field is a no-op.
 */

import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { Logger } from "../../shared/logger";
import { errorLabel } from "../../shared/util/errorLabel";
import type { SecretStore } from "../servers/serverSync/secrets";
import { readServerSecretsRecord, restampServerSecretOwner, upgradedStamp } from "../servers/serverSync/secrets";
import { parseServersSetting } from "../servers/serverSync/setting";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

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
		if (typeof owner !== "string") {
			continue;
		}
		try {
			await restampServerSecretOwner(
				secrets,
				entry.label,
				"oauthClientSecret",
				owner,
				upgradedStamp(entry, "oauthClientSecret", owner)
			);
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
