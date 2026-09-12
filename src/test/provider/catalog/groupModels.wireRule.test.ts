/**
 * The arms of entryUsesSecretField (shared/serverEntry.ts, the ONE wire rule deciding which credential fields an
 * entry's shape would send) are documented as derived from parseGroupConfiguration's narrowOAuth/narrowVirtualKey
 * and must cover every field the parser lets into a composed GroupServer. narrowVirtualKey's header-legality
 * checks only NARROW the send side and the probe plants header-legal values, so presence probing over-approximates
 * what can ride, the safe direction.
 *
 * What a shape the chat path sends but the rule denies would do, the rule being ONE function:
 *   this chain    -> resolveOwnedSecrets drops the stamp-mismatched value first, so the refusal never fires and the
 *                    sync engine upserts a CREDENTIAL-LESS group at the new host, permanent under the add-only host
 *   raw-blob path -> the MCP publisher refuses through the same arms, and there the wrong-host ride is real
 *
 * What the claim covers, the parser receiving host-stored configurations rather than entries:
 *   the REAL sync chain (composeGroupServer)   -> claimed; the maximal reachable send side, since the ownership
 *                                                 check only ever drops values
 *   the host's configuration-store round trip  -> no claim needed; it can only drop or reshape what buildGroupArgs wrote
 *   parseAttachedServer's re-parse             -> no claim needed; it reuses the narrowing helpers and can only drop further
 *   credentials in the HOST-held configuration -> not claimed; external and pre-label groups bypass the chain, so no
 *                                                 refusal gate stands before the parser even when an entry mirrors
 *                                                 the server or an adoption copied them
 */

import * as assert from "node:assert";
import type { DeclaredServer } from "../../../extension/servers/serverSync";
import { buildGroupArgs } from "../../../extension/servers/serverSync";
import type { StoredSecretsRecord } from "../../../extension/servers/serverSync/secrets";
import { resolveOwnedSecrets } from "../../../extension/servers/serverSync/secrets";
import { parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import type { SecretFieldId } from "../../../shared/serverEntry";
import { entryUsesSecretField, SECRET_FIELD_IDS, secretDestination } from "../../../shared/serverEntry";
import type { ShapeFieldValues } from "../../util/wireRuleProbe";
import { allSecretSentinels, memoizedWireRuleWalk } from "../../util/wireRuleProbe";

/**
 * One usable probe value per shape field. Total over the id union on purpose:
 * adding a field to OPTIONAL_ENTRY_FIELDS or the entry-view registry breaks
 * this table's typecheck, forcing the new field into the probed shape space.
 * The values are parser-legal (a header name the narrowing would accept, a
 * real token URL) so the probed shapes are the reachable ones.
 */
const SHAPE_FIELD_VALUES: ShapeFieldValues = {
	oauthTokenUrl: "http://idp.test/oauth2/token",
	oauthClientId: "client-1",
	oauthScopes: "chat.send",
	virtualKeyHeader: "x-litellm-key",
	apiVersion: "v2",
	headers: { "x-probe-header": "probe" },
	modelParameters: {},
	modelCapabilities: {},
	expectedFailures: ["modelListing"],
	declaredModels: ["model-a"],
	budget: 5,
	mcp: true,
};

/**
 * Compose one probe through the real chain and return what the chat path
 * would carry: the entry's blob resolves under matching stamps (the
 * deliberate-pairing path, so nothing drops), buildGroupArgs flattens entry and
 * resolution into the host configuration, and parseGroupConfiguration narrows
 * that into the GroupServer the request path sends from.
 */
function composeGroupServer(entry: DeclaredServer, stored: { readonly [K in SecretFieldId]?: string }): unknown {
	const owners: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		if (stored[field] !== undefined) {
			owners[field] = secretDestination(entry, field);
		}
	}
	const record: StoredSecretsRecord = { values: stored, owners };
	const resolution = resolveOwnedSecrets(entry, record);
	return parseGroupConfiguration(buildGroupArgs(entry, resolution.values));
}

/**
 * The shared exhaustive walk (util/wireRuleProbe.ts) over this pin's
 * composition: the sync-to-chat chain above, so its `sends` is exactly what a
 * parsed GroupServer carries onto the chat request path. The parser refusing
 * a configuration composes no server, which is a legitimate no-ride here, so
 * this serialization normalizes a refusal to "null" instead of crashing.
 */
const probeRecords = memoizedWireRuleWalk(SHAPE_FIELD_VALUES, (entry, stored) =>
	JSON.stringify(composeGroupServer(entry, stored) ?? null)
);

suite("provider/catalog groupModels wire-rule superset", () => {
	test("per field, the chat path sends only what the wire rule attributes somewhere", () => {
		// The field-set comparison the pointwise walk summarizes to: both sets
		// derived by probing the real implementations, compared per field.
		const records = probeRecords();
		for (const field of SECRET_FIELD_IDS) {
			const sent = records.some((record) => record.field === field && record.sends);
			const used = records.some((record) => record.field === field && record.uses);
			assert.ok(
				!sent || used,
				`parseGroupConfiguration lets "${field}" ride on some entry shape but entryUsesSecretField attributes it ` +
					"on none - the wire rule's arms no longer cover the chat path's narrowing"
			);
		}
	});

	test("on every reachable entry shape, a value the chat path sends is a value the wire rule owns", () => {
		// The pointwise superset: sends implies uses on each shape, so the
		// refusal gates reading entryUsesSecretField cover every pairing the
		// chat path would actually put on the wire.
		for (const record of probeRecords()) {
			assert.ok(
				!record.sends || record.uses,
				`entryUsesSecretField denies "${record.field}" on shape [${record.shapeName}] yet the sync-to-chat chain ` +
					`sends it planted as [${record.plantingName}] - the refusal gates never cover this send, so a stale ` +
					`"${record.field}" stamp would sync a credential-less group with no secretsMismatched flag`
			);
		}
	});

	test("positive control: every secret field's sentinel is observed riding at least once", () => {
		// A probe that never fires proves nothing: if detection broke (the
		// chain or GroupServer shape changed under it), the superset tests
		// above would pass vacuously. Each field must be seen riding on some
		// shape, or the pin's probe needs revisiting alongside the change.
		const records = probeRecords();
		for (const field of SECRET_FIELD_IDS) {
			assert.ok(
				records.some((record) => record.field === field && record.sends),
				`the probe never observed "${field}" riding a parsed group server - the chain stopped carrying it or ` +
					"the detection broke; revisit this pin with the change"
			);
		}
	});

	test("the wire rule's no-server arm and the parser's refusal coincide: no server forms, no field is used", () => {
		// Two DIFFERENT judgments coincide here, since the rule normalizes the raw base URL and the parser trims
		// first, so every URL the rule refuses the parser refuses too (its set is
		// strictly wider) and the chat path composes no server. It is NOT a claim that no resolved value leaves the
		// process:
		//
		//   settings parser accepts "/" -> sync engine hands buildGroupArgs' resolution (stamp-mismatched value dropped,
		//   matching or inline kept) to the host's add-group command -> sits in the host store, refused here on every call
		const entry: DeclaredServer = { label: "probe", baseUrl: "/", ...SHAPE_FIELD_VALUES };
		for (const field of SECRET_FIELD_IDS) {
			assert.strictEqual(entryUsesSecretField(entry, field), false, `the no-server arm must deny "${field}"`);
		}
		const stored = allSecretSentinels();
		assert.strictEqual(
			composeGroupServer(entry, stored),
			undefined,
			"a normalized-to-empty base URL must refuse the whole group configuration"
		);
	});
});
