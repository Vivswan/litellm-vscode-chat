import * as assert from "node:assert";
import type { LabelExpansionResult } from "../../../extension/migrations/labelScopedModelParameters";
import {
	expandLabelScopedKeys,
	getMigratedServerLabels,
} from "../../../extension/migrations/labelScopedModelParameters";
import { LEGACY_MODEL_PARAMETERS_ID } from "../../../extension/migrations/settingsRedesign/legacyIds";
import { planSettingsRedesign } from "../../../extension/migrations/settingsRedesign/transform";
import type { SettingsSnapshot } from "../../../extension/migrations/settingsRedesign/types";
import { MIGRATED_SERVER_LABELS_KEY } from "../../../shared/config/storageKeys";
import { makeExtensionStorage, makeMigrationContext } from "../../testUtils";

// User-written label/host fragments that must never reach log lines; hoisted so
// the URL-ish literal never sits inside an includes() guard (CodeQL shape rule).
const USER_TEXT_NEEDLES = ["Prod", "prod.test"];

import { applyPlanToSnapshot } from "./settingsRedesignOracle";

interface Layers {
	globalValue?: Record<string, unknown>;
	workspaceValue?: Record<string, unknown>;
	workspaceFolderValue?: Record<string, unknown>;
}

/** Assemble the snapshot slice the expansion reads: the legacy record's layers plus the raw servers value. */
function snap(layers: Layers, servers?: unknown[]): SettingsSnapshot {
	return {
		[LEGACY_MODEL_PARAMETERS_ID]: layers,
		...(servers !== undefined ? { servers: { globalValue: servers } } : {}),
	};
}

function expand(
	layers: Layers,
	labelMap: Record<string, string[]>,
	options: { servers?: unknown[]; ledger?: ReadonlySet<string> } = {}
): LabelExpansionResult & { value: Record<string, unknown> | undefined; servers: unknown } {
	const snapshot = snap(layers, options.servers);
	const result = expandLabelScopedKeys(snapshot, labelMap, options.ledger ?? new Set());
	return {
		...result,
		value: result.snapshot[LEGACY_MODEL_PARAMETERS_ID]?.globalValue as Record<string, unknown> | undefined,
		servers: result.snapshot.servers?.globalValue,
	};
}

/** The ledger member shape the pre-fold rewrite persisted: JSON keeps a label containing "/" unambiguous. */
function member(label: string, prefix: string): string {
	return JSON.stringify([label, prefix]);
}

