import * as assert from "node:assert";
import * as vscode from "vscode";
import type { MigrationContext } from "../../../extension/migrations";
import { MIGRATIONS } from "../../../extension/migrations";
import type { RedesignSettings } from "../../../extension/migrations/settingsRedesign/apply";
import {
	applySettingsRedesign,
	readRedesignSnapshot,
	settingsRedesignMigration,
} from "../../../extension/migrations/settingsRedesign/apply";
import { restructureServers } from "../../../extension/migrations/settingsRedesign/entries";
import type { LegacyHintKind } from "../../../extension/migrations/settingsRedesign/hints";
import { collectLegacyHints } from "../../../extension/migrations/settingsRedesign/hints";
import { planSettingsRedesign } from "../../../extension/migrations/settingsRedesign/transform";
import type { SettingsSnapshot } from "../../../extension/migrations/settingsRedesign/types";
import type { DeclaredServer } from "../../../extension/servers/serverSync";
import { buildGroupArgs, parseServersSetting } from "../../../extension/servers/serverSync";
import { matcherMatches, parseMatcherKey } from "../../../shared/config/modelMatcher";
import { Logger } from "../../../shared/logger";
import { assertOmits, expectDefined } from "../../pureHelpers";
import { fakeFingerprintSaltSession, makeExtensionStorage } from "../../testUtils";
import { applyPlanToSnapshot } from "./settingsRedesignOracle";

// The legacy and new ids, re-declared here on purpose: the migration and its test
// pin the literal identifiers independently (a typo on one side fails instead of
// agreeing with itself), and the pairs mirror the docs' rename table verbatim.
const RENAMES: readonly [string, string][] = [
	["requestTimeout", "chat.timeout"],
	["promptCaching.enabled", "chat.promptCaching"],
	["discoveryTimeout", "discovery.timeout"],
	["discoveryCacheTtl", "discovery.cacheTtl"],
	["modelParameters", "models.parameters"],
	["modelCapabilities", "models.capabilities"],
	["openRouterCatalog.enabled", "models.openRouterCatalog"],
	["maskApiKeyInput", "ui.maskSecretInputs"],
];
const TRIO = ["defaultContextLength", "defaultMaxInputTokens", "defaultMaxOutputTokens"];

function globalValueOf(snapshot: SettingsSnapshot, id: string): unknown {
	return snapshot[id]?.globalValue;
}

/** Plan against `before`, apply the plan, and return both for assertions. */
function migrate(before: SettingsSnapshot): {
	plan: ReturnType<typeof planSettingsRedesign>;
	after: SettingsSnapshot;
} {
	const plan = planSettingsRedesign(before);
	return { plan, after: applyPlanToSnapshot(before, plan.writes) };
}

/** Every plan must order value writes before deletions and never repeat a section per phase. */
function assertPlanShape(plan: ReturnType<typeof planSettingsRedesign>): void {
	let sawDeletion = false;
	for (const write of plan.writes) {
		if (write.value === undefined) {
			sawDeletion = true;
		} else {
			assert.strictEqual(sawDeletion, false, "value writes must precede every deletion");
		}
	}
	const sections = plan.writes.map((write) => `${write.value === undefined ? "delete" : "set"}:${write.section}`);
	assert.deepStrictEqual([...new Set(sections)], sections, "a section may be set or deleted at most once");
}

