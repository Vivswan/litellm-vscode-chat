import * as assert from "node:assert";
import * as vscode from "vscode";
import type { MigrationContext } from "../../../extension/migrations";
import type { ModelParametersSetting } from "../../../extension/migrations/labelScopedModelParameters";
import {
	labelScopedModelParametersMigration,
	rewriteLabelScopedModelParameters,
	unionLabelSources,
} from "../../../extension/migrations/labelScopedModelParameters";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { MODEL_PARAMETERS_SETTING_KEY } from "../../../shared/config/settings";
import { Logger } from "../../../shared/logger";
import { makeExtensionStorage } from "../../testUtils";

interface Layers {
	globalValue?: Record<string, unknown>;
	workspaceValue?: Record<string, unknown>;
	workspaceFolderValue?: Record<string, unknown>;
}

interface RecordedUpdate {
	section: string;
	value: unknown;
	target: vscode.ConfigurationTarget;
}

/** Fake WorkspaceConfiguration slice: updates land on the global layer, the way ConfigurationTarget.Global does. */
function makeSetting(layers: Layers): { setting: ModelParametersSetting; layers: Layers; updates: RecordedUpdate[] } {
	const updates: RecordedUpdate[] = [];
	const setting: ModelParametersSetting = {
		inspect: (section: string) => (section === "modelParameters" ? layers : undefined),
		update: async (section: string, value: unknown, target: vscode.ConfigurationTarget) => {
			updates.push({ section, value, target });
			layers.globalValue = value as Record<string, unknown>;
		},
	};
	return { setting, layers, updates };
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

suite("extension/migrations/labelScopedModelParameters", () => {
	test("adds base-URL-scoped copies in the user layer while keeping the originals", async () => {
		const { setting, updates } = makeSetting({
			globalValue: {
				"Prod/gpt-4": { temperature: 0.2 },
				"Prod/claude": { temperature: 0.5 },
				"gpt-4": { temperature: 1 },
			},
		});
		const { logger, lines } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(setting, { "http://prod.test": ["Prod"] }, logger);

		assert.strictEqual(outcome, "migrated");
		assert.strictEqual(updates.length, 1);
		const update = updates[0];
		assert.strictEqual(update?.section, "modelParameters");
		assert.strictEqual(update.target, vscode.ConfigurationTarget.Global);
		assert.deepStrictEqual(update.value, {
			"Prod/gpt-4": { temperature: 0.2 },
			"Prod/claude": { temperature: 0.5 },
			"gpt-4": { temperature: 1 },
			"http://prod.test/gpt-4": { temperature: 0.2 },
			"http://prod.test/claude": { temperature: 0.5 },
		});
		// Logs feed the public issue-report buffer: counts only, never the keys.
		assert.ok(
			lines.some((l) => l.includes("Added 2")),
			`expected a count-only success line. Lines: ${lines.join(" | ")}`
		);
		assert.ok(
			!lines.some((l) => l.includes("Prod") || l.includes("prod.test")),
			`no user-controlled key or URL may reach the logs. Lines: ${lines.join(" | ")}`
		);
	});

	test("a copy whose base-URL key already exists is not added and nothing is written", async () => {
		const { setting, updates } = makeSetting({
			globalValue: {
				"Prod/gpt-4": { temperature: 0.2 },
				"http://prod.test/gpt-4": { temperature: 0.9 },
			},
		});
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(setting, { "http://prod.test": ["Prod"] }, logger);

		assert.strictEqual(outcome, "nothing-to-do");
		assert.deepStrictEqual(updates, [], "the existing base-URL entry wins; there is nothing to write");
	});

	test("a key that reads as a provider-prefixed model ID is copied, never moved", async () => {
		// "openai/gpt-4o" is a legitimate bare model-prefix key even when a
		// server label "openai" exists; provenance is unprovable, so the
		// original must survive with its bare-prefix meaning intact.
		const { setting, updates } = makeSetting({
			globalValue: { "openai/gpt-4o": { temperature: 0.3 } },
		});
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(setting, { "http://proxy.test": ["openai"] }, logger);

		assert.strictEqual(outcome, "migrated");
		assert.deepStrictEqual(updates[0]?.value, {
			"openai/gpt-4o": { temperature: 0.3 },
			"http://proxy.test/gpt-4o": { temperature: 0.3 },
		});
	});

	test("a label the map does not know is left untouched", async () => {
		// An ambiguous label is dropped from the map everywhere, so its keys are
		// indistinguishable from model IDs containing a slash and must not move.
		const { setting, updates } = makeSetting({
			globalValue: { "Shared/gpt-4": { temperature: 0.2 }, "openai/gpt-4": { temperature: 0.3 } },
		});
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(setting, { "http://prod.test": ["Prod"] }, logger);

		assert.strictEqual(outcome, "nothing-to-do");
		assert.deepStrictEqual(updates, [], "no update may be written when nothing matches the map");
	});

	test("workspace-layer keys are counted in a warning, never edited or named", async () => {
		const { setting, layers, updates } = makeSetting({
			workspaceValue: { "Prod/gpt-4": { temperature: 0.2 } },
			workspaceFolderValue: { "Prod/claude": { temperature: 0.5 } },
		});
		const { logger, lines } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(setting, { "http://prod.test": ["Prod"] }, logger);

		assert.strictEqual(outcome, "nothing-to-do");
		assert.deepStrictEqual(updates, [], "workspace layers must never be written");
		assert.deepStrictEqual(layers.workspaceValue, { "Prod/gpt-4": { temperature: 0.2 } });
		const warning = lines.find((l) => l.includes("workspace"));
		assert.ok(warning !== undefined, `expected a workspace warning. Lines: ${lines.join(" | ")}`);
		assert.ok(warning.includes("2 workspace-layer"), warning);
		assert.ok(warning.includes('"<baseUrl>/<model prefix>"'), warning);
		assert.ok(!warning.includes("Prod"), "setting keys must not reach the logs");
	});

	test("a rerun after the copy is a no-op", async () => {
		const { setting, updates } = makeSetting({
			globalValue: { "Prod/gpt-4": { temperature: 0.2 } },
		});
		const { logger } = makeLogger();
		const labelMap = { "http://prod.test": ["Prod"] };

		assert.strictEqual(await rewriteLabelScopedModelParameters(setting, labelMap, logger), "migrated");
		assert.strictEqual(await rewriteLabelScopedModelParameters(setting, labelMap, logger), "nothing-to-do");

		assert.strictEqual(updates.length, 1, "the second run must not write again");
	});

	test("an empty label map is a no-op that never reads the setting", async () => {
		let inspected = false;
		const setting: ModelParametersSetting = {
			inspect: () => {
				inspected = true;
				return undefined;
			},
			update: async () => {
				assert.fail("must not update");
			},
		};
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(setting, {}, logger);

		assert.strictEqual(outcome, "nothing-to-do");
		assert.strictEqual(inspected, false);
	});

	test("a key several mapped labels prefix gets a copy per label", async () => {
		// At runtime each server's requests consult only that server's own
		// pre-migration label, so both readings of this key are live (one per
		// server) and each needs its base-URL-scoped copy.
		const { setting, updates } = makeSetting({
			globalValue: { "Prod/EU/gpt-4": { temperature: 0.2 } },
		});
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(
			setting,
			{ "http://prod.test": ["Prod"], "http://eu.test": ["Prod/EU"] },
			logger
		);

		assert.strictEqual(outcome, "migrated");
		assert.deepStrictEqual(updates[0]?.value, {
			"Prod/EU/gpt-4": { temperature: 0.2 },
			"http://prod.test/EU/gpt-4": { temperature: 0.2 },
			"http://eu.test/gpt-4": { temperature: 0.2 },
		});
	});

	test("a label equal to its own base URL leaves the key untouched", async () => {
		// The "copy" would be the key itself; nothing may be dropped or written.
		const { setting, updates } = makeSetting({
			globalValue: { "https://llm.corp.com/gpt-4": { temperature: 0.2 } },
		});
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(
			setting,
			{ "https://llm.corp.com": ["https://llm.corp.com"] },
			logger
		);

		assert.strictEqual(outcome, "nothing-to-do");
		assert.deepStrictEqual(updates, [], "the self-targeting key must survive with no write at all");
	});

	test("a label that is a URL-prefix of its own base URL copies once and stays stable", async () => {
		// Without the base-URL-form guard, the copy added on the first run
		// would itself match the label again and grow a new "/v1" segment on
		// every later activation.
		const { setting, updates } = makeSetting({
			globalValue: { "https://llm.corp.com/gpt-4": { temperature: 0.2 } },
		});
		const { logger } = makeLogger();
		const labelMap = { "https://llm.corp.com/v1": ["https://llm.corp.com"] };

		assert.strictEqual(await rewriteLabelScopedModelParameters(setting, labelMap, logger), "migrated");
		assert.deepStrictEqual(updates[0]?.value, {
			"https://llm.corp.com/gpt-4": { temperature: 0.2 },
			"https://llm.corp.com/v1/gpt-4": { temperature: 0.2 },
		});

		assert.strictEqual(await rewriteLabelScopedModelParameters(setting, labelMap, logger), "nothing-to-do");
		assert.strictEqual(await rewriteLabelScopedModelParameters(setting, labelMap, logger), "nothing-to-do");
		assert.strictEqual(updates.length, 1, "reruns must never compound the base-URL path");
	});

	test("documented corner: a genuinely label-shaped key under the label's own base URL gets no copy", async () => {
		// With label "https://llm.corp" for base URL "https://llm.corp/v1",
		// this key can be a real label reading (model prefix "v1/gpt-4"), but
		// it is indistinguishable from a copy this migration added earlier, so
		// it is left untouched and keeps matching via the label path while
		// that path lives.
		const { setting, updates } = makeSetting({
			globalValue: { "https://llm.corp/v1/gpt-4": { temperature: 0.2 } },
		});
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(
			setting,
			{ "https://llm.corp/v1": ["https://llm.corp"] },
			logger
		);

		assert.strictEqual(outcome, "nothing-to-do");
		assert.deepStrictEqual(updates, [], "the key must be left untouched, never rewritten or dropped");
	});

	test("a label equal to ANOTHER server's base URL still gets its copy", async () => {
		// The accretion guard is per label: only a key under label X's OWN
		// base URL is exempt from X's copy. A key under server Y's base URL
		// that also matches X's label is a live label reading for X's server
		// and must not be suppressed by Y's presence in the map.
		const { setting, updates } = makeSetting({
			globalValue: { "https://y.test/gpt-4": { temperature: 0.2 } },
		});
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(
			setting,
			{ "http://x.test": ["https://y.test"], "https://y.test": ["Y"] },
			logger
		);

		assert.strictEqual(outcome, "migrated");
		assert.deepStrictEqual(updates[0]?.value, {
			"https://y.test/gpt-4": { temperature: 0.2 },
			"http://x.test/gpt-4": { temperature: 0.2 },
		});
	});

	test("a raw map value is normalized before it becomes a key", async () => {
		// The runtime scope is the group's normalized base URL; a trailing
		// slash straight from the map would build a key that never matches.
		const { setting, updates } = makeSetting({
			globalValue: { "Prod/gpt-4": { temperature: 0.2 } },
		});
		const { logger } = makeLogger();

		const outcome = await rewriteLabelScopedModelParameters(setting, { "http://prod.test///": ["Prod"] }, logger);

		assert.strictEqual(outcome, "migrated");
		assert.deepStrictEqual(updates[0]?.value, {
			"Prod/gpt-4": { temperature: 0.2 },
			"http://prod.test/gpt-4": { temperature: 0.2 },
		});
	});
});

suite("extension/migrations/labelScopedModelParameters: unionLabelSources", () => {
	test("registry servers without a map entry contribute their label and URL", () => {
		// The deferred/skipped shape: the group migration writes the map only
		// on successful seeding, so an unseeded server's label exists nowhere
		// but the registry itself.
		const union = unionLabelSources({}, [{ label: "Staging", baseUrl: "http://staging.test" }]);

		assert.deepStrictEqual(union, { "http://staging.test": ["Staging"] });
	});

	test("a label pointing at different URLs across map and registry is dropped everywhere", () => {
		const union = unionLabelSources({ "http://prod.test": ["Production", "Solo"] }, [
			{ label: "Production", baseUrl: "http://other.test" },
		]);

		assert.deepStrictEqual(union, { "http://prod.test": ["Solo"] }, "the conflicted label must vanish from both sides");
	});

	test("the same label on the same URL in both sources is one entry, trailing slashes ignored", () => {
		const union = unionLabelSources({ "http://prod.test/": ["Production"] }, [
			{ label: "Production", baseUrl: "http://prod.test" },
		]);

		assert.deepStrictEqual(union, { "http://prod.test": ["Production"] });
	});
});

suite("extension/migrations/labelScopedModelParameters: migration wiring", () => {
	test("an unseeded registry server's label-scoped key copies at pre-registration, before any seeding", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Staging", "http://staging.test", "key");
		const ctx: MigrationContext = {
			globalState: storage.memento,
			secrets: storage.secrets,
			registry,
			logger: new Logger({ info: () => {}, error: () => {} }),
		};
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const original = config.inspect<Record<string, unknown>>(MODEL_PARAMETERS_SETTING_KEY)?.globalValue;
		await config.update(
			MODEL_PARAMETERS_SETTING_KEY,
			{ "Staging/gpt-4": { temperature: 0.3 } },
			vscode.ConfigurationTarget.Global
		);

		try {
			const outcome = await labelScopedModelParametersMigration.run(ctx);

			assert.strictEqual(outcome, "migrated");
			const rewritten = vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.get<Record<string, unknown>>(MODEL_PARAMETERS_SETTING_KEY);
			assert.deepStrictEqual(rewritten?.["http://staging.test/gpt-4"], { temperature: 0.3 });
			assert.deepStrictEqual(rewritten?.["Staging/gpt-4"], { temperature: 0.3 }, "the original key is kept");
		} finally {
			await config.update(MODEL_PARAMETERS_SETTING_KEY, original, vscode.ConfigurationTarget.Global);
		}
	});
});