suite("extension/migrations/labelScopedModelParameters: expansion", () => {
	test("adds base-URL-scoped copies beside the originals", () => {
		const { value, logLines } = expand(
			{
				globalValue: {
					"Prod/gpt-4": { temperature: 0.2 },
					"Prod/claude": { temperature: 0.5 },
					"gpt-4": { temperature: 1 },
				},
			},
			{ "http://prod.test": ["Prod"] }
		);

		assert.deepStrictEqual(value, {
			"Prod/gpt-4": { temperature: 0.2 },
			"Prod/claude": { temperature: 0.5 },
			"gpt-4": { temperature: 1 },
			"http://prod.test/gpt-4": { temperature: 0.2 },
			"http://prod.test/claude": { temperature: 0.5 },
		});
		// Logs feed the public issue-report buffer: counts only, never the keys.
		assert.ok(
			logLines.some((l) => l.includes("Added 2")),
			`expected a count-only line. Lines: ${logLines.join(" | ")}`
		);
		assert.ok(
			!logLines.some((l) => USER_TEXT_NEEDLES.some((needle) => l.includes(needle))),
			`no user-controlled key or URL may reach the logs. Lines: ${logLines.join(" | ")}`
		);
	});

	test("a copy whose base-URL key already exists is not added and nothing changes", () => {
		const layers: Layers = {
			globalValue: {
				"Prod/gpt-4": { temperature: 0.2 },
				"http://prod.test/gpt-4": { temperature: 0.9 },
			},
		};
		const snapshot = snap(layers);
		const result = expandLabelScopedKeys(snapshot, { "http://prod.test": ["Prod"] }, new Set());
		assert.strictEqual(result.snapshot, snapshot, "the existing base-URL entry wins; nothing to expand");
	});

	test("a key that reads as a provider-prefixed model ID is copied, never moved", () => {
		// "openai/gpt-4o" is a legitimate bare model-prefix key even when a server
		// label "openai" exists; provenance is unprovable, so the original survives.
		const { value } = expand(
			{ globalValue: { "openai/gpt-4o": { temperature: 0.3 } } },
			{
				"http://proxy.test": ["openai"],
			}
		);
		assert.deepStrictEqual(value, {
			"openai/gpt-4o": { temperature: 0.3 },
			"http://proxy.test/gpt-4o": { temperature: 0.3 },
		});
	});

	test("a label the map does not know is left untouched", () => {
		const layers: Layers = {
			globalValue: { "Shared/gpt-4": { temperature: 0.2 }, "openai/gpt-4": { temperature: 0.3 } },
		};
		const snapshot = snap(layers);
		const result = expandLabelScopedKeys(snapshot, { "http://prod.test": ["Prod"] }, new Set());
		assert.strictEqual(result.snapshot, snapshot);
	});

	test("workspace-layer keys are counted in a warning, never edited or named", () => {
		const layers: Layers = {
			workspaceValue: { "Prod/gpt-4": { temperature: 0.2 } },
			workspaceFolderValue: { "Prod/claude": { temperature: 0.5 } },
		};
		const { snapshot, logLines } = expandLabelScopedKeys(snap(layers), { "http://prod.test": ["Prod"] }, new Set());
		assert.strictEqual(snapshot[LEGACY_MODEL_PARAMETERS_ID], layers, "workspace layers must never be rewritten");
		const warning = logLines.find((l) => l.includes("workspace"));
		assert.ok(warning !== undefined, `expected a workspace warning. Lines: ${logLines.join(" | ")}`);
		assert.ok(warning.includes("2 workspace-layer"), warning);
		assert.ok(warning.includes('"<baseUrl>/<model prefix>"'), warning);
		assert.ok(!warning.includes("Prod"), "setting keys must not reach the logs");
	});

	test("re-expanding the expanded snapshot changes nothing", () => {
		const labelMap = { "http://prod.test": ["Prod"] };
		const first = expandLabelScopedKeys(
			snap({ globalValue: { "Prod/gpt-4": { temperature: 0.2 } } }),
			labelMap,
			new Set()
		);
		const second = expandLabelScopedKeys(first.snapshot, labelMap, new Set());
		assert.strictEqual(second.snapshot, first.snapshot, "the copies exist, so nothing expands again");
	});

	test("an empty label map is a no-op", () => {
		const snapshot = snap({ globalValue: { "Prod/gpt-4": { temperature: 0.2 } } });
		assert.strictEqual(expandLabelScopedKeys(snapshot, {}, new Set()).snapshot, snapshot);
	});

	test("a key several mapped labels prefix gets a copy per label", () => {
		// Each server's requests consulted only its own pre-migration label, so both
		// readings are live (one per server) and each needs its base-URL copy.
		const { value } = expand(
			{ globalValue: { "Prod/EU/gpt-4": { temperature: 0.2 } } },
			{
				"http://prod.test": ["Prod"],
				"http://eu.test": ["Prod/EU"],
			}
		);
		assert.deepStrictEqual(value, {
			"Prod/EU/gpt-4": { temperature: 0.2 },
			"http://prod.test/EU/gpt-4": { temperature: 0.2 },
			"http://eu.test/gpt-4": { temperature: 0.2 },
		});
	});

	test("a label equal to its own base URL leaves the key untouched", () => {
		// The "copy" would be the key itself; nothing may be dropped or added.
		const snapshot = snap({ globalValue: { "https://llm.corp.com/gpt-4": { temperature: 0.2 } } });
		const result = expandLabelScopedKeys(snapshot, { "https://llm.corp.com": ["https://llm.corp.com"] }, new Set());
		assert.strictEqual(result.snapshot, snapshot);
	});

	test("a label that is a URL-prefix of its own base URL copies once and stays stable", () => {
		// Without the base-URL-form guard, the first pass's copy would match the
		// label again and grow a new "/v1" segment on every re-expansion.
		const labelMap = { "https://llm.corp.com/v1": ["https://llm.corp.com"] };
		const first = expandLabelScopedKeys(
			snap({ globalValue: { "https://llm.corp.com/gpt-4": { temperature: 0.2 } } }),
			labelMap,
			new Set()
		);
		assert.deepStrictEqual(first.snapshot[LEGACY_MODEL_PARAMETERS_ID]?.globalValue, {
			"https://llm.corp.com/gpt-4": { temperature: 0.2 },
			"https://llm.corp.com/v1/gpt-4": { temperature: 0.2 },
		});
		const second = expandLabelScopedKeys(first.snapshot, labelMap, new Set());
		assert.strictEqual(second.snapshot, first.snapshot, "re-expansion must never compound the base-URL path");
	});

	test("documented corner: a genuinely label-shaped key under the label's own base URL gets no copy", () => {
		// The key can be a real label reading (model prefix "v1/gpt-4"), but it is
		// indistinguishable from a copy an earlier pass added, so it stays untouched.
		const snapshot = snap({ globalValue: { "https://llm.corp/v1/gpt-4": { temperature: 0.2 } } });
		const result = expandLabelScopedKeys(snapshot, { "https://llm.corp/v1": ["https://llm.corp"] }, new Set());
		assert.strictEqual(result.snapshot, snapshot);
	});

	test("a label equal to ANOTHER server's base URL still gets its copy", () => {
		// The accretion guard is per label: only a key under label X's OWN base URL
		// is exempt from X's copy, so Y's presence must not suppress X's.
		const { value } = expand(
			{ globalValue: { "https://y.test/gpt-4": { temperature: 0.2 } } },
			{
				"http://x.test": ["https://y.test"],
				"https://y.test": ["Y"],
			}
		);
		assert.deepStrictEqual(value, {
			"https://y.test/gpt-4": { temperature: 0.2 },
			"http://x.test/gpt-4": { temperature: 0.2 },
		});
	});

	test("a raw map value is normalized before it becomes a key", () => {
		// The runtime scope is the group's normalized base URL; a trailing slash
		// straight from the map would build a key that never matches.
		const { value } = expand(
			{ globalValue: { "Prod/gpt-4": { temperature: 0.2 } } },
			{
				"http://prod.test///": ["Prod"],
			}
		);
		assert.deepStrictEqual(value, {
			"Prod/gpt-4": { temperature: 0.2 },
			"http://prod.test/gpt-4": { temperature: 0.2 },
		});
	});

	test("a declared entry carrying the label receives the params in its flat record; no base-URL copy", () => {
		const { value, servers, logLines } = expand(
			{ globalValue: { "Prod/gpt-4": { temperature: 0.2 }, "gpt-4": { temperature: 1 } } },
			{ "http://prod.test": ["Prod"] },
			{ servers: [{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1" }] }
		);
		assert.deepStrictEqual(value, { "Prod/gpt-4": { temperature: 0.2 }, "gpt-4": { temperature: 1 } });
		assert.deepStrictEqual(servers, [
			{
				label: "Prod",
				baseUrl: "http://prod.test",
				apiKey: "sk-1",
				modelParameters: { "gpt-4": { temperature: 0.2 } },
			},
		]);
		assert.ok(
			!logLines.some((l) => USER_TEXT_NEEDLES.some((needle) => l.includes(needle))),
			`no user-controlled key or URL may reach the logs. Lines: ${logLines.join(" | ")}`
		);
	});

	test("existing entry keys win the merge; expanded keys only fill gaps", () => {
		const { servers } = expand(
			{ globalValue: { "Prod/gpt-4": { temperature: 0.2 }, "Prod/claude": { temperature: 0.5 } } },
			{ "http://prod.test": ["Prod"] },
			{
				servers: [{ label: "Prod", baseUrl: "http://prod.test", modelParameters: { "gpt-4": { temperature: 0.9 } } }],
			}
		);
		assert.deepStrictEqual(
			servers,
			[
				{
					label: "Prod",
					baseUrl: "http://prod.test",
					modelParameters: { "gpt-4": { temperature: 0.9 }, claude: { temperature: 0.5 } },
				},
			],
			"the user's own entry key is deliberate current configuration and must not be overwritten"
		);
	});

	test("two same-URL labels with different params each land in their own entry", () => {
		// The base-URL copy collapsed these into one insertion-order-dependent
		// key; the per-entry destination is exact.
		const { servers } = expand(
			{ globalValue: { "A/gpt-4": { temperature: 0.1 }, "B/gpt-4": { temperature: 0.6 } } },
			{ "http://x.test": ["A", "B"] },
			{
				servers: [
					{ label: "A", baseUrl: "http://x.test" },
					{ label: "B", baseUrl: "http://x.test" },
				],
			}
		);
		assert.deepStrictEqual(servers, [
			{ label: "A", baseUrl: "http://x.test", modelParameters: { "gpt-4": { temperature: 0.1 } } },
			{ label: "B", baseUrl: "http://x.test", modelParameters: { "gpt-4": { temperature: 0.6 } } },
		]);
	});

	test("a label no declared entry carries falls back to the base-URL copy", () => {
		const { value, servers } = expand(
			{ globalValue: { "Prod/gpt-4": { temperature: 0.2 } } },
			{ "http://prod.test": ["Prod"] },
			{ servers: [{ label: "Other", baseUrl: "http://other.test" }] }
		);
		assert.deepStrictEqual(value, {
			"Prod/gpt-4": { temperature: 0.2 },
			"http://prod.test/gpt-4": { temperature: 0.2 },
		});
		assert.deepStrictEqual(servers, [{ label: "Other", baseUrl: "http://other.test" }]);
	});

	test("a same-label entry at another URL is a label reuse and gets nothing", () => {
		// The params were scoped to the label's pre-migration server; handing them
		// to an entry pointing elsewhere would repeat the label-alone confusion.
		const { value, servers } = expand(
			{ globalValue: { "Prod/gpt-4": { temperature: 0.2 } } },
			{ "http://prod.test": ["Prod"] },
			{ servers: [{ label: "Prod", baseUrl: "http://elsewhere.test" }] }
		);
		assert.deepStrictEqual(value, {
			"Prod/gpt-4": { temperature: 0.2 },
			"http://prod.test/gpt-4": { temperature: 0.2 },
		});
		assert.deepStrictEqual(servers, [{ label: "Prod", baseUrl: "http://elsewhere.test" }]);
	});

	test("a pre-fold ledger member is honored: the user's deletion stays deleted", () => {
		// An earlier release's standalone rewrite copied this source into the entry
		// and ledgered it; the user deleted the copy since, and the fold honors that.
		const snapshot = snap({ globalValue: { "Prod/gpt-4": { temperature: 0.2 } } }, [
			{ label: "Prod", baseUrl: "http://prod.test" },
		]);
		const result = expandLabelScopedKeys(
			snapshot,
			{ "http://prod.test": ["Prod"] },
			new Set([member("Prod", "gpt-4")])
		);
		assert.strictEqual(result.snapshot, snapshot, "the ledgered source must not be copied again");
	});

	test("unrecorded sources still expand beside ledgered ones", () => {
		const { servers } = expand(
			{ globalValue: { "Prod/gpt-4": { temperature: 0.2 }, "Prod/claude": { temperature: 0.5 } } },
			{ "http://prod.test": ["Prod"] },
			{
				servers: [{ label: "Prod", baseUrl: "http://prod.test" }],
				ledger: new Set([member("Prod", "gpt-4")]),
			}
		);
		assert.deepStrictEqual(
			servers,
			[{ label: "Prod", baseUrl: "http://prod.test", modelParameters: { claude: { temperature: 0.5 } } }],
			"only the unrecorded source lands; the deleted one stays deleted"
		);
	});

	test('an unsafe stripped prefix ("Prod/__proto__") falls back to the base-URL copy', () => {
		// "__proto__" can never become an own key of the entry record (the merge
		// would mutate the temp object's prototype); the full base-URL key is safe.
		const { value, servers } = expand(
			{ globalValue: { "Prod/__proto__": { temperature: 0.2 } } },
			{ "http://prod.test": ["Prod"] },
			{ servers: [{ label: "Prod", baseUrl: "http://prod.test" }] }
		);
		assert.deepStrictEqual(value, {
			"Prod/__proto__": { temperature: 0.2 },
			"http://prod.test/__proto__": { temperature: 0.2 },
		});
		assert.deepStrictEqual(servers, [{ label: "Prod", baseUrl: "http://prod.test" }], "the entry stays untouched");
	});
});

suite("extension/migrations/labelScopedModelParameters: the fold through the pipeline", () => {
	test("label-scoped keys ride the whole plan: entry copies nest and star, originals star, fallbacks place", () => {
		const snapshot: SettingsSnapshot = {
			servers: { globalValue: [{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1" }] },
			modelParameters: {
				globalValue: {
					"Prod/gpt-4": { temperature: 0.2 },
					"Ghost/claude": { temperature: 0.5 },
				},
			},
		};
		const labels = {
			labelsByBaseUrl: { "http://prod.test": ["Prod"], "http://ghost.test": ["Ghost"] },
		};
		const plan = planSettingsRedesign(snapshot, labels);
		const migrated = applyPlanToSnapshot(snapshot, plan.writes);

		// The entry destination nests and stars through the same plan's restructure;
		// the no-entry fallback becomes a URL-scoped key (no entry at ghost.test: inert).
		assert.deepStrictEqual(migrated.servers?.globalValue, [
			{
				label: "Prod",
				baseUrl: "http://prod.test",
				auth: { apiKey: "sk-1" },
				models: { parameters: { "gpt-4*": { temperature: 0.2 } } },
			},
		]);
		assert.deepStrictEqual(migrated["models.parameters"]?.globalValue, {
			"Prod/gpt-4*": { temperature: 0.2 },
			"Ghost/claude*": { temperature: 0.5 },
			"http://ghost.test/claude": { temperature: 0.5 },
		});
		assert.strictEqual(migrated.modelParameters, undefined, "the legacy id is consumed by the same plan");

		// Idempotent through the pipeline: the legacy id is gone, so a rerun writes nothing.
		const rerun = planSettingsRedesign(migrated, labels);
		assert.deepStrictEqual(rerun.writes, []);
	});
});

suite("extension/migrations/labelScopedModelParameters: getMigratedServerLabels", () => {
	test("reads the persisted map with URLs normalized", () => {
		const storage = makeExtensionStorage({
			[MIGRATED_SERVER_LABELS_KEY]: { "http://prod.test/": ["Prod"], "http://staging.test": ["Staging"] },
		});

		assert.deepStrictEqual(getMigratedServerLabels(storage.memento), {
			"http://prod.test": ["Prod"],
			"http://staging.test": ["Staging"],
		});
	});

	test("a label mapped to different URLs is dropped everywhere", () => {
		// The retired writer kept the map unambiguous, but the blob is plain
		// Memento state; an ambiguous label cannot resolve to one server.
		const storage = makeExtensionStorage({
			[MIGRATED_SERVER_LABELS_KEY]: { "http://prod.test": ["Prod", "Shared"], "http://other.test": ["Shared"] },
		});

		assert.deepStrictEqual(getMigratedServerLabels(storage.memento), { "http://prod.test": ["Prod"] });
	});

	test("the same label under trailing-slash variants of one URL is one entry, not a conflict", () => {
		const storage = makeExtensionStorage({
			[MIGRATED_SERVER_LABELS_KEY]: { "http://prod.test/": ["Production"], "http://prod.test": ["Production"] },
		});

		assert.deepStrictEqual(getMigratedServerLabels(storage.memento), { "http://prod.test": ["Production"] });
	});

	test("an unparseable blob reads as an empty map", () => {
		const storage = makeExtensionStorage({ [MIGRATED_SERVER_LABELS_KEY]: "not a map" });

		assert.deepStrictEqual(getMigratedServerLabels(storage.memento), {});
	});

	test("the persisted map decodes label-scoped keys through the fold", () => {
		const storage = makeExtensionStorage({ [MIGRATED_SERVER_LABELS_KEY]: { "http://staging.test": ["Staging"] } });
		const ctx = makeMigrationContext(storage);

		const labels = getMigratedServerLabels(ctx.globalState);
		const { value } = expand({ globalValue: { "Staging/gpt-4": { temperature: 0.3 } } }, labels);

		assert.deepStrictEqual(value?.["http://staging.test/gpt-4"], { temperature: 0.3 });
		assert.deepStrictEqual(value?.["Staging/gpt-4"], { temperature: 0.3 }, "the original key is kept");
	});
});