suite("extension/migrations/settingsRedesign: scalar renames", () => {
	test("every renamed scalar moves verbatim and its old key is deleted", () => {
		const before: SettingsSnapshot = {
			requestTimeout: { globalValue: 45000 },
			"promptCaching.enabled": { globalValue: false },
			discoveryTimeout: { globalValue: 15000 },
			discoveryCacheTtl: { globalValue: 0 },
			"openRouterCatalog.enabled": { globalValue: false },
			maskApiKeyInput: { globalValue: false },
		};
		const { plan, after } = migrate(before);

		assert.strictEqual(plan.outcome, "migrated");
		assertPlanShape(plan);
		assert.deepStrictEqual(after, {
			"chat.timeout": { globalValue: 45000 },
			"chat.promptCaching": { globalValue: false },
			"discovery.timeout": { globalValue: 15000 },
			"discovery.cacheTtl": { globalValue: 0 },
			"models.openRouterCatalog": { globalValue: false },
			"ui.maskSecretInputs": { globalValue: false },
		});
		assert.ok(
			plan.logLines.some((line) => line.includes("Renamed 6 setting(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("values move verbatim without validation - clamping stays the reader's job", () => {
		const { after } = migrate({ requestTimeout: { globalValue: -5 } });
		assert.strictEqual(globalValueOf(after, "chat.timeout"), -5);
	});

	test("sync race: a new name already holding a value keeps it and the old key just drops", () => {
		const before: SettingsSnapshot = {
			requestTimeout: { globalValue: 45000 },
			"chat.timeout": { globalValue: 60000 },
		};
		const { plan, after } = migrate(before);

		assert.deepStrictEqual(plan.writes, [{ section: "requestTimeout", value: undefined }]);
		assert.strictEqual(globalValueOf(after, "chat.timeout"), 60000, "never overwrite newer intent");
		assert.ok(
			plan.logLines.some((line) => line.includes("Dropped 1 old setting key(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("workspace-layer old values are counted once, never rewritten", () => {
		const before: SettingsSnapshot = {
			requestTimeout: { workspaceValue: 1 },
			modelParameters: { workspaceFolderValue: { "gpt-5": {} } },
			headers: { workspaceValue: { "x-env": "prod" } },
		};
		const { plan, after } = migrate(before);

		assert.strictEqual(plan.outcome, "nothing-to-do");
		assert.deepStrictEqual(plan.writes, []);
		assert.deepStrictEqual(after, before, "workspace layers must never be touched");
		const line = plan.logLines.find((l) => l.includes("workspace-layer"));
		assert.ok(line?.includes("3 workspace-layer"), plan.logLines.join(" | "));
	});

	test("an untouched install is a silent no-op", () => {
		const plan = planSettingsRedesign({});
		assert.strictEqual(plan.outcome, "nothing-to-do");
		assert.deepStrictEqual(plan.writes, []);
		assert.deepStrictEqual(plan.logLines, []);
	});
});

suite("extension/migrations/settingsRedesign: record renames", () => {
	test("record keys become explicit matchers; the catch-all aliases collapse to '*'", () => {
		const before: SettingsSnapshot = {
			modelParameters: {
				globalValue: {
					"": { temperature: 1 },
					"gpt-5": { top_p: 0.9, _force: ["top_p"] },
					"gpt-5*": { seed: 1 },
				},
			},
		};
		const { after } = migrate(before);

		assert.deepStrictEqual(globalValueOf(after, "models.parameters"), {
			"*": { temperature: 1 },
			"gpt-5*": { top_p: 0.9, _force: ["top_p"] },
			// A key with a literal star migrates to an escaped anchored-prefix regex:
			// star-appending would mint an invalid matcher and verbatim would
			// activate glob semantics over a superset.
			"/gpt-5\\*.*/": { seed: 1 },
		});
		assert.strictEqual(globalValueOf(after, "modelParameters"), undefined);
	});

	test("a star-bearing key's regex form preserves the old literal-prefix match set", () => {
		const { after } = migrate({
			modelParameters: { globalValue: { "gpt*": { temperature: 0.4 } } },
		});
		const record = globalValueOf(after, "models.parameters") as Record<string, Record<string, unknown>>;
		const key = expectDefined(Object.keys(record)[0]);
		assert.strictEqual(key, "/gpt\\*.*/");
		const parse = parseMatcherKey(key);
		assert.ok(parse.ok, "the migrated key must be a valid matcher");
		assert.ok(matcherMatches(parse.matcher, "gpt*"), "the exact old literal still matches");
		assert.ok(matcherMatches(parse.matcher, "gpt*-turbo"), "old literal-prefix extensions still match");
		assert.ok(!matcherMatches(parse.matcher, "gpt-4"), "glob semantics must NOT activate: gpt-4 never matched");
	});

	test("a migrated _force covering max_tokens is minimally rewritten to its old coverage", () => {
		const { after, plan } = migrate({
			modelParameters: {
				globalValue: {
					// _force: true on a record that sets max_tokens expands to the
					// old-forceable literal list (max_tokens was unforceable).
					"gpt-5": { max_tokens: 100, temperature: 0.2, _force: true },
					// An explicit list drops the max_tokens name the old parser
					// diagnosed and ignored.
					"claude-4": { max_tokens: 50, top_p: 0.9, _force: ["max_tokens", "top_p"] },
					// A record not touching max_tokens rides VERBATIM.
					deepseek: { temperature: 0.1, _force: true },
				},
			},
		});
		assert.deepStrictEqual(globalValueOf(after, "models.parameters"), {
			"gpt-5*": { max_tokens: 100, temperature: 0.2, _force: ["temperature"] },
			"claude-4*": { max_tokens: 50, top_p: 0.9, _force: ["top_p"] },
			"deepseek*": { temperature: 0.1, _force: true },
		});
		assert.ok(
			plan.logLines.some((line) => line.includes("Rewrote 2 migrated _force directive(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("'' and '*' side by side collapse to the '*' record, matching the old tie rule", () => {
		const { plan, after } = migrate({
			modelParameters: { globalValue: { "": { temperature: 0 }, "*": { temperature: 1 } } },
		});
		assert.deepStrictEqual(globalValueOf(after, "models.parameters"), { "*": { temperature: 1 } });
		assert.ok(
			plan.logLines.some((line) => line.includes("Dropped 1 duplicate catch-all record key(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("sync race on a record keeps the synced new value and only drops the old key", () => {
		const before: SettingsSnapshot = {
			modelParameters: { globalValue: { "gpt-5": { temperature: 0 } } },
			"models.parameters": { globalValue: { "gpt-5*": { temperature: 1 } } },
		};
		const { plan, after } = migrate(before);
		assert.deepStrictEqual(plan.writes, [{ section: "modelParameters", value: undefined }]);
		assert.deepStrictEqual(globalValueOf(after, "models.parameters"), { "gpt-5*": { temperature: 1 } });
	});

	test("a non-record value rides verbatim to the new name; the user's text survives", () => {
		const { after } = migrate({ modelParameters: { globalValue: "junk" } });
		assert.strictEqual(globalValueOf(after, "models.parameters"), "junk");
		assert.strictEqual(globalValueOf(after, "modelParameters"), undefined);
	});

	test("server-scoped keys move into every declared entry at that base URL, as explicit matchers", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{ label: "a", baseUrl: "https://gw" },
					{ label: "b", baseUrl: "https://gw/" },
					{ label: "c", baseUrl: "https://elsewhere.example.com" },
				],
			},
			modelParameters: {
				globalValue: {
					"https://gw/gpt-5": { temperature: 0.2 },
					"https://gw/": { top_p: 0.9 },
				},
			},
		};
		const { plan, after } = migrate(before);

		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		const expectedRecord = { "gpt-5*": { temperature: 0.2 }, "*": { top_p: 0.9 } };
		assert.deepStrictEqual(servers[0]?.models, { parameters: expectedRecord }, "trailing-slash URLs are one server");
		assert.deepStrictEqual(servers[1]?.models, { parameters: expectedRecord });
		assert.strictEqual(servers[2]?.models, undefined);
		assert.deepStrictEqual(globalValueOf(after, "models.parameters"), {});
		assert.ok(
			plan.logLines.some((line) => line.includes("Moved 2 server-scoped record key(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("nested base URLs: each matching entry receives its own remainder", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{ label: "root", baseUrl: "https://gw" },
					{ label: "v1", baseUrl: "https://gw/v1" },
				],
			},
			modelParameters: { globalValue: { "https://gw/v1/gpt": { seed: 7 } } },
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, { parameters: { "v1/gpt*": { seed: 7 } } });
		assert.deepStrictEqual(servers[1]?.models, { parameters: { "gpt*": { seed: 7 } } });
	});

	test("existing entry record keys win over moved scoped keys, so reruns never overwrite", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{
						label: "a",
						baseUrl: "https://gw",
						modelParameters: { "gpt-5": { temperature: 1 } },
					},
				],
			},
			modelParameters: { globalValue: { "https://gw/gpt-5": { temperature: 0 } } },
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, { parameters: { "gpt-5*": { temperature: 1 } } });
	});

	test("a scoped key matching no declared entry stays verbatim and is counted as inert", () => {
		const before: SettingsSnapshot = {
			servers: { globalValue: [{ label: "a", baseUrl: "https://gw" }] },
			modelCapabilities: { globalValue: { "https://unknown.example.com/x": { supports_vision: true } } },
		};
		const { plan, after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"https://unknown.example.com/x": { supports_vision: true },
		});
		const line = plan.logLines.find((l) => l.includes("Left 1 server-scoped record key(s)"));
		assert.ok(line !== undefined, plan.logLines.join(" | "));
		assertOmits(line, "unknown.example.com", "keys are user text and must stay out of the log");
	});

	test("a bare '<baseUrl>' key without a remainder separator never scope-matched and stays inert", () => {
		const before: SettingsSnapshot = {
			servers: { globalValue: [{ label: "a", baseUrl: "https://gw" }] },
			modelParameters: { globalValue: { "https://gw": { temperature: 1 } } },
		};
		const { after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.parameters"), { "https://gw": { temperature: 1 } });
	});

	test("reserved record keys stay verbatim: starring would activate what the old readers dropped", () => {
		// JSON.parse produces an OWN "__proto__" data property, exactly like a user's
		// settings.json would; an object literal would set the prototype instead.
		const rawGlobal = JSON.parse('{"constructor": {"temperature": 1}, "__proto__": {"seed": 1}, "gpt": {"top_p": 1}}');
		const { after } = migrate({ modelParameters: { globalValue: rawGlobal } });
		const migrated = globalValueOf(after, "models.parameters") as Record<string, unknown>;
		assert.deepStrictEqual(Object.keys(migrated).sort(), ["__proto__", "constructor", "gpt*"].sort());
		assert.deepStrictEqual(migrated.constructor, { temperature: 1 });
		assert.deepStrictEqual(Object.getOwnPropertyDescriptor(migrated, "__proto__")?.value, { seed: 1 });
	});

	test("a moved scoped key colliding with the entry's SAME key merges field by field, entry winning", () => {
		// Identical keys match identical models and the old runtime merged the entry
		// record over the scoped one field by field, so the merge is lossless: entry
		// fields keep their values and the scoped `_force` follows its survivors.
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{
						label: "a",
						baseUrl: "https://gw",
						modelParameters: { "gpt-5": { temperature: 1, _force: ["temperature"] } },
					},
				],
			},
			modelParameters: {
				globalValue: { "https://gw/gpt-5": { temperature: 0, seed: 7, _force: true } },
			},
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, {
			parameters: {
				"gpt-5*": { temperature: 1, _force: ["temperature", "seed"], seed: 7 },
			},
		});
		assert.deepStrictEqual(globalValueOf(after, "models.parameters"), {});
	});

	test("an entry-side _force: true expands before scoped-only fields widen what it covers", () => {
		// The entry's `true` marked the ENTRY's fields; leaving it as written
		// would newly force the arriving scoped field, which was unforced.
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [{ label: "a", baseUrl: "https://gw", modelParameters: { m: { temperature: 1, _force: true } } }],
			},
			modelParameters: { globalValue: { "https://gw/m": { seed: 7 } } },
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, {
			parameters: { "m*": { temperature: 1, _force: ["temperature"], seed: 7 } },
		});
	});

	test("a scoped mark follows its surviving field through an entry-side true expansion", () => {
		// The entry's `true` expands to the ENTRY's own fields; the arriving scoped
		// field keeps its old-world level, so it must not surface as an override.
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{ label: "a", baseUrl: "https://gw", modelCapabilities: { m: { context_length: 1000, _fallback: true } } },
				],
			},
			modelCapabilities: { globalValue: { "https://gw/m": { supports_vision: false, _fallback: true } } },
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, {
			capabilities: {
				"m*": { context_length: 1000, _fallback: ["context_length", "supports_vision"], supports_vision: false },
			},
		});
	});

	test("an entry-side _force: true stays as written when the merge adds no field", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [{ label: "a", baseUrl: "https://gw", modelParameters: { m: { temperature: 1, _force: true } } }],
			},
			modelParameters: { globalValue: { "https://gw/m": { temperature: 0 } } },
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, {
			parameters: { "m*": { temperature: 1, _force: true } },
		});
	});

	test("an inert entry-side directive name drops when the scoped record supplies its field", () => {
		// "_force": ["seed"] on a record without `seed` marked nothing; the
		// arriving scoped `seed` must not activate it.
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{
						label: "a",
						baseUrl: "https://gw",
						modelParameters: { m: { temperature: 1, _force: ["seed", "temperature"] } },
					},
				],
			},
			modelParameters: { globalValue: { "https://gw/m": { seed: 7 } } },
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, {
			parameters: { "m*": { temperature: 1, _force: ["temperature"], seed: 7 } },
		});
	});

	test("expanding a scoped _force: true marks only the names the old rules could force", () => {
		// The old `_force: true` refused provider-owned and underscore keys; expanding
		// it into a list must not name them, or the migration would mint diagnostics
		// the old world never produced.
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [{ label: "a", baseUrl: "https://gw", modelParameters: { m: { top_p: 0.5 } } }],
			},
			modelParameters: {
				globalValue: { "https://gw/m": { stream: true, max_tokens: 10, _hint: 1, seed: 7, _force: true } },
			},
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, {
			parameters: { "m*": { top_p: 0.5, _force: ["seed"], stream: true, max_tokens: 10, _hint: 1, seed: 7 } },
		});
	});

	test("expanding a scoped _fallback: true marks only validly-typed capability fields", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [{ label: "a", baseUrl: "https://gw", modelCapabilities: { m: { supports_vision: true } } }],
			},
			modelCapabilities: {
				globalValue: { "https://gw/m": { context_length: 1000, max_output_tokens: 0, bogus: 5, _fallback: true } },
			},
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, {
			capabilities: {
				"m*": {
					supports_vision: true,
					_fallback: ["context_length"],
					context_length: 1000,
					max_output_tokens: 0,
					bogus: 5,
				},
			},
		});
	});

	test("a junk entry value at a colliding key loses to the scoped record the old readers used", () => {
		// The old normalization dropped a non-record sub-entry, so the scoped
		// global key was what applied; the incoming record replaces it.
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [{ label: "a", baseUrl: "https://gw", modelParameters: { m: "junk" } }],
			},
			modelParameters: { globalValue: { "https://gw/m": { seed: 7 } } },
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, { parameters: { "m*": { seed: 7 } } });
	});
});

