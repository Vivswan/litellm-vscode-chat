import * as assert from "node:assert";
import { buildRequestBody } from "../../../provider/transport/request";
import {
	CATCH_ALL_PREFIX,
	DEFAULT_MAX_TOKENS_CAP,
	findLongestPrefixEntry,
	findLongestPrefixMatch,
	findScopedMatch,
	PROVIDER_OWNED_KEYS,
	parameterSkipReason,
	projectEffectiveParameters,
	resolveMaxTokens,
	resolveModelParameters,
} from "../../../shared/config/parameterResolution";

suite("shared/config parameterResolution", () => {
	suite("parameterSkipReason", () => {
		test("classifies underscore keys, provider-owned keys, and pass-through keys", () => {
			assert.strictEqual(parameterSkipReason("_replaceDefaults"), "underscore");
			assert.strictEqual(parameterSkipReason("_"), "underscore");
			for (const key of PROVIDER_OWNED_KEYS) {
				assert.strictEqual(parameterSkipReason(key), "provider-owned", key);
			}
			assert.strictEqual(parameterSkipReason("temperature"), undefined);
			assert.strictEqual(parameterSkipReason("response_format"), undefined);
		});

		test("max_tokens is provider-owned on the pass-through path", () => {
			// Its VALUE routes through resolveMaxTokens instead; the raw key never
			// passes through a source record.
			assert.strictEqual(parameterSkipReason("max_tokens"), "provider-owned");
		});
	});

	suite("resolveMaxTokens", () => {
		test("runtime wins over everything", () => {
			assert.deepStrictEqual(
				resolveMaxTokens({
					runtimeMaxTokens: 1234,
					configuredMaxTokens: 2222,
					maxOutputTokens: 32000,
					outputLimitDeclared: true,
				}),
				{ value: 1234, source: "runtime" }
			);
		});

		test("configured wins over the model limit", () => {
			assert.deepStrictEqual(
				resolveMaxTokens({
					runtimeMaxTokens: undefined,
					configuredMaxTokens: 2222,
					maxOutputTokens: 32000,
					outputLimitDeclared: true,
				}),
				{ value: 2222, source: "configured" }
			);
		});

		test("a declared output limit is honored uncapped", () => {
			assert.deepStrictEqual(
				resolveMaxTokens({
					runtimeMaxTokens: undefined,
					configuredMaxTokens: undefined,
					maxOutputTokens: 32000,
					outputLimitDeclared: true,
				}),
				{ value: 32000, source: "declared" }
			);
		});

		test("a defaults-derived limit stays under the cap", () => {
			assert.deepStrictEqual(
				resolveMaxTokens({
					runtimeMaxTokens: undefined,
					configuredMaxTokens: undefined,
					maxOutputTokens: 32000,
					outputLimitDeclared: false,
				}),
				{ value: DEFAULT_MAX_TOKENS_CAP, source: "capped-default" }
			);
			assert.deepStrictEqual(
				resolveMaxTokens({
					runtimeMaxTokens: undefined,
					configuredMaxTokens: undefined,
					maxOutputTokens: 2000,
					outputLimitDeclared: false,
				}),
				{ value: 2000, source: "capped-default" }
			);
		});

		test("non-number runtime and configured values are ignored, exactly like the request path's typeof gate", () => {
			assert.deepStrictEqual(
				resolveMaxTokens({
					runtimeMaxTokens: "9999",
					configuredMaxTokens: "8888",
					maxOutputTokens: 32000,
					outputLimitDeclared: true,
				}),
				{ value: 32000, source: "declared" }
			);
		});
	});

	suite("resolveModelParameters", () => {
		test("an unscoped longest-prefix match resolves with attribution", () => {
			const resolved = resolveModelParameters({
				rawModelId: "gpt-4-turbo",
				globalParameters: { "gpt-4": { temperature: 0.7 }, gpt: { temperature: 0.5, seed: 1 } },
				serverScopes: [],
			});
			assert.deepStrictEqual(resolved.params, { temperature: 0.7 });
			assert.deepStrictEqual(resolved.sources.get("temperature"), {
				source: { layer: "global", key: "gpt-4" },
				shadowed: [],
			});
			assert.strictEqual(resolved.replacedUnscoped, undefined);
		});

		test("a scoped match replaces the whole unscoped record, non-colliding keys included", () => {
			// The critical semantic: replacement is record-level. The unscoped
			// record's `seed` must NOT survive into the merge, and the whole
			// replaced record is reported so the inspector can show it shadowed.
			const resolved = resolveModelParameters({
				rawModelId: "gpt-4",
				globalParameters: {
					"gpt-4": { temperature: 0.8, seed: 7 },
					"http://litellm.test/gpt-4": { temperature: 0.2 },
				},
				serverScopes: ["http://litellm.test"],
			});
			assert.deepStrictEqual(resolved.params, { temperature: 0.2 });
			assert.deepStrictEqual(resolved.sources.get("temperature"), {
				source: { layer: "global", key: "http://litellm.test/gpt-4" },
				shadowed: [],
			});
			assert.deepStrictEqual(resolved.replacedUnscoped, {
				key: "gpt-4",
				record: { temperature: 0.8, seed: 7 },
			});
		});

		test("a scoped match with no unscoped competitor reports no replacement", () => {
			const resolved = resolveModelParameters({
				rawModelId: "gpt-4",
				globalParameters: { "http://litellm.test/gpt-4": { temperature: 0.2 } },
				serverScopes: ["http://litellm.test"],
			});
			assert.deepStrictEqual(resolved.params, { temperature: 0.2 });
			assert.strictEqual(resolved.replacedUnscoped, undefined);
		});

		test("entry parameters merge key by key over the global winner, with shadowed attribution", () => {
			const resolved = resolveModelParameters({
				rawModelId: "gpt-4-turbo",
				globalParameters: { "gpt-4": { temperature: 0.8, top_p: 0.9 } },
				serverScopes: [],
				entryParameters: { "gpt-4": { temperature: 0.2 } },
			});
			assert.deepStrictEqual(resolved.params, { temperature: 0.2, top_p: 0.9 });
			assert.deepStrictEqual(resolved.sources.get("temperature"), {
				source: { layer: "entry", key: "gpt-4" },
				shadowed: [{ layer: "global", key: "gpt-4", value: 0.8 }],
			});
			assert.deepStrictEqual(resolved.sources.get("top_p"), {
				source: { layer: "global", key: "gpt-4" },
				shadowed: [],
			});
		});

		test("an entry key with no global collision carries no shadowed line", () => {
			const resolved = resolveModelParameters({
				rawModelId: "gpt-4",
				globalParameters: {},
				serverScopes: [],
				entryParameters: { "gpt-4": { seed: 5 } },
			});
			assert.deepStrictEqual(resolved.sources.get("seed"), {
				source: { layer: "entry", key: "gpt-4" },
				shadowed: [],
			});
		});

		test("entry parameters merge over the scoped winner too, and the shadowed line names the scoped key", () => {
			const resolved = resolveModelParameters({
				rawModelId: "gpt-4",
				globalParameters: { "http://litellm.test/gpt-4": { temperature: 0.4 } },
				serverScopes: ["http://litellm.test"],
				entryParameters: { "gpt-4": { temperature: 0.1 } },
			});
			assert.deepStrictEqual(resolved.params, { temperature: 0.1 });
			assert.deepStrictEqual(resolved.sources.get("temperature"), {
				source: { layer: "entry", key: "gpt-4" },
				shadowed: [{ layer: "global", key: "http://litellm.test/gpt-4", value: 0.4 }],
			});
		});

		test("no match anywhere yields empty params and no attribution", () => {
			const resolved = resolveModelParameters({
				rawModelId: "claude-opus",
				globalParameters: { "gpt-4": { temperature: 0.7 } },
				serverScopes: [],
			});
			assert.deepStrictEqual(resolved.params, {});
			assert.strictEqual(resolved.sources.size, 0);
		});
	});

	suite("findScopedMatch attribution", () => {
		test("returns the winning key alongside the value", () => {
			const match = findScopedMatch("gpt-4-turbo", ["http://a.test"], {
				"http://a.test/gpt-4": { temperature: 0.4 },
				"http://a.test/gpt-4-turbo": { temperature: 0.6 },
			});
			assert.strictEqual(match?.key, "http://a.test/gpt-4-turbo");
			assert.deepStrictEqual(match?.value, { temperature: 0.6 });
		});

		test("findLongestPrefixMatch still answers plain prefix lookups", () => {
			assert.strictEqual(findLongestPrefixMatch("gpt-4o", { "gpt-4": "short" }), "short");
		});
	});

	suite('the "*" catch-all alias', () => {
		test('a bare "*" matches every ID at specificity zero, exactly like ""', () => {
			for (const id of ["gpt-4", "claude-opus", "", "*weird"]) {
				const viaStar = findLongestPrefixEntry(id, { [CATCH_ALL_PREFIX]: "hit" });
				const viaEmpty = findLongestPrefixEntry(id, { "": "hit" });
				assert.deepStrictEqual(viaStar, { key: "*", value: "hit" }, `id ${JSON.stringify(id)}`);
				assert.deepStrictEqual(viaEmpty, { key: "", value: "hit" }, `id ${JSON.stringify(id)}`);
			}
		});

		test('any longer real prefix beats "*"', () => {
			assert.deepStrictEqual(findLongestPrefixEntry("gpt-4", { "*": "star", g: "letter" }), {
				key: "g",
				value: "letter",
			});
		});

		test('a record carrying both "*" and "" resolves to "*" deterministically, in either declaration order', () => {
			assert.strictEqual(findLongestPrefixEntry("gpt-4", { "": "empty", "*": "star" })?.key, "*");
			assert.strictEqual(findLongestPrefixEntry("gpt-4", { "*": "star", "": "empty" })?.key, "*");
		});

		test('"*" no longer literal-matches IDs that start with an asterisk; longer asterisk keys stay literal', () => {
			// Before the alias, "*" was a length-1 literal prefix and would have
			// beaten "" for the (hypothetical) ID "*model". Now both sit at
			// specificity zero and the "*"-wins tie-break decides; a real literal
			// like "*mo" still wins on length.
			assert.strictEqual(findLongestPrefixEntry("*model", { "*": "star", "*mo": "literal" })?.key, "*mo");
			assert.strictEqual(findLongestPrefixEntry("gpt-4", { "*mo": "literal" }), undefined);
		});

		test('the scoped form "<scope>/*" matches every ID of that scope and loses to longer scoped prefixes', () => {
			const entries = {
				"http://a.test/*": { temperature: 0.1 },
				"http://a.test/gpt-4": { temperature: 0.2 },
			};
			const specific = findScopedMatch("gpt-4-turbo", ["http://a.test"], entries);
			assert.strictEqual(specific?.key, "http://a.test/gpt-4");
			const catchAll = findScopedMatch("claude-opus", ["http://a.test"], entries);
			assert.deepStrictEqual(catchAll, { key: "http://a.test/*", specificity: 0, value: { temperature: 0.1 } });
		});

		test('within one scope "<scope>/*" beats "<scope>/", in either declaration order', () => {
			const scopes = ["http://a.test"];
			assert.strictEqual(
				findScopedMatch("gpt-4", scopes, { "http://a.test/": "empty", "http://a.test/*": "star" })?.key,
				"http://a.test/*"
			);
			assert.strictEqual(
				findScopedMatch("gpt-4", scopes, { "http://a.test/*": "star", "http://a.test/": "empty" })?.key,
				"http://a.test/*"
			);
		});

		test("scope-order ties still resolve to the earlier scope, catch-alls included", () => {
			const match = findScopedMatch("gpt-4", ["http://a.test", "http://b.test"], {
				"http://b.test/*": "b-star",
				"http://a.test/*": "a-star",
			});
			assert.strictEqual(match?.value, "a-star");
		});

		test('a mixed specificity-zero tie across scopes keeps the earlier scope: "<A>/" is not displaced by "<B>/*"', () => {
			// The tie-break upgrades "*" over "" only within one scope; across
			// scopes the earlier scope still wins regardless of which spelling of
			// the catch-all each carries.
			const entries = { "http://a.test/": "a-empty", "http://b.test/*": "b-star" };
			assert.strictEqual(findScopedMatch("gpt-4", ["http://a.test", "http://b.test"], entries)?.value, "a-empty");
			assert.strictEqual(findScopedMatch("gpt-4", ["http://b.test", "http://a.test"], entries)?.value, "b-star");
		});

		test('a scoped "*" record replaces the whole unscoped record, and entry "*" merges over it', () => {
			const resolved = resolveModelParameters({
				rawModelId: "gpt-4",
				globalParameters: {
					"gpt-4": { temperature: 0.8, seed: 7 },
					"http://litellm.test/*": { temperature: 0.2 },
				},
				serverScopes: ["http://litellm.test"],
				entryParameters: { "*": { top_p: 0.5 } },
			});
			assert.deepStrictEqual(resolved.params, { temperature: 0.2, top_p: 0.5 });
			assert.deepStrictEqual(resolved.replacedUnscoped, { key: "gpt-4", record: { temperature: 0.8, seed: 7 } });
			assert.deepStrictEqual(resolved.sources.get("top_p"), {
				source: { layer: "entry", key: "*" },
				shadowed: [],
			});
		});
	});

	suite("projectEffectiveParameters", () => {
		test("sent rows, not-sent rows with reasons, and name-sorted order", () => {
			const projection = projectEffectiveParameters({
				rawModelId: "gpt-4",
				globalParameters: { "gpt-4": { temperature: 0.7, _internal: true, stream: false, seed: 3 } },
				serverScopes: [],
				maxOutputTokens: 8000,
				outputLimitDeclared: false,
			});
			assert.deepStrictEqual(
				projection.rows.map((row) => [row.name, row.sent, row.skipReason]),
				[
					["_internal", false, "underscore"],
					["seed", true, undefined],
					["stream", false, "provider-owned"],
					["temperature", true, undefined],
				]
			);
		});

		test("a numeric configured max_tokens leaves the rows and drives the derivation with its attribution", () => {
			const projection = projectEffectiveParameters({
				rawModelId: "gpt-4",
				globalParameters: { "gpt-4": { max_tokens: 2222 } },
				serverScopes: [],
				entryParameters: { "gpt-4": { max_tokens: 3333 } },
				maxOutputTokens: 32000,
				outputLimitDeclared: true,
			});
			assert.deepStrictEqual(projection.rows, [], "max_tokens must not render as a parameter row");
			assert.deepStrictEqual(projection.maxTokens, {
				value: 3333,
				source: "configured",
				configuredSource: { layer: "entry", key: "gpt-4" },
			});
		});

		test("a non-numeric configured max_tokens stays a not-sent row and the derivation falls through", () => {
			const projection = projectEffectiveParameters({
				rawModelId: "gpt-4",
				globalParameters: { "gpt-4": { max_tokens: "2222" } },
				serverScopes: [],
				maxOutputTokens: 32000,
				outputLimitDeclared: true,
			});
			assert.deepStrictEqual(
				projection.rows.map((row) => [row.name, row.sent, row.skipReason]),
				[["max_tokens", false, "provider-owned"]]
			);
			assert.deepStrictEqual(projection.maxTokens, { value: 32000, source: "declared" });
		});

		test("the empty projection still derives max_tokens (declared and capped branches)", () => {
			const declared = projectEffectiveParameters({
				rawModelId: "gpt-4",
				globalParameters: {},
				serverScopes: [],
				maxOutputTokens: 32000,
				outputLimitDeclared: true,
			});
			assert.deepStrictEqual(declared.rows, []);
			assert.deepStrictEqual(declared.maxTokens, { value: 32000, source: "declared" });

			const capped = projectEffectiveParameters({
				rawModelId: "gpt-4",
				globalParameters: {},
				serverScopes: [],
				maxOutputTokens: 32000,
				outputLimitDeclared: false,
			});
			assert.deepStrictEqual(capped.maxTokens, { value: DEFAULT_MAX_TOKENS_CAP, source: "capped-default" });
		});

		test("the replaced unscoped record rides the projection whole", () => {
			const projection = projectEffectiveParameters({
				rawModelId: "gpt-4",
				globalParameters: {
					"gpt-4": { temperature: 0.8, seed: 7 },
					"http://litellm.test/gpt-4": { temperature: 0.2 },
				},
				serverScopes: ["http://litellm.test"],
				maxOutputTokens: 8000,
				outputLimitDeclared: false,
			});
			assert.deepStrictEqual(projection.replacedUnscoped, { key: "gpt-4", record: { temperature: 0.8, seed: 7 } });
			assert.deepStrictEqual(
				projection.rows.map((row) => row.name),
				["temperature"],
				"the replaced record's keys never become rows"
			);
		});

		test("an own __proto__ parameter key projects as not sent, matching what the wire can carry", () => {
			// Object literals cannot express an own __proto__ key; JSON.parse can,
			// and so can a user's settings.json. The underscore rule catches it
			// (it starts with "_"), which is exactly the wire truth: the request
			// path skips it under the same rule, and even without the skip the
			// prototype accessor could never let body assignment serialize it.
			const globalParameters = JSON.parse('{"gpt-4": {"__proto__": {"polluted": true}, "temperature": 0.2}}') as Record<
				string,
				Record<string, unknown>
			>;
			const input = {
				rawModelId: "gpt-4",
				globalParameters,
				serverScopes: [],
				maxOutputTokens: 8000,
				outputLimitDeclared: false,
			};
			const projection = projectEffectiveParameters(input);
			assert.deepStrictEqual(
				projection.rows.map((row) => [row.name, row.sent, row.skipReason]),
				[
					["__proto__", false, "underscore"],
					["temperature", true, undefined],
				]
			);

			const body = buildRequestBody({
				rawModelId: "gpt-4",
				openaiMessages: [{ role: "user", content: "hi" }],
				maxTokens: 4096,
				modelParams: resolveModelParameters(input).params,
				toolConfig: undefined,
			});
			assert.ok(!Object.hasOwn(body, "__proto__"), "assignment cannot create an own __proto__ key");
			assert.ok(!JSON.stringify(body).includes("polluted"), "nothing of the value reaches the serialized wire");
			assert.strictEqual(body.temperature, 0.2, "ordinary keys in the same record still pass through");
		});
	});
});
