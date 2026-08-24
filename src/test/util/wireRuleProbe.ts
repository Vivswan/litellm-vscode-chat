/**
 * The shared probe harness behind the two wire-rule superset pins
 * (extension/servers/usage/spendClient.wireRule.test.ts and
 * provider/catalog/groupModels.wireRule.test.ts). Each suite supplies its own
 * composition - the real chain whose sends it pins - and its own probe-value
 * table; this module owns the probe space both walk and the record shape both
 * assert over, so the two pins cannot drift apart in WHAT they enumerate:
 *
 * - the field universe is SECRET_FIELD_IDS, derived in serverEntry.ts from
 *   OPTIONAL_ENTRY_FIELDS and never re-listed here, so a new secret field
 *   enters every probe by construction;
 * - the shape space is every PRESENCE combination of every entry field both
 *   registries declare (the descriptor's non-secret half, the extension-side
 *   ENTRY_VIEW_FIELD_IDS, and the secret fields themselves through each
 *   resolution source), so a branch anywhere in a suite's composition keying
 *   on the presence of ANY entry field lands inside the probed space;
 * - ShapeFieldValues is total over the shape-field id union, so a new field
 *   fails each suite's table typecheck until it gets a probe value instead of
 *   silently shrinking the space;
 * - "the composition sends it" is observed, never modeled: per-field
 *   sentinels are planted (stored and inline, the two resolution sources) and
 *   detected textually in the suite's own serialization of what it composed.
 *
 * The safety argument each pin rests on - which refusal gates read the wire
 * rule, and what a shape sent-but-denied would let through - stays in each
 * suite's own header, as do the assertions and their failure messages.
 */

import * as assert from "node:assert";
import type { DeclaredServer } from "../../extension/servers/serverSync";
import type { EntryViewFieldId, NonSecretOptionalFieldId, SecretFieldId } from "../../shared/serverEntry";
import {
	ENTRY_VIEW_FIELD_IDS,
	entryUsesSecretField,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	SECRET_FIELD_IDS,
} from "../../shared/serverEntry";

const PROBE_BASE_URL = "http://litellm.test:4000";

/** Every non-secret field an entry can carry, from both registries; the probed shape space spans all of them. */
type ShapeFieldId = NonSecretOptionalFieldId | EntryViewFieldId;

const SHAPE_FIELD_IDS: readonly ShapeFieldId[] = [...NON_SECRET_OPTIONAL_FIELD_IDS, ...ENTRY_VIEW_FIELD_IDS];

/**
 * The shape of a suite's probe-value table: one usable value per shape field.
 * Total over the id union on purpose: adding a field to OPTIONAL_ENTRY_FIELDS
 * or the entry-view registry breaks each suite's table typecheck, forcing the
 * new field into the probed shape space.
 */
export type ShapeFieldValues = { readonly [K in ShapeFieldId]: NonNullable<DeclaredServer[K]> };

/** What a suite's composition receives from the stored side: the SecretStorage blob's value map. */
type StoredSecretValues = { readonly [K in SecretFieldId]?: string };

/** Header-legal, unique per field, and terminator-suffixed so no field id prefixing another can cross-attribute. */
function sentinelFor(field: SecretFieldId): string {
	return `wire-probe-sentinel-${field}-end`;
}

/** Every secret field's sentinel as one stored blob, for the no-server arms outside the probed space. */
export function allSecretSentinels(): StoredSecretValues {
	const stored: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		stored[field] = sentinelFor(field);
	}
	return stored;
}

/**
 * Where one secret field's sentinel sits in a probe: absent, in the stored
 * blob, or inline on the entry (inline wins at resolution). Every probe
 * assigns one source per secret field independently, so a composition branch
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
function allShapes(values: ShapeFieldValues): { name: string; entry: DeclaredServer }[] {
	const shapes: { name: string; entry: DeclaredServer }[] = [];
	for (let mask = 0; mask < 1 << SHAPE_FIELD_IDS.length; mask += 1) {
		const present = SHAPE_FIELD_IDS.filter((_, index) => (mask & (1 << index)) !== 0);
		const optional: { -readonly [K in ShapeFieldId]?: DeclaredServer[K] } = {};
		for (const field of present) {
			assignShapeField(values, optional, field);
		}
		shapes.push({
			name: present.length === 0 ? "(bare entry)" : present.join("+"),
			entry: { label: "probe", baseUrl: PROBE_BASE_URL, ...optional },
		});
	}
	return shapes;
}

/** The per-field copy, generic so the assignment stays typed to the field's own value. */
function assignShapeField<K extends ShapeFieldId>(
	values: ShapeFieldValues,
	target: { [P in K]?: DeclaredServer[P] },
	field: K
): void {
	target[field] = values[field];
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
 * The one exhaustive walk, memoized because every superset test in a suite
 * reads it: for every shape and planting vector, run the suite's composition
 * once and record, per planted field, whether its sentinel rode and what the
 * wire rule says. Detection is textual over the composition's serialization
 * on purpose: it needs no knowledge of WHERE the composition carries a value,
 * so a restructured connection or server shape cannot hide a ride from the
 * probe. The suite serializes its own composed value so this extraction owns
 * no refusal policy: a composition that can refuse decides for itself whether
 * a refusal serializes (no rides) or crashes the walk.
 */
export function memoizedWireRuleWalk(
	values: ShapeFieldValues,
	composeSerialized: (entry: DeclaredServer, stored: StoredSecretValues) => string
): () => readonly ProbeRecord[] {
	let walked: readonly ProbeRecord[] | undefined;
	return () => {
		if (walked !== undefined) {
			return walked;
		}
		const shapes = allShapes(values);
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
				const composed = composeSerialized(probedEntry, stored);
				for (const field of SECRET_FIELD_IDS) {
					if (!planting.sources.has(field)) {
						continue;
					}
					records.push({
						shapeName: shape.name,
						plantingName: planting.name,
						field,
						sends: composed.includes(sentinelFor(field)),
						uses: entryUsesSecretField(probedEntry, field),
					});
				}
			}
		}
		walked = records;
		return records;
	};
}