suite("extension/migrations/settingsRedesign: _declare directives", () => {
	test("a declared ID moves TRIMMED, matching the parser's read of the list", () => {
		const { after } = migrate({
			servers: {
				globalValue: [{ label: "a", baseUrl: "https://gw", modelCapabilities: { " r1 ": { _declare: true } } }],
			},
		});
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		const discovery = expectDefined(servers[0]).discovery as Record<string, unknown>;
		assert.deepStrictEqual(discovery.declared, ["r1"]);
	});

	test("an entry record's _declare moves into discovery.declared and the record describes the model", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{
						label: "a",
						baseUrl: "https://gw",
						modelCapabilities: { "deepseek-r1": { _declare: true, context_length: 131072 } },
					},
				],
			},
		};
		const { plan, after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, { capabilities: { "deepseek-r1*": { context_length: 131072 } } });
		assert.deepStrictEqual(servers[0]?.discovery, { declared: ["deepseek-r1"] });
		assert.ok(
			plan.logLines.some((line) => line.includes("Moved 1 _declare directive(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("a scoped global _declare declares into the matching entry", () => {
		const before: SettingsSnapshot = {
			servers: { globalValue: [{ label: "a", baseUrl: "https://gw" }] },
			modelCapabilities: {
				globalValue: { "https://gw/deepseek-r1": { _declare: true, supports_reasoning: true } },
			},
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.discovery, { declared: ["deepseek-r1"] });
		assert.deepStrictEqual(servers[0]?.models, { capabilities: { "deepseek-r1*": { supports_reasoning: true } } });
	});

	test("inert _declare carriers strip without declaring: unscoped keys, catch-alls, false, junk values", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{
						label: "a",
						baseUrl: "https://gw",
						modelCapabilities: {
							"*": { _declare: true, supports_vision: true },
							m1: { _declare: false },
							m2: { _declare: "yes" },
						},
					},
				],
			},
			modelCapabilities: { globalValue: { unscoped: { _declare: true, context_length: 1000 } } },
		};
		const { plan, after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.models, {
			capabilities: { "*": { supports_vision: true }, "m1*": {}, "m2*": {} },
		});
		assert.strictEqual(servers[0]?.discovery, undefined, "nothing declared");
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), { "unscoped*": { context_length: 1000 } });
		assert.ok(
			plan.logLines.some((line) => line.includes("Removed 4 inert _declare directive(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("declared IDs merge into an existing declared list, existing entries first, deduped", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: [
					{
						label: "a",
						baseUrl: "https://gw",
						discovery: { declared: ["kept-first", "deepseek-r1"] },
						modelCapabilities: { "deepseek-r1": { _declare: true }, qwen: { _declare: true } },
					},
				],
			},
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.discovery, { declared: ["kept-first", "deepseek-r1", "qwen"] });
	});
});

