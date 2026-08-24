/**
 * Pins the wire rule as a superset of the CHAT path's narrowing - the sibling
 * of the usage-composer pin (extension/servers/usage
 * spendClient.wireRule.test.ts): the arms of entryUsesSecretField
 * (shared/serverEntry.ts, the ONE wire rule deciding which credential fields
 * an entry's shape would send) must cover every field parseGroupConfiguration
 * (provider/catalog/groupModels.ts, whose narrowOAuth/narrowVirtualKey those
 * arms are documented as derived from) lets into a composed GroupServer - the
 * connection the chat request path carries onto the wire. The pairing gates
 * (resolveOwnedSecrets' refusals, read by the sync engine, the usage poller,
 * and the MCP publisher's resolve boundary) refuse a pairing only when the
 * wire rule says the entry's shape uses the mismatched field. On THIS chain a
 * stamp-mismatched stored value is dropped from the resolution before it can
 * ride, so the harm of a shape the chat path sends but the rule denies is not
 * a wrong-host send but the refusal never firing: the sync engine would
 * proceed without the credential and upsert a CREDENTIAL-LESS group at the
 * new host - permanent, because the host is add-only - with nothing on the
 * sync path flagging the mismatch. And the wire rule is ONE function: an arm
 * the chat path's narrowing outgrows is equally stale for the raw-blob
 * composer the MCP publisher refuses through (the sibling pin's territory),
 * where the wrong-host ride is real.
 *
 * The honest boundary, and the delta from the ideal superset:
 * parseGroupConfiguration receives host-stored group configurations, not
 * entries, and a declared entry's stored values reach it only through the sync
 * engine's composition. This suite therefore composes that REAL chain - entry
 * plus SecretStorage blob through resolveOwnedSecrets (every stamp written
 * with secretDestination, so every planted value resolves: the maximal
 * reachable send side, since the ownership check only ever drops values), then
 * buildGroupArgs, then parseGroupConfiguration (production interposes the
 * host's configuration store between those two - a round trip that can only
 * drop or reshape what buildGroupArgs wrote, narrowing further) - and claims
 * sends-implies-uses over every configuration that chain can hand the parser.
 * Configurations from anywhere else (an externally managed group typed in the
 * native models file, a pre-label group an older version pushed) reach the
 * parser too, but
 * their credentials ride in the HOST-held configuration itself and bypass this
 * chain: no resolveOwnedSecrets pass and so no refusal gate stands between
 * those values and the parser, even when a declared entry mirrors the same
 * server or an adoption copied the group's credentials into a new entry's
 * storage (the host group keeps its own copy) - so sends-implies-uses guards
 * nothing there and is not claimed. The host round trip's re-parse
 * (parseAttachedServer) reuses the same narrowing helpers and can only drop
 * further, so it needs no claim of its own.
 *
 * The probe construction matches the sibling pin and fails closed:
 *
 * - the field universe is SECRET_FIELD_IDS, derived in serverEntry.ts from
 *   OPTIONAL_ENTRY_FIELDS and never re-listed here, so a new secret field
 *   enters every probe by construction;
 * - the shape space is every PRESENCE combination of every entry field both
 *   registries declare (the descriptor's non-secret half, the extension-side
 *   ENTRY_VIEW_FIELD_IDS, and the secret fields themselves through each
 *   resolution source), so a branch anywhere in the chain keying on the
 *   presence of ANY entry field lands inside the probed space. The chain's
 *   value-sensitive conditions (narrowVirtualKey's header-legality checks)
 *   only NARROW the send side, and the probe plants header-legal values, so
 *   presence probing over-approximates what can ride - the safe direction.
 *   The probe-value table below is total over the id union, so a new field
 *   fails typecheck here until it gets a probe value instead of silently
 *   shrinking the space;
 * - "the chat path sends it" is observed, never modeled: per-field sentinels
 *   are planted (stored and inline, the two resolution sources) and detected
 *   in the parsed GroupServer, with a positive control per field so a probe
 *   that stops detecting anything fails instead of passing vacuously.
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
		// The one arm outside the probed space. The two sides refuse by two
		// DIFFERENT judgments that coincide on this arm: the rule normalizes
		// the raw base URL, the parser trims first and then normalizes, so
		// every URL the rule refuses the parser refuses too (its refusal set
		// is strictly wider). The parser refusing the configuration means the
		// chat request path composes no server, so no field can ride a chat
		// request; it is NOT a claim that no resolved value leaves the process
		// - the settings parser accepts a "/" base URL, so the sync engine
		// still hands buildGroupArgs' resolution (a stamp-mismatched value
		// already dropped, matching or inline ones not) to the host's
		// add-group command, where it sits in the host store, refused by this
		// parser on every call.
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
