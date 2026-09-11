/**
 * This suite pins the wire rule as a superset of the CHAT path's narrowing.
 * entryUsesSecretField (shared/serverEntry.ts) is the ONE wire rule for which fields a shape sends.
 * Its arms must cover every field parseGroupConfiguration lets into a composed GroupServer.
 * The arms derive from the parser's narrowOAuth and narrowVirtualKey in groupModels.ts.
 * On this chain resolveOwnedSecrets drops a stamp-mismatched stored value before it can ride.
 * So a shape sent but denied means the refusal never fires.
 * The sync engine then upserts a CREDENTIAL-LESS group at the new host, unflagged.
 * That group is permanent because the host is add-only.
 * The rule is one function, so a stale arm also fails the raw-blob composer MCP refuses through.
 * There the wrong-host ride is real.
 * parseGroupConfiguration receives host-stored configurations, not entries.
 * So composeGroupServer below runs the REAL chain: resolveOwnedSecrets, buildGroupArgs, the parser.
 * The probe writes every stamp with secretDestination, so every planted value resolves.
 * That is the maximal reachable send side, since the ownership check only ever drops values.
 * Production puts the host's configuration store between the last two steps.
 * That round trip can only drop or reshape what buildGroupArgs wrote.
 * parseAttachedServer's re-parse can likewise only drop further.
 * This suite claims nothing for credentials that ride in the HOST-held configuration itself.
 * Those are externally managed groups and pre-label groups an older version pushed.
 * No refusal gate stands there, even when an entry mirrors the server or adoption copied them.
 * util/wireRuleProbe.ts shares the probe space and record shape with spendClient.wireRule.test.ts.
 * narrowVirtualKey's header-legality checks only NARROW the send side.
 * The probe plants header-legal values, so presence probing over-approximates what can ride.
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
		// This case covers the only arm outside the probe space.
		// The two sides refuse by DIFFERENT judgments that coincide here.
		// The rule normalizes the raw base URL; the parser trims first and then normalizes.
		// So every URL the rule refuses the parser refuses too, and its refusal set is strictly wider.
		// The parser refusing means the chat path composes no server, so no field can ride a request.
		// It is NOT a claim that no resolved value leaves the process.
		// The settings parser accepts a "/" base URL, so the sync engine still calls add-group.
		// That resolution has already dropped a stamp-mismatched value; matching or inline ones stay.
		// The value then sits in the host store, refused by this parser on every call.
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