suite("extension/migrations/settingsRedesign: entry restructure", () => {
	function migrateEntry(entry: Record<string, unknown>): Record<string, unknown> {
		const { after } = migrate({ servers: { globalValue: [entry] } });
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		return expectDefined(servers[0]);
	}

	test("a header-less virtualKey value drops instead of misconfiguring the entry (ruling)", () => {
		// The parser refuses a headerless virtualKey, so carrying the value half would
		// kill the entry's service; it drops, and the stored blob survives.
		const entry = migrateEntry({ label: "a", baseUrl: "https://gw", apiKey: "sk-x", virtualKeyValue: "vk-orphan" });
		assert.deepStrictEqual(entry, { label: "a", baseUrl: "https://gw", auth: { apiKey: "sk-x" } });
		const lone = migrateEntry({ label: "b", baseUrl: "https://gw", virtualKeyValue: "vk-orphan" });
		assert.deepStrictEqual(lone, { label: "b", baseUrl: "https://gw" });
	});

	test("apiKey alone becomes the apiKey form", () => {
		const entry = migrateEntry({ label: "a", baseUrl: "https://gw", apiKey: "sk-x" });
		assert.deepStrictEqual(entry, { label: "a", baseUrl: "https://gw", auth: { apiKey: "sk-x" } });
	});

	test("a full oauth entry becomes the oauth form with its companions", () => {
		const entry = migrateEntry({
			label: "a",
			baseUrl: "https://gw",
			apiKey: "sk-x",
			oauthTokenUrl: "https://idp/token",
			oauthClientId: "cid",
			oauthClientSecret: "cs",
			oauthScopes: "read write",
			virtualKeyHeader: "x-litellm-api-key",
			virtualKeyValue: "vk",
		});
		assert.deepStrictEqual(entry.auth, {
			oauth: {
				tokenUrl: "https://idp/token",
				clientId: "cid",
				clientSecret: "cs",
				scopes: "read write",
				apiKey: "sk-x",
				virtualKey: { header: "x-litellm-api-key", value: "vk" },
			},
		});
	});

	test("apiKey beside virtualKey without oauth becomes the apiKey form with the virtualKey companion", () => {
		// The settled primacy ruling: the old transport sent BOTH credentials, and the
		// apiKey form's virtualKey companion is that exact header set.
		const entry = migrateEntry({
			label: "a",
			baseUrl: "https://gw",
			apiKey: "sk-x",
			virtualKeyHeader: "x-litellm-api-key",
			virtualKeyValue: "vk",
		});
		assert.deepStrictEqual(entry.auth, {
			apiKey: "sk-x",
			virtualKey: { header: "x-litellm-api-key", value: "vk" },
		});
	});

	test("virtualKey alone becomes the virtualKey form; a lone header keeps riding", () => {
		assert.deepStrictEqual(
			migrateEntry({ label: "a", baseUrl: "https://gw", virtualKeyHeader: "x-key" }).auth,
			{ virtualKey: { header: "x-key" } },
			"a header waiting for its stored secret stays declared"
		);
	});

	test("lone oauth pieces drain: partial oauth never made a form and would misconfigure the entry", () => {
		// Old runtime: hasOAuth required BOTH tokenUrl and clientId, so a lone piece
		// was ignored. Carrying it into auth.oauth would refuse the whole entry as
		// structurally incomplete, so the never-honored piece drains.
		const { plan, after } = migrate({
			servers: { globalValue: [{ label: "a", baseUrl: "https://gw", oauthClientId: "cid", apiKey: "sk-x" }] },
		});
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0], {
			label: "a",
			baseUrl: "https://gw",
			auth: { apiKey: "sk-x" },
		});
		assert.ok(
			plan.logLines.some((line) => line.includes("Dropped 1 legacy entry field value(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("oauth with tokenUrl and clientId is a form even while its secret is stored elsewhere", () => {
		const entry = migrateEntry({
			label: "a",
			baseUrl: "https://gw",
			oauthTokenUrl: "https://idp/token",
			oauthClientId: "cid",
		});
		assert.deepStrictEqual(entry.auth, { oauth: { tokenUrl: "https://idp/token", clientId: "cid" } });
	});

	test("stored-only secrets never synthesize fields: no flat fields means no auth object at all", () => {
		// An entry whose apiKey lives only in SecretStorage carried no flat field, so
		// the restructure writes nothing and the stored value keeps working.
		const before: SettingsSnapshot = { servers: { globalValue: [{ label: "a", baseUrl: "https://gw" }] } };
		const plan = planSettingsRedesign(before);
		assert.deepStrictEqual(plan.writes, [], "an entry without legacy fields needs no restructure");
	});

	test("unusable flat values (junk types, blank strings, lone oauth pieces) drain and are counted", () => {
		const { plan, after } = migrate({
			servers: {
				globalValue: [{ label: "a", baseUrl: "https://gw", apiKey: 42, virtualKeyHeader: "  ", oauthScopes: "read" }],
			},
		});
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0], { label: "a", baseUrl: "https://gw" });
		assert.ok(
			plan.logLines.some((line) => line.includes("Dropped 3 legacy entry field value(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("flat values are trimmed the way the old parser read them", () => {
		const entry = migrateEntry({ label: "a", baseUrl: "https://gw", apiKey: "  sk-x  " });
		assert.deepStrictEqual(entry.auth, { apiKey: "sk-x" });
	});

	test("expectedFailures moves under discovery verbatim", () => {
		const entry = migrateEntry({
			label: "a",
			baseUrl: "https://gw",
			expectedFailures: ["modelListing", "bogus"],
		});
		assert.deepStrictEqual(entry.discovery, { expectedFailures: ["modelListing", "bogus"] });
	});

	test("unknown entry keys are preserved verbatim; non-record entries ride untouched", () => {
		const before: SettingsSnapshot = {
			servers: {
				globalValue: ["junk", { label: "a", baseUrl: "https://gw", apiKey: "sk-x", budget: 50, note: "keep" }],
			},
		};
		const { after } = migrate(before);
		const servers = globalValueOf(after, "servers") as unknown[];
		assert.strictEqual(servers[0], "junk");
		assert.deepStrictEqual(servers[1], {
			label: "a",
			baseUrl: "https://gw",
			budget: 50,
			note: "keep",
			auth: { apiKey: "sk-x" },
		});
	});

	test("a hand-mixed entry keeps its nested values and still drains the flat leftovers", () => {
		const { plan, after } = migrate({
			servers: {
				globalValue: [
					{
						label: "a",
						baseUrl: "https://gw",
						apiKey: "sk-old",
						auth: { apiKey: "sk-new" },
						modelParameters: { "gpt-5": { temperature: 0 } },
						models: { parameters: { "gpt-5*": { temperature: 1 } } },
					},
				],
			},
		});
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		const entry = expectDefined(servers[0]);
		assert.deepStrictEqual(entry.auth, { apiKey: "sk-new" }, "the nested side is the newer intent");
		assert.deepStrictEqual(entry.models, { parameters: { "gpt-5*": { temperature: 1 } } });
		assert.strictEqual(Object.hasOwn(entry, "apiKey"), false);
		assert.strictEqual(Object.hasOwn(entry, "modelParameters"), false);
		assert.ok(
			plan.logLines.some((line) => line.includes("Dropped 1 legacy entry field value(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("a hand-mixed entry's existing auth wins WHOLESALE - flat pieces never fabricate a second form", () => {
		// Merging a flat apiKey into an existing oauth object would produce a two-form
		// auth (entry refused) or a companion the user never configured.
		const entry = migrateEntry({
			label: "a",
			baseUrl: "https://gw",
			apiKey: "sk-old",
			auth: { oauth: { tokenUrl: "https://idp/token", clientId: "cid" } },
		});
		assert.deepStrictEqual(entry.auth, { oauth: { tokenUrl: "https://idp/token", clientId: "cid" } });
	});

	test("secret values never appear in the log lines", () => {
		const { plan } = migrate({
			servers: {
				globalValue: [
					{ label: "a", baseUrl: "https://gw", apiKey: "sk-secret-value", virtualKeyValue: "vk-secret-value" },
				],
			},
		});
		for (const line of plan.logLines) {
			assert.ok(!line.includes("sk-secret-value") && !line.includes("vk-secret-value"), line);
		}
	});
});

suite(
	"extension/migrations/settingsRedesign: restructure output parses and keeps the wire (the parser round trip)",
	() => {
		// The only place the transform's OUTPUT meets the live parser: for every legacy
		// auth combo the restructured entry must be accepted by parseServersSetting with
		// group args matching the flat original byte for byte, minus the ruled drops.
		const roundTrip = (flat: Record<string, unknown>) => {
			const restructured = restructureServers([flat]);
			const raw = restructured.value as unknown[];
			const { entries, problems } = parseServersSetting(raw);
			assert.deepStrictEqual(problems, [], `restructured shape must parse: ${JSON.stringify(raw)}`);
			const parsed = entries[0];
			assert.ok(parsed, "the restructured entry must be accepted");
			const flatParsed: DeclaredServer = { ...(flat as unknown as DeclaredServer) };
			return { flatArgs: buildGroupArgs(flatParsed, {}), migratedArgs: buildGroupArgs(parsed, {}) };
		};

		test("every well-formed legacy auth combo round-trips with byte-identical group args", () => {
			const combos: Record<string, unknown>[] = [
				{ label: "a", baseUrl: "https://gw" },
				{ label: "a", baseUrl: "https://gw", apiKey: "sk-1" },
				{ label: "a", baseUrl: "https://gw", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-1" },
				{ label: "a", baseUrl: "https://gw", virtualKeyHeader: "x-vk" },
				{ label: "a", baseUrl: "https://gw", apiKey: "sk-1", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-1" },
				{ label: "a", baseUrl: "https://gw", oauthTokenUrl: "https://idp/token", oauthClientId: "cid" },
				{
					label: "a",
					baseUrl: "https://gw",
					oauthTokenUrl: "https://idp/token",
					oauthClientId: "cid",
					oauthClientSecret: "cs",
					oauthScopes: "read write",
					apiKey: "sk-1",
					virtualKeyHeader: "x-vk",
					virtualKeyValue: "vk-1",
				},
			];
			for (const flat of combos) {
				const { flatArgs, migratedArgs } = roundTrip(flat);
				assert.deepStrictEqual(migratedArgs, flatArgs, JSON.stringify(flat));
				assert.deepStrictEqual(Object.keys(migratedArgs), Object.keys(flatArgs), "key order is part of the rendering");
			}
		});

		test("the ruled exceptions still parse and keep every wire-relevant credential", () => {
			const exceptions: { flat: Record<string, unknown>; droppedArgs: string[] }[] = [
				{
					flat: { label: "a", baseUrl: "https://gw", apiKey: "sk-1", oauthClientId: "cid" },
					droppedArgs: ["oauthClientId"],
				},
				{
					flat: { label: "a", baseUrl: "https://gw", apiKey: "sk-1", virtualKeyValue: "vk-1" },
					droppedArgs: ["virtualKeyValue"],
				},
				{
					flat: {
						label: "a",
						baseUrl: "https://gw",
						apiKey: "sk-1",
						virtualKeyHeader: "X Key",
						virtualKeyValue: "vk-1",
					},
					droppedArgs: ["virtualKeyHeader", "virtualKeyValue"],
				},
			];
			for (const { flat, droppedArgs } of exceptions) {
				const { flatArgs, migratedArgs } = roundTrip(flat);
				for (const key of droppedArgs) {
					assert.ok(key in flatArgs, `${key} was in the old args`);
					assert.ok(!(key in migratedArgs), `${key} drops (the old runtime never sent it)`);
				}
				const expected = Object.fromEntries(Object.entries(flatArgs).filter(([key]) => !droppedArgs.includes(key)));
				assert.deepStrictEqual(migratedArgs, expected, JSON.stringify(flat));
			}
		});
	}
);

suite("extension/migrations/settingsRedesign: global headers", () => {
	test("the global headers copy into every accepted entry and the old key is deleted", () => {
		const before: SettingsSnapshot = {
			headers: { globalValue: { "x-env": "prod", "X-Trace": "vscode" } },
			servers: {
				globalValue: [
					{ label: "a", baseUrl: "https://gw" },
					{ label: "b", baseUrl: "https://other.example.com", headers: { "X-ENV": "dev" } },
				],
			},
		};
		const { plan, after } = migrate(before);
		const servers = globalValueOf(after, "servers") as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.headers, { "x-env": "prod", "X-Trace": "vscode" });
		assert.deepStrictEqual(
			servers[1]?.headers,
			{ "X-ENV": "dev", "X-Trace": "vscode" },
			"existing entry names win case-insensitively"
		);
		assert.strictEqual(globalValueOf(after, "headers"), undefined);
		assert.strictEqual(
			plan.writes.filter((write) => write.section === "headers").length,
			1,
			"exactly one headers write: the deletion"
		);
		assert.ok(
			plan.logLines.some((line) => line.includes("Copied the global headers setting into 2 server entries")),
			plan.logLines.join(" | ")
		);
	});

	test("with no entry to receive it, the global headers value stays inert with a hint", () => {
		const before: SettingsSnapshot = { headers: { globalValue: { "x-env": "prod" } } };
		const { plan, after } = migrate(before);

		assert.strictEqual(plan.outcome, "nothing-to-do");
		assert.deepStrictEqual(after, before);
		assert.ok(
			plan.logLines.some((line) => line.includes("Left the global headers setting in place")),
			plan.logLines.join(" | ")
		);
		assert.deepStrictEqual(
			collectLegacyHints({
				globalHeadersValue: globalValueOf(after, "headers"),
				modelParametersValue: undefined,
				modelCapabilitiesValue: undefined,
			}),
			[{ kind: "inert-global-headers", oldKey: "headers", detail: "headers" }]
		);
	});

	test("a value that carried no headers drains outright, so no permanent hint appears", () => {
		for (const globalValue of [{}, "junk", 42, null, []]) {
			const { plan, after } = migrate({ headers: { globalValue } });
			assert.deepStrictEqual(plan.writes, [{ section: "headers", value: undefined }]);
			assert.strictEqual(globalValueOf(after, "headers"), undefined);
		}
	});
});

suite("extension/migrations/settingsRedesign: default token trio", () => {
	test("all three values move into a fresh models.capabilities '*' record, _inheritable: true per the docs", () => {
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			defaultMaxInputTokens: { globalValue: 150000 },
			defaultMaxOutputTokens: { globalValue: 32000 },
		};
		const { plan, after } = migrate(before);

		assert.strictEqual(plan.outcome, "migrated");
		assertPlanShape(plan);
		assert.deepStrictEqual(after, {
			"models.capabilities": {
				globalValue: {
					"*": {
						context_length: 200000,
						max_input_tokens: 150000,
						max_output_tokens: 32000,
						_fallback: ["context_length", "max_output_tokens"],
						_inheritable: true,
					},
				},
			},
		});
		assert.ok(
			plan.logLines.some((line) => line.includes("Moved 3 default token setting value(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("merging into a user's existing '*' record marks only the migrated fields inheritable", () => {
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			defaultMaxOutputTokens: { globalValue: 32000 },
			modelCapabilities: { globalValue: { "*": { supports_vision: true }, "gpt-4": { context_length: 8192 } } },
		};
		const { after } = migrate(before);

		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": {
				supports_vision: true,
				context_length: 200000,
				max_output_tokens: 32000,
				_fallback: ["context_length", "max_output_tokens"],
				_inheritable: ["context_length", "max_output_tokens"],
			},
			"gpt-4*": { context_length: 8192 },
		});
	});

	test("a field the user already set keeps its value and is never demoted or marked", () => {
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			defaultMaxInputTokens: { globalValue: 150000 },
			defaultMaxOutputTokens: { globalValue: 32000 },
			modelCapabilities: { globalValue: { "*": { context_length: 999999, max_input_tokens: 111 } } },
		};
		const { plan, after } = migrate(before);

		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": {
				context_length: 999999,
				max_input_tokens: 111,
				max_output_tokens: 32000,
				_fallback: ["max_output_tokens"],
				_inheritable: ["max_output_tokens"],
			},
		});
		for (const id of TRIO) {
			assert.strictEqual(globalValueOf(after, id), undefined, `${id} must be consumed`);
		}
		assert.ok(
			plan.logLines.some((line) => line.includes("Moved 1 default token setting value(s)")),
			plan.logLines.join(" | ")
		);
		assert.ok(
			plan.logLines.some((line) => line.includes("Removed 2 default token setting key(s)")),
			`the already-covered sources are reported too: ${plan.logLines.join(" | ")}`
		);
	});

	test("every field user-set means a drain-only pass", () => {
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			defaultMaxInputTokens: { globalValue: 150000 },
			defaultMaxOutputTokens: { globalValue: 32000 },
			modelCapabilities: {
				globalValue: { "*": { context_length: 1, max_input_tokens: 2, max_output_tokens: 3 } },
			},
		};
		const { plan, after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": { context_length: 1, max_input_tokens: 2, max_output_tokens: 3 },
		});
		assert.ok(
			plan.logLines.some((line) => line.includes("Removed 3 default token setting key(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("fallback and inheritable fields merge into user-present lists without duplicates", () => {
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			defaultMaxOutputTokens: { globalValue: 32000 },
			modelCapabilities: {
				globalValue: {
					"*": { max_output_tokens: 5000, _fallback: ["max_output_tokens"], _inheritable: ["max_output_tokens"] },
				},
			},
		};
		const { after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": {
				max_output_tokens: 5000,
				_fallback: ["max_output_tokens", "context_length"],
				_inheritable: ["max_output_tokens", "context_length"],
				context_length: 200000,
			},
		});
	});

	test("the override-placed fill expands a user's _fallback: true instead of landing demoted", () => {
		// defaultMaxInputTokens BEAT the server-reported value; letting the record's
		// `_fallback: true` swallow the fill would demote it below the server. The
		// expansion to the pre-existing valid fields leaves the fill unmarked.
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			defaultMaxInputTokens: { globalValue: 150000 },
			modelCapabilities: {
				globalValue: { "*": { supports_function_calling: true, _fallback: true, _inheritable: true } },
			},
		};
		const { after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": {
				supports_function_calling: true,
				_fallback: ["supports_function_calling", "context_length"],
				_inheritable: true,
				context_length: 200000,
				max_input_tokens: 150000,
			},
		});
	});

	test("without an override-placed fill, a user's _fallback: true stays exactly as written", () => {
		// The fallback-placed fills sit at their intended level under `true`
		// already, so the user's statement survives for future fields.
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			defaultMaxOutputTokens: { globalValue: 32000 },
			modelCapabilities: {
				globalValue: { "*": { supports_function_calling: true, _fallback: true } },
			},
		};
		const { after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": {
				supports_function_calling: true,
				_fallback: true,
				context_length: 200000,
				max_output_tokens: 32000,
				_inheritable: ["context_length", "max_output_tokens"],
			},
		});
	});

	test("an inert _fallback name of the override-placed field drops instead of activating", () => {
		// "_fallback": ["max_input_tokens"] naming an unset field marked
		// nothing (diagnosed and skipped); the fill must not hand it a field
		// to demote.
		const before: SettingsSnapshot = {
			defaultMaxInputTokens: { globalValue: 150000 },
			modelCapabilities: { globalValue: { "*": { _fallback: ["max_input_tokens"] } } },
		};
		const { after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": { max_input_tokens: 150000, _inheritable: ["max_input_tokens"] },
		});
	});

	test("a _fallback or _inheritable of false reads as absent, not as garbage that blocks the move", () => {
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			modelCapabilities: { globalValue: { "*": { _fallback: false, _inheritable: false } } },
		};
		const { after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": {
				_fallback: ["context_length"],
				_inheritable: ["context_length"],
				context_length: 200000,
			},
		});
	});

	test("values the removed readers never honored are consumed without a fill", () => {
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 0 },
			defaultMaxInputTokens: { globalValue: "not a number" },
			defaultMaxOutputTokens: { globalValue: 0.5 },
		};
		const { plan, after } = migrate(before);
		assert.strictEqual(globalValueOf(after, "models.capabilities"), undefined);
		for (const id of TRIO) {
			assert.strictEqual(globalValueOf(after, id), undefined);
		}
		assert.ok(
			plan.logLines.some((line) => line.includes("Removed 3 default token setting key(s)")),
			plan.logLines.join(" | ")
		);
	});

	test("an unmergeable '*' record blocks the trio move and keeps the sources, while the rename proceeds", () => {
		for (const catchAll of ["not a record", { _fallback: "garbage" }, { _inheritable: "garbage" }]) {
			const before: SettingsSnapshot = {
				defaultContextLength: { globalValue: 200000 },
				modelCapabilities: { globalValue: { "*": catchAll } },
			};
			const { plan, after } = migrate(before);
			assert.strictEqual(globalValueOf(after, "defaultContextLength"), 200000, "the source must survive");
			assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), { "*": catchAll });
			assert.ok(
				plan.logLines.some((line) => line.includes("not a mergeable record")),
				plan.logLines.join(" | ")
			);
			// The blocked state is stable: the rerun retries, never loops writes.
			const rerun = planSettingsRedesign(after);
			assert.deepStrictEqual(rerun.writes, []);
		}
	});

	test("the trio merges into a race-kept models.capabilities value too", () => {
		const before: SettingsSnapshot = {
			defaultContextLength: { globalValue: 200000 },
			modelCapabilities: { globalValue: { "*": { context_length: 1 } } },
			"models.capabilities": { globalValue: {} },
		};
		const { after } = migrate(before);
		assert.deepStrictEqual(globalValueOf(after, "models.capabilities"), {
			"*": { context_length: 200000, _fallback: ["context_length"], _inheritable: true },
		});
		assert.strictEqual(globalValueOf(after, "modelCapabilities"), undefined);
	});
});

