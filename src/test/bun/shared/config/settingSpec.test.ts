import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MAX_TOKENS_CAP } from "../../../../provider/transport/request";
import {
	AGENT_TOOLS_SETTING_KEYS,
	ALL_SETTING_KEYS,
	type BooleanSettingId,
	FEATURE_ENABLE_SETTING_KEYS,
	FEATURE_MODEL_SETTING_KEY_LIST,
	isIntegerSetting,
	LOG_REDACTION_SETTING_KEY,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	NUMBER_SETTING_SPECS,
	type NumberSettingId,
	SERVERS_SETTING_KEY,
	SETTING_PRESENTATION,
	type SettingId,
} from "../../../../shared/config/settingSpec";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * The spec's own invariants, and its prose mirrors that no type can carry: package.nls.json's descriptions and the docs
 * quote numbers the spec owns.
 */

function readRepoFile(...segments: readonly string[]): string {
	return fs.readFileSync(path.join(REPO_ROOT, ...segments), "utf8");
}

describe("shared/config/settingSpec: value invariants", () => {
	test("an integer spec's default and bounds satisfy the rule they declare", () => {
		for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
			if (!isIntegerSetting(id as NumberSettingId)) {
				continue;
			}
			assert.ok(spec.default === null || Number.isInteger(spec.default), `${id} default must be an integer`);
			assert.ok(Number.isInteger(spec.minimum), `${id} minimum must be an integer`);
			assert.ok(Number.isInteger(spec.maximum), `${id} maximum must be an integer`);
		}
	});

	test("every non-null spec default lies within its own bounds", () => {
		// readNumberSetting hands back spec.default without judging it, so a default outside its own bounds would reach
		// consumers unchecked; the spec itself must hold.
		for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
			if (spec.default !== null) {
				assert.ok(spec.default >= spec.minimum, `${id} default ${spec.default} is below its minimum ${spec.minimum}`);
				assert.ok(spec.default <= spec.maximum, `${id} default ${spec.default} is above its maximum ${spec.maximum}`);
			}
		}
	});
});

describe("shared/config/settingSpec: prose drift guard", () => {
	test("descriptions that state a default state the spec's number", () => {
		// "Default is 300000ms (5 minutes)" and friends: the sentence may be rephrased, but the number it quotes must
		// be the live default. Quoted digits compare whole, so a spec default that is a prefix of a stale prose number
		// cannot pass.
		const nls = JSON.parse(readRepoFile("package.nls.json")) as Record<string, string>;
		let checked = 0;
		for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
			const description = nls[`litellm.config.${id}.description`];
			assert.ok(description !== undefined, `package.nls.json describes ${id}`);
			const quoted = /Default is (\d+)/.exec(description)?.[1];
			if (quoted === undefined) {
				continue;
			}
			checked += 1;
			assert.strictEqual(quoted, String(spec.default), `${id} description quotes a stale default: "${description}"`);
		}
		assert.ok(checked >= 3, "the timeout and cache TTL descriptions all state their defaults");
	});

	test("the max_tokens fallback sentence quotes DEFAULT_MAX_TOKENS_CAP", () => {
		const quoted = /capped at (\d+)\*\* when it is a guess/.exec(readRepoFile("docs", "models.md"))?.[1];
		assert.ok(quoted, "docs/models.md states the max_tokens fallback cap");
		assert.strictEqual(quoted, String(DEFAULT_MAX_TOKENS_CAP));
	});
});

describe("shared/config/settingSpec: presentation rules", () => {
	test("every setting carries exactly its ruled scope tier and trust flag", () => {
		// The tiers are load-bearing (SETTING_PRESENTATION's header says why); the rule is stated here from the feature
		// key maps, which are total over FeatureId, so the next feature cannot ship an unruled scope and the next
		// setting cannot ship an unruled trust flag.
		const catalogKey: BooleanSettingId = "models.openRouterCatalog";
		const machineOnly = new Set<string>([SERVERS_SETTING_KEY, ...AGENT_TOOLS_SETTING_KEYS]);
		const machineOverridable = new Set<string>([
			...Object.values(FEATURE_ENABLE_SETTING_KEYS).filter((key) => !machineOnly.has(key)),
			...FEATURE_MODEL_SETTING_KEY_LIST,
			catalogKey,
			LOG_REDACTION_SETTING_KEY,
		]);
		const restricted = new Set<string>([MODEL_PARAMETERS_SETTING_KEY, MODEL_CAPABILITIES_SETTING_KEY]);
		for (const key of ALL_SETTING_KEYS) {
			const presentation = SETTING_PRESENTATION[key as SettingId];
			const expectedScope = machineOverridable.has(key)
				? "machine-overridable"
				: machineOnly.has(key)
					? "machine"
					: "window";
			assert.strictEqual(presentation.scope, expectedScope, `${key} scope`);
			assert.strictEqual(presentation.restricted, restricted.has(key) ? true : undefined, `${key} restricted`);
		}
	});
});
