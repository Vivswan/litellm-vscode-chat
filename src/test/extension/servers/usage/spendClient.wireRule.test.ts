/**
 * Pins the superset relation the MCP safety argument rests on: the arms of
 * entryUsesSecretField (shared/serverEntry.ts, the ONE wire rule deciding
 * which credential fields an entry's shape would send) must cover every field
 * usageConnectionFor (the usage/spend connection composer) actually lets ride.
 * The pairing gates - resolveOwnedSecrets' refusals, read by the sync engine,
 * the MCP publisher's resolve boundary, and the stale-stamp consent question -
 * refuse a stale-stamped stored value only when the wire rule says the entry's
 * shape uses its field; a shape the composer sends but the rule denies would
 * let such a value ride to a host it was never stored for, unrefused. Today
 * the two sides agree by parallel implementation; this suite derives BOTH from
 * the real functions and fails closed:
 *
 * - the field universe is SECRET_FIELD_IDS, derived in serverEntry.ts from
 *   OPTIONAL_ENTRY_FIELDS and never re-listed here, so a new secret field
 *   enters every probe by construction;
 * - the shape space is every PRESENCE combination of every entry field both
 *   registries declare (the descriptor's non-secret half, the extension-side
 *   ENTRY_VIEW_FIELD_IDS, and the secret fields themselves through each
 *   resolution source), so a composer branch keying on the presence of ANY
 *   entry field - an auth half, an apiVersion, or another secret alike -
 *   lands inside the probed space. The composer's value-sensitive conditions
 *   (its header-legality checks) only NARROW the send side, and the probe
 *   plants header-legal values, so presence probing over-approximates what
 *   can ride - the safe direction. The probe-value table
 *   below is total over the id union, so a new field fails typecheck here
 *   until it gets a probe value instead of silently shrinking the space;
 * - "the composer sends it" is observed, never modeled: per-field sentinels
 *   are planted (stored and inline, the two resolution sources) and detected
 *   in the composed connection, with a positive control per field so a probe
 *   that stops detecting anything fails instead of passing vacuously.
 *
 * Scope: this pins the usage composer alone. The chat path's sibling
 * narrowing (parseGroupConfiguration's narrowOAuth/narrowVirtualKey, which
 * the wire rule's arms are documented as derived from) is pinned by its own
 * sibling suite (test/provider/catalog/groupModels.wireRule.test.ts, which
 * composes the sync engine's real chain); it composes from
 * resolveOwnedSecrets' resolution, so the raw-blob composition
 * entryConnectionFor feeds this composer is the one this pin covers.
 */

import * as assert from "node:assert";
import type { DeclaredServer } from "../../../../extension/servers/serverSync";
import { keyInfoUrl, usageConnectionFor } from "../../../../extension/servers/usage";
import type { EntryViewFieldId, NonSecretOptionalFieldId, SecretFieldId } from "../../../../shared/serverEntry";
import {
	ENTRY_VIEW_FIELD_IDS,
	entryUsesSecretField,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	SECRET_FIELD_IDS,
} from "../../../../shared/serverEntry";

const PROBE_BASE_URL = "http://litellm.test:4000";

/** Every non-secret field an entry can carry, from both registries; the probed shape space spans all of them. */
type ShapeFieldId = NonSecretOptionalFieldId | EntryViewFieldId;

const SHAPE_FIELD_IDS: readonly ShapeFieldId[] = [...NON_SECRET_OPTIONAL_FIELD_IDS, ...ENTRY_VIEW_FIELD_IDS];

/**
 * One usable probe value per shape field. Total over the id union on purpose:
 * adding a field to OPTIONAL_ENTRY_FIELDS or the entry-view registry breaks
 * this table's typecheck, forcing the new field into the probed shape space.
 * The values are parser-legal (a header name the parser would accept, a real
 * token URL) so the probed shapes are the reachable ones.
 */