suite("extension/migrations/settingsRedesign: hints", () => {
	test("inert scoped keys and an inert global headers value produce hints; clean config produces none", () => {
		const hints = collectLegacyHints({
			globalHeadersValue: { "x-env": "prod" },
			modelParametersValue: { "https://gw/gpt-5*": {}, "gpt-5*": {} },
			modelCapabilitiesValue: { "https://other/x": {} },
		});
		const expectedKinds: LegacyHintKind[] = ["inert-url-scoped-key", "inert-url-scoped-key", "inert-global-headers"];
		assert.deepStrictEqual(
			hints.map((hint) => hint.kind),
			expectedKinds
		);
		assert.deepStrictEqual(hints, [
			{ kind: "inert-url-scoped-key", oldKey: "https://gw/gpt-5*", detail: "models.parameters" },
			{ kind: "inert-url-scoped-key", oldKey: "https://other/x", detail: "models.capabilities" },
			{ kind: "inert-global-headers", oldKey: "headers", detail: "headers" },
		]);
		assert.deepStrictEqual(
			collectLegacyHints({
				globalHeadersValue: undefined,
				modelParametersValue: { "gpt-5*": {} },
				modelCapabilitiesValue: "junk",
			}),
			[]
		);
	});
});

suite("extension/migrations/settingsRedesign: composed pipeline", () => {
	// The full old-world fixture: every pipeline step has material here.
	const OLD_WORLD: SettingsSnapshot = {
		requestTimeout: { globalValue: 45000 },
		"promptCaching.enabled": { globalValue: false },
		discoveryTimeout: { globalValue: 15000 },
		discoveryCacheTtl: { globalValue: 0 },
		"openRouterCatalog.enabled": { globalValue: false },
		maskApiKeyInput: { globalValue: false },
		headers: { globalValue: { "x-env": "prod", "X-Trace": "vscode" } },
		defaultContextLength: { globalValue: 100000 },
		defaultMaxOutputTokens: { globalValue: 8000 },
		defaultMaxInputTokens: { globalValue: 90000 },
		modelParameters: {
			globalValue: {
				"": { temperature: 1 },
				"gpt-5": { top_p: 0.9, _force: ["top_p"] },
				"https://gw/deepseek": { seed: 7 },
				"https://unknown.example.com/x": { user: "u" },
			},
		},
		modelCapabilities: {
			globalValue: {
				"gpt-5": { supports_vision: true },
				"https://gw/deepseek-r1": { supports_reasoning: true, _declare: true },
				"*": { supports_function_calling: true },
				other: { _declare: true, context_length: 4096 },
			},
		},
		servers: {
			globalValue: [
				{
					label: "prod",
					baseUrl: "https://gw/",
					apiKey: "sk-inline",
					virtualKeyHeader: "x-litellm-api-key",
					virtualKeyValue: "vk-inline",
					modelParameters: { claude: { max_thinking: 1 } },
					modelCapabilities: { "deepseek-r1": { _declare: true, context_length: 131072 } },
					expectedFailures: ["modelInfo"],
					note: "keep me",
				},
				{
					label: "idp",
					baseUrl: "https://idp.example.com",
					oauthTokenUrl: "https://idp.example.com/token",
					oauthClientId: "cid",
					oauthScopes: "read",
					apiKey: "companion-key",
				},
			],
		},
	};

	test("the complete old world becomes the complete new world in one pass", () => {
		const { plan, after } = migrate(OLD_WORLD);

		assert.strictEqual(plan.outcome, "migrated");
		assertPlanShape(plan);
		assert.deepStrictEqual(after, {
			"chat.timeout": { globalValue: 45000 },
			"chat.promptCaching": { globalValue: false },
			"discovery.timeout": { globalValue: 15000 },
			"discovery.cacheTtl": { globalValue: 0 },
			"models.openRouterCatalog": { globalValue: false },
			"ui.maskSecretInputs": { globalValue: false },
			"models.parameters": {
				globalValue: {
					"*": { temperature: 1 },
					"gpt-5*": { top_p: 0.9, _force: ["top_p"] },
					"https://unknown.example.com/x": { user: "u" },
				},
			},
			"models.capabilities": {
				globalValue: {
					"gpt-5*": { supports_vision: true },
					"*": {
						supports_function_calling: true,
						context_length: 100000,
						max_input_tokens: 90000,
						max_output_tokens: 8000,
						_fallback: ["context_length", "max_output_tokens"],
						_inheritable: ["context_length", "max_input_tokens", "max_output_tokens"],
					},
					"other*": { context_length: 4096 },
				},
			},
			servers: {
				globalValue: [
					{
						label: "prod",
						baseUrl: "https://gw/",
						note: "keep me",
						auth: {
							apiKey: "sk-inline",
							virtualKey: { header: "x-litellm-api-key", value: "vk-inline" },
						},
						models: {
							parameters: { "claude*": { max_thinking: 1 }, "deepseek*": { seed: 7 } },
							// The scoped record collides with the entry's own key and
							// merges field by field: the entry's context_length wins,
							// the scoped-only supports_reasoning fills in.
							capabilities: { "deepseek-r1*": { context_length: 131072, supports_reasoning: true } },
						},
						discovery: { expectedFailures: ["modelInfo"], declared: ["deepseek-r1"] },
						headers: { "x-env": "prod", "X-Trace": "vscode" },
					},
					{
						label: "idp",
						baseUrl: "https://idp.example.com",
						auth: {
							oauth: {
								tokenUrl: "https://idp.example.com/token",
								clientId: "cid",
								scopes: "read",
								apiKey: "companion-key",
							},
						},
						headers: { "x-env": "prod", "X-Trace": "vscode" },
					},
				],
			},
		});
	});

	test("the rerun after a full pass plans zero writes", () => {
		const { after } = migrate(OLD_WORLD);
		const rerun = planSettingsRedesign(after);
		assert.deepStrictEqual(rerun.writes, []);
		assert.strictEqual(rerun.outcome, "nothing-to-do");
	});

	test("a crash between the value writes and the deletions loses nothing", () => {
		// Apply only the value writes; the rerun finds old and new names side
		// by side and the sync-race rule completes the move without rewriting.
		const plan = planSettingsRedesign(OLD_WORLD);
		const valueWrites = plan.writes.filter((write) => write.value !== undefined);
		const crashed = applyPlanToSnapshot(OLD_WORLD, valueWrites);

		const rerun = planSettingsRedesign(crashed);
		const recovered = applyPlanToSnapshot(crashed, rerun.writes);
		assert.deepStrictEqual(recovered, applyPlanToSnapshot(OLD_WORLD, plan.writes));
		assert.ok(
			rerun.writes.every((write) => write.value === undefined),
			"the recovery pass only deletes"
		);
	});
});

