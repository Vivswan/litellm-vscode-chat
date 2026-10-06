/**
 * The declared servers as every surface resolves them: the sync engine's views once a pass has run, the servers
 * setting's own reading before. One resolution, so the status bar, the notifier, the dashboard, and the issue report
 * judge the same declared set.
 */

import { pickEntryViewFields, pickNonSecretOptionalFields } from "../../shared/serverEntry";
import type { DeclaredServerView } from "../servers/serverSync";
import { buildGroupArgs, declaredCredentials, parseServersSetting, secretLocations } from "../servers/serverSync";

/**
 * The sync engine reads the secret blobs; the pre-first-pass settings fallback cannot check SecretStorage
 * synchronously, so a field it reports "none" may really be "secure". The tag is producer-owned -
 * declaredViewsFromSetting returns its views already marked "settings-fallback" - and proof is still judged per view
 * (state.ts secretsView): an engine view whose own blob read failed is as blind as the fallback.
 */
export type DeclaredServersInput =
	| { readonly source: "engine"; readonly views: readonly DeclaredServerView[] }
	| { readonly source: "settings-fallback"; readonly views: readonly DeclaredServerView[] };

/**
 * Checking a secure blob is async and state pushes carry locations, never values, so the shared rule is fed an
 * empty blob. The "settings-fallback" tag tells state.ts to read the resulting "none" as unproven, not fact.
 */
export function declaredViewsFromSetting(raw: unknown): DeclaredServersInput {
	const views = parseServersSetting(raw).entries.map((entry) => {
		const secrets = secretLocations(entry, {});
		return {
			label: entry.label,
			baseUrl: entry.baseUrl,
			// The same two registry picks the engine's views ride, so an entry field cannot exist that the fallback
			// window silently drops (a dropped field would prefill the edit form empty and a save would then DELETE it
			// from the setting; mcp was lost exactly this way).
			...pickNonSecretOptionalFields(entry),
			...pickEntryViewFields(entry),
			secrets,
			// The owner's reading over the inline fields alone (no blob here): a "present" is fact, an "absent" is
			// what secretsView calls unproven.
			credentials: declaredCredentials(buildGroupArgs(entry, {})),
		};
	});
	return { source: "settings-fallback", views };
}

/**
 * The engine's declared views are authoritative once a pass has run; right after activation they are still empty, so
 * the setting fills in, already tagged "settings-fallback" by its producer.
 */
export function resolveDeclaredServers(
	engineViews: readonly DeclaredServerView[],
	rawSetting: unknown
): DeclaredServersInput {
	if (engineViews.length > 0) {
		return { source: "engine", views: engineViews };
	}
	return declaredViewsFromSetting(rawSetting);
}