const SHAPE_FIELD_VALUES: { readonly [K in ShapeFieldId]: NonNullable<DeclaredServer[K]> } = {
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

/** Header-legal, unique per field, and terminator-suffixed so no field id prefixing another can cross-attribute. */
function sentinelFor(field: SecretFieldId): string {
	return `wire-probe-sentinel-${field}-end`;
}

/**
 * Where one secret field's sentinel sits in a probe: absent, in the stored
 * blob, or inline on the entry (inline wins at resolution). Every probe
 * assigns one source per secret field independently, so a composer branch
 * activated by ANOTHER secret's presence - the escape a single-planting probe
 * would leave - is inside the space.
 */
const SECRET_SOURCES = ["absent", "stored", "inline"] as const;
type SecretSource = (typeof SECRET_SOURCES)[number];

/** One composed probe: which fields rode, and what the wire rule says about each, on one entry shape. */
interface ProbeRecord {
	readonly shapeName: string;
	readonly plantingName: string;
	readonly field: SecretFieldId;
	readonly sends: boolean;
	readonly uses: boolean;
}

/** Every presence combination of the shape fields, over a base URL that forms a server. */
function allShapes(): { name: string; entry: DeclaredServer }[] {
	const shapes: { name: string; entry: DeclaredServer }[] = [];
	for (let mask = 0; mask < 1 << SHAPE_FIELD_IDS.length; mask += 1) {
		const present = SHAPE_FIELD_IDS.filter((_, index) => (mask & (1 << index)) !== 0);
		const optional: { -readonly [K in ShapeFieldId]?: DeclaredServer[K] } = {};
		for (const field of present) {
			assignShapeField(optional, field);
		}
		shapes.push({
			name: present.length === 0 ? "(bare entry)" : present.join("+"),
			entry: { label: "probe", baseUrl: PROBE_BASE_URL, ...optional },
		});
	}
	return shapes;
}

/** The per-field copy, generic so the assignment stays typed to the field's own value. */
function assignShapeField<K extends ShapeFieldId>(target: { [P in K]?: DeclaredServer[P] }, field: K): void {
	target[field] = SHAPE_FIELD_VALUES[field];
}

/** Every assignment of a resolution source to each secret field (3^n vectors). */
function allPlantings(): { name: string; sources: ReadonlyMap<SecretFieldId, SecretSource> }[] {
	const plantings: { name: string; sources: ReadonlyMap<SecretFieldId, SecretSource> }[] = [];
	const total = SECRET_SOURCES.length ** SECRET_FIELD_IDS.length;
	for (let code = 0; code < total; code += 1) {
		const sources = new Map<SecretFieldId, SecretSource>();
		let rest = code;
		for (const field of SECRET_FIELD_IDS) {
			const source = SECRET_SOURCES[rest % SECRET_SOURCES.length] as SecretSource;
			rest = Math.floor(rest / SECRET_SOURCES.length);
			if (source !== "absent") {
				sources.set(field, source);
			}
		}
		plantings.push({
			name:
				sources.size === 0
					? "(no secrets)"
					: [...sources.entries()].map(([field, source]) => `${field}:${source}`).join("+"),
			sources,
		});
	}
	return plantings;
}

/**
 * The one exhaustive walk, memoized because all three superset tests read it:
 * for every shape and planting vector, compose the connection once and record,
 * per planted field, whether its sentinel rode and what the wire rule says.
 * Detection is textual over the whole connection on purpose: it needs no
 * knowledge of WHERE the composer carries a value, so a restructured
 * UsageConnection cannot hide a ride from the probe.
 */
let walked: readonly ProbeRecord[] | undefined;
function probeRecords(): readonly ProbeRecord[] {
	if (walked !== undefined) {
		return walked;
	}
	const shapes = allShapes();
	const plantings = allPlantings();
	// The space is exhaustive and grows exponentially with the registries; a
	// legible bound turns a future blow-up into a decision (sample or lazify)
	// instead of a mocha timeout that names nothing.
	assert.ok(
		shapes.length * plantings.length <= 500_000,
		`the probe space grew to ${shapes.length} shapes x ${plantings.length} plantings - restructure the walk before it times out`
	);
	const records: ProbeRecord[] = [];
	for (const shape of shapes) {
		for (const planting of plantings) {
			const inline: { -readonly [K in SecretFieldId]?: string } = {};
			const stored: { -readonly [K in SecretFieldId]?: string } = {};
			for (const [field, source] of planting.sources) {
				(source === "inline" ? inline : stored)[field] = sentinelFor(field);
			}
			const probedEntry: DeclaredServer = { ...shape.entry, ...inline };
			const connection = JSON.stringify(usageConnectionFor(probedEntry, stored));
			for (const field of SECRET_FIELD_IDS) {
				if (!planting.sources.has(field)) {
					continue;
				}
				records.push({
					shapeName: shape.name,
					plantingName: planting.name,
					field,
					sends: connection.includes(sentinelFor(field)),
					uses: entryUsesSecretField(probedEntry, field),
				});
			}
		}
	}
	walked = records;
	return records;
}

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
		// The one arm outside the probed space: a base URL that normalizes to
		// nothing forms no server (parseGroupConfiguration refuses the group),
		// so entryUsesSecretField answers false for every field while the
		// composer still carries resolved values in its object. The usage GET
		// itself can never form - no absolute URL - which is pinned below. This
		// is deliberately NOT a claim that no byte can leave the process: an
		// active OAuth unit's token exchange targets the token URL, an absolute
		// address of its own, before the usage URL is used. Per consumer of
		// this composer, that residual is closed elsewhere: the usage poller
		// composes from resolveOwnedSecrets' resolution, which drops a
		// stamp-mismatched value before it can ride; entryConnectionFor hands
		// the raw blob to the composer, but its MCP caller only forwards
		// credentials under sameOrigin, whose URL parse fails closed on an
		// all-slashes base URL, and the six one-shot feature sends consult no
		// refusal at all by documented choice (entryConnection.ts) - this arm's
		// answer never gates them in the first place.
		const entry: DeclaredServer = { label: "probe", baseUrl: "/", ...SHAPE_FIELD_VALUES };
		for (const field of SECRET_FIELD_IDS) {
			assert.strictEqual(entryUsesSecretField(entry, field), false, `the no-server arm must deny "${field}"`);
		}
		const stored: { -readonly [K in SecretFieldId]?: string } = {};
		for (const field of SECRET_FIELD_IDS) {
			stored[field] = sentinelFor(field);
		}
		const connection = usageConnectionFor(entry, stored);
		assert.throws(
			() => new URL(keyInfoUrl(connection.baseUrl, connection.apiVersion)),
			TypeError,
			"a normalized-to-empty root must not form an absolute usage URL"
		);
	});
});