suite("extension/migrations/settingsRedesign: applier", () => {
	interface SectionLayers {
		globalValue?: unknown;
		workspaceValue?: unknown;
		workspaceFolderValue?: unknown;
	}

	function makeSetting(sections: Record<string, SectionLayers>): {
		setting: RedesignSettings;
		sections: Record<string, SectionLayers>;
		updates: { section: string; value: unknown; target: vscode.ConfigurationTarget }[];
	} {
		const updates: { section: string; value: unknown; target: vscode.ConfigurationTarget }[] = [];
		const setting: RedesignSettings = {
			inspect: (section: string) => sections[section],
			update: async (section: string, value: unknown, target: vscode.ConfigurationTarget) => {
				updates.push({ section, value, target });
				const layers = sections[section] ?? {};
				sections[section] = layers;
				if (value === undefined) {
					delete layers.globalValue;
				} else {
					layers.globalValue = value;
				}
			},
		};
		return { setting, sections, updates };
	}

	function makeLogger(): { logger: Logger; lines: string[] } {
		const lines: string[] = [];
		return {
			logger: new Logger({
				info: (message: string) => lines.push(message),
				error: (message: string) => lines.push(`ERROR: ${message}`),
			}),
			lines,
		};
	}

	test("executes the plan at the Global target only and logs the count lines", async () => {
		const { setting, sections, updates } = makeSetting({
			requestTimeout: { globalValue: 45000, workspaceValue: 1 },
		});
		const { logger, lines } = makeLogger();

		const outcome = await applySettingsRedesign(setting, logger);

		assert.strictEqual(outcome, "migrated");
		for (const update of updates) {
			assert.strictEqual(update.target, vscode.ConfigurationTarget.Global, "only the user layer may be written");
		}
		assert.strictEqual(sections["chat.timeout"]?.globalValue, 45000);
		assert.strictEqual(sections.requestTimeout?.globalValue, undefined);
		assert.strictEqual(sections.requestTimeout?.workspaceValue, 1, "workspace layers stay");
		assert.ok(
			lines.some((line) => line.includes("Renamed 1 setting(s)")),
			lines.join(" | ")
		);
		assert.ok(
			lines.some((line) => line.includes("1 workspace-layer value(s)")),
			lines.join(" | ")
		);
	});

	test("a consumed global headers value writes no globalState: the entry copies are the whole move", async () => {
		const headers = { "x-env": "prod" };
		const { setting, sections } = makeSetting({
			headers: { globalValue: headers },
			servers: { globalValue: [{ label: "a", baseUrl: "https://gw", apiKey: "sk-x" }] },
		});
		const { logger } = makeLogger();

		assert.strictEqual(await applySettingsRedesign(setting, logger), "migrated");
		const servers = sections.servers?.globalValue as Record<string, unknown>[];
		assert.deepStrictEqual(servers[0]?.headers, headers, "the entry receives the copy");
		assert.strictEqual(sections.headers?.globalValue, undefined, "the settings delete still happened");

		assert.strictEqual(await applySettingsRedesign(setting, logger), "nothing-to-do");
	});

	test("readRedesignSnapshot picks up every pipeline source and target id", () => {
		const ids = [...RENAMES.flat(), ...TRIO, "headers", "servers"];
		const sections = Object.fromEntries(ids.map((id) => [id, { globalValue: `v:${id}` }]));
		const { setting } = makeSetting(sections);
		const snapshot = readRedesignSnapshot(setting);
		for (const id of ids) {
			assert.strictEqual(snapshot[id]?.globalValue, `v:${id}`, `snapshot must carry ${id}`);
		}
	});

	test("a rerun after the move is a silent no-op", async () => {
		const { setting, updates } = makeSetting({ maskApiKeyInput: { globalValue: false } });
		const { logger, lines } = makeLogger();

		assert.strictEqual(await applySettingsRedesign(setting, logger), "migrated");
		const updatesAfterFirstRun = updates.length;
		lines.length = 0;

		assert.strictEqual(await applySettingsRedesign(setting, logger), "nothing-to-do");
		assert.strictEqual(updates.length, updatesAfterFirstRun, "the second run must not write again");
		assert.deepStrictEqual(lines, [], "the drained state stays silent on every later activation");
	});
});

