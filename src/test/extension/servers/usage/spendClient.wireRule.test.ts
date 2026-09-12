/**
 * The arms of entryUsesSecretField (shared/serverEntry.ts, the ONE wire rule deciding which credential fields an
 * entry's shape would send) must cover every field usageConnectionFor (the raw-blob composer entryConnectionFor
 * feeds) lets ride, or a stale-stamped stored value the pairing gates never refused rides to a host it was never
 * stored for. The composer's header-legality checks only NARROW the send side and the probe plants header-legal
 * values, so presence probing over-approximates what can ride, the safe direction.
 */

import * as assert from "node:assert";
import type { DeclaredServer } from "../../../../extension/servers/serverSync";
import { keyInfoUrl, usageConnectionFor } from "../../../../extension/servers/usage";
import { entryUsesSecretField, SECRET_FIELD_IDS } from "../../../../shared/serverEntry";
import type { ShapeFieldValues } from "../../../util/wireRuleProbe";
import { allSecretSentinels, memoizedWireRuleWalk } from "../../../util/wireRuleProbe";

/**
 * One usable probe value per shape field. Total over the id union on purpose:
 * adding a field to OPTIONAL_ENTRY_FIELDS or the entry-view registry breaks
 * this table's typecheck, forcing the new field into the probed shape space.
 * The values are parser-legal (a header name the parser would accept, a real
 * token URL) so the probed shapes are the reachable ones.
 */
const SHAPE_FIELD_VALUES: ShapeFieldValues = {
	oauthTokenUrl: "http://idp.test/oauth2/token",
	oauthClientId: "client-1",
	oauthScopes: "usage.read",
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
 * The shared exhaustive walk (util/wireRuleProbe.ts) over this pin's
 * composition: the raw-blob composer itself, straight from entry and stored
 * blob, so its `sends` is exactly what usageConnectionFor lets ride. The
 * composer always returns a connection, so this serialization deliberately
 * does not normalize: a composer that starts refusing crashes the walk here
 * instead of reading as a silent no-ride.
 */
const probeRecords = memoizedWireRuleWalk(SHAPE_FIELD_VALUES, (entry, stored) =>
	JSON.stringify(usageConnectionFor(entry, stored))
);

suite("extension/servers/usage spendClient wire-rule superset", () => {
	test("per field, the composer sends only what the wire rule attributes somewhere", () => {
		// The field-set comparison the pointwise walk summarizes to: both sets
		// derived by probing the real implementations, compared per field.
		const records = probeRecords();
		for (const field of SECRET_FIELD_IDS) {
			const sent = records.some((record) => record.field === field && record.sends);
			const used = records.some((record) => record.field === field && record.uses);
			assert.ok(
				!sent || used,
				`usageConnectionFor sends "${field}" on some entry shape but entryUsesSecretField attributes it on none - ` +
					"the wire rule's arms no longer cover the composer's narrowing"
			);
		}
	});

	test("on every reachable entry shape, a value the composer sends is a value the wire rule owns", () => {
		// The pointwise superset: sends implies uses on each shape, so the
		// refusal gates reading entryUsesSecretField cover every pairing the
		// composer would actually put on the wire.
		for (const record of probeRecords()) {
			assert.ok(
				!record.sends || record.uses,
				`entryUsesSecretField denies "${record.field}" on shape [${record.shapeName}] yet usageConnectionFor sends ` +
					`it planted as [${record.plantingName}] - a stale-stamped "${record.field}" would ride this shape unrefused`
			);
		}
	});

	test("positive control: every secret field's sentinel is observed riding at least once", () => {
		// A probe that never fires proves nothing: if detection broke (the
		// composer or connection shape changed under it), the superset tests
		// above would pass vacuously. Each field must be seen riding on some
		// shape, or the pin's probe needs revisiting alongside the change.
		const records = probeRecords();
		for (const field of SECRET_FIELD_IDS) {
			assert.ok(
				records.some((record) => record.field === field && record.sends),
				`the probe never observed "${field}" riding a composed connection - the composer stopped sending it or ` +
					"the detection broke; revisit this pin with the change"
			);
		}
	});

	test("the wire rule's no-server arm denies every field and the usage endpoint cannot form", () => {
		// A base URL that normalizes to nothing forms no server, so the rule denies every field while the composer
		// still carries resolved values and the usage GET has no absolute URL to form. This is NOT a claim that no
		// byte can leave the process, since an active OAuth unit's token exchange targets its own absolute token URL
		// first; the per-consumer policies below decide that residual.
		//
		//   usage poller      -> composes from resolveOwnedSecrets, which drops a stamp-mismatched value first
		//   MCP publisher     -> forwards credentials only under sameOrigin, whose URL parse fails closed on "/"
		//   one-shot features -> consult no refusal at all, by documented choice (entryConnection.ts)
		const entry: DeclaredServer = { label: "probe", baseUrl: "/", ...SHAPE_FIELD_VALUES };
		for (const field of SECRET_FIELD_IDS) {
			assert.strictEqual(entryUsesSecretField(entry, field), false, `the no-server arm must deny "${field}"`);
		}
		const stored = allSecretSentinels();
		const connection = usageConnectionFor(entry, stored);
		assert.throws(
			() => new URL(keyInfoUrl(connection.baseUrl, connection.apiVersion)),
			TypeError,
			"a normalized-to-empty root must not form an absolute usage URL"
		);
	});
});