suite("extension/migrations/settingsRedesign: migration wiring", () => {
	// The applier's end-to-end coverage lives in activation/production.test.ts; this
	// proves run(ctx) no-ops on a profile without legacy state and writes no storage
	// doing so. Reads are legitimate; only mutations are forbidden here.
	test("the registered migration no-ops on a clean profile without writing storage", async () => {
		const storage = makeExtensionStorage();
		const writeForbidding = <T extends object>(name: string, target: T): T =>
			new Proxy(target, {
				get(inner, property, receiver) {
					if (property === "update" || property === "store" || property === "delete") {
						throw new Error(`${name} must never be written by the settings-redesign migration`);
					}
					const value = Reflect.get(inner, property, receiver);
					return typeof value === "function" ? value.bind(inner) : value;
				},
			});
		const ctx: MigrationContext = {
			globalState: writeForbidding("globalState", storage.memento),
			secrets: writeForbidding("secrets", storage.secrets),
			logger: new Logger({ info: () => {}, error: () => {} }),
			fingerprintSalt: fakeFingerprintSaltSession(),
		};
		assert.ok(MIGRATIONS.includes(settingsRedesignMigration), "the migration must be registered");
		assert.ok(
			MIGRATIONS.indexOf(settingsRedesignMigration) >
				Math.max(
					...MIGRATIONS.filter((migration) => migration.sourceRelease < settingsRedesignMigration.sourceRelease).map(
						(migration) => MIGRATIONS.indexOf(migration)
					)
				),
			"chronologically newer migrations run after older ones"
		);

		const outcome = await settingsRedesignMigration.run(ctx);
		assert.strictEqual(outcome, "nothing-to-do");
	});
});
