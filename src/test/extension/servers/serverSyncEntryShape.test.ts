/**
 * The nested entry shape: auth forms, headers, declared models and budget, and
 * the fingerprint stability the entry restructure's migration depends on.
 */
import * as assert from "node:assert";
import type { DeclaredServer, StoredServerSecrets } from "../../../extension/servers/serverSync";
import { buildGroupArgs, parseServersSetting, ServerSyncEngine } from "../../../extension/servers/serverSync";
import {
	declaredEntryLabel,
	entryApiVersionFor,
	entryDeclaredModelsFor,
	entryHeadersFor,
	rawDeclaredLabels,
	stillDeclaredIn,
} from "../../../extension/servers/serverSync/setting";
import { fingerprint } from "../../../shared/util/fingerprint";
import { makeSyncEnv } from "./serverSyncHelpers";

suite("extension/servers/serverSync: the nested entry shape", () => {
	const parseOne = (entry: Record<string, unknown>) =>
		parseServersSetting([{ label: "S", baseUrl: "http://s.test", ...entry }]);

	suite("auth forms", () => {
		test("each single form flattens onto the internal credential fields", () => {
			const apiKey = parseOne({ auth: { apiKey: "sk-1" } });
			assert.deepStrictEqual(apiKey.entries[0], { label: "S", baseUrl: "http://s.test", apiKey: "sk-1" });

			const oauth = parseOne({
				auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", clientSecret: "shh", scopes: "read" } },
			});
			assert.deepStrictEqual(oauth.entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "c1",
				oauthClientSecret: "shh",
				oauthScopes: "read",
			});

			const virtualKey = parseOne({ auth: { virtualKey: { header: "x-litellm-key", value: "vk-1" } } });
			assert.deepStrictEqual(virtualKey.entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				virtualKeyHeader: "x-litellm-key",
				virtualKeyValue: "vk-1",
			});
		});

		test("the oauth companions nest inside the oauth object", () => {
			const { entries, problems } = parseOne({
				auth: {
					oauth: {
						tokenUrl: "https://idp.test/token",
						clientId: "c1",
						apiKey: "sk-companion",
						virtualKey: { header: "x-vk", value: "vk-companion" },
					},
				},
			});
			assert.deepStrictEqual(problems, []);
			assert.deepStrictEqual(entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				apiKey: "sk-companion",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "c1",
				virtualKeyHeader: "x-vk",
				virtualKeyValue: "vk-companion",
			});
		});

		test("the apiKey form may carry a sibling virtualKey companion (forms rank oauth > apiKey > virtualKey)", () => {
			const { entries, problems } = parseOne({
				auth: { apiKey: "sk-1", virtualKey: { header: "x-vk", value: "vk-1" } },
			});
			assert.deepStrictEqual(problems, []);
			assert.deepStrictEqual(entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				apiKey: "sk-1",
				virtualKeyHeader: "x-vk",
				virtualKeyValue: "vk-1",
			});
		});

		test("a form waiting for its secret VALUE is not misconfiguration: the entry works without the value", () => {
			// The normal add-entry-then-set-secret state (docs: servers.md,
			// Authentication): the shape is complete, only the secret is elsewhere.
			const virtualKey = parseOne({ auth: { virtualKey: { header: "x-vk" } } });
			assert.deepStrictEqual(virtualKey.problems, []);
			assert.deepStrictEqual(virtualKey.entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				virtualKeyHeader: "x-vk",
			});

			const emptyApiKey = parseOne({ auth: { apiKey: "" } });
			assert.deepStrictEqual(emptyApiKey.problems, []);
			assert.deepStrictEqual(emptyApiKey.entries[0], { label: "S", baseUrl: "http://s.test" });
		});

		test("misconfigured auth skips the entry with a diagnostic: sibling forms beside oauth", () => {
			const { entries, problems } = parseOne({
				auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "c1" }, apiKey: "sk-1" },
			});
			assert.deepStrictEqual(entries, []);
			assert.ok(
				problems.some((problem) => problem.includes("has auth.apiKey beside auth.oauth; move it to auth.oauth.apiKey")),
				`${problems}`
			);
			assert.ok(
				problems.some((problem) => problem.includes("misconfigured")),
				`${problems}`
			);

			const virtualKeyBeside = parseOne({
				auth: {
					oauth: { tokenUrl: "https://idp.test/token", clientId: "c1" },
					virtualKey: { header: "x-vk", value: "vk-1" },
				},
			});
			assert.deepStrictEqual(virtualKeyBeside.entries, []);
			assert.ok(
				virtualKeyBeside.problems.some((problem) =>
					problem.includes("has auth.virtualKey beside auth.oauth; move it to auth.oauth.virtualKey")
				),
				`${virtualKeyBeside.problems}`
			);
			// Per-key precision: only the offending key is named.
			assert.ok(
				!virtualKeyBeside.problems.some((problem) => problem.includes("has auth.apiKey beside")),
				`${virtualKeyBeside.problems}`
			);

			// Both companions beside oauth: one problem per offending key.
			const bothBeside = parseOne({
				auth: {
					oauth: { tokenUrl: "https://idp.test/token", clientId: "c1" },
					apiKey: "sk-1",
					virtualKey: { header: "x-vk", value: "vk-1" },
				},
			});
			assert.deepStrictEqual(bothBeside.entries, []);
			for (const key of ["apiKey", "virtualKey"]) {
				assert.ok(
					bothBeside.problems.some((problem) =>
						problem.includes(`has auth.${key} beside auth.oauth; move it to auth.oauth.${key}`)
					),
					`${bothBeside.problems}`
				);
			}
		});

		test("misconfigured auth: shape-incomplete oauth and virtualKey (config-shape errors never guess)", () => {
			const noClientId = parseOne({ auth: { oauth: { tokenUrl: "https://idp.test/token" } } });
			assert.deepStrictEqual(noClientId.entries, []);
			assert.ok(noClientId.problems.some((problem) => problem.includes("incomplete auth.oauth")));

			const noHeader = parseOne({ auth: { virtualKey: { value: "vk-1" } } });
			assert.deepStrictEqual(noHeader.entries, []);
			assert.ok(noHeader.problems.some((problem) => problem.includes("without a usable header name")));

			const badHeader = parseOne({ auth: { virtualKey: { header: "bad header", value: "vk-1" } } });
			assert.deepStrictEqual(badHeader.entries, []);
			assert.ok(badHeader.problems.some((problem) => problem.includes("not a valid HTTP header name")));
		});

		test("misconfigured auth: unknown keys are named (a typo must not silently read as no auth)", () => {
			const { entries, problems } = parseOne({ auth: { apikey: "sk-1" } });
			assert.deepStrictEqual(entries, []);
			assert.ok(
				problems.some((problem) => problem.includes('unknown auth key "apikey"')),
				`${problems}`
			);

			const emptyAuth = parseOne({ auth: {} });
			assert.deepStrictEqual(emptyAuth.entries, []);
			assert.ok(emptyAuth.problems.some((problem) => problem.includes("configures no form")));

			const notAnObject = parseOne({ auth: "sk-1" });
			assert.deepStrictEqual(notAnObject.entries, []);
			assert.ok(notAnObject.problems.some((problem) => problem.includes("not an object")));
		});

		test("a misconfigured entry stays PRESENT: rawDeclaredLabels keeps its label, so no removal is inferred", () => {
			const raw = [{ label: "S", baseUrl: "http://s.test", auth: { apiKey: 42 } }];
			assert.deepStrictEqual(parseServersSetting(raw).entries, []);
			assert.deepStrictEqual([...rawDeclaredLabels(raw)], ["S"]);
		});

		test("declaredEntryLabel mirrors rawDeclaredLabels' per-entry rule", () => {
			assert.strictEqual(declaredEntryLabel({ label: " alpha " }), "alpha");
			assert.strictEqual(declaredEntryLabel({ label: "" }), undefined);
			assert.strictEqual(declaredEntryLabel({ label: "__proto__" }), undefined);
			assert.strictEqual(declaredEntryLabel({ label: 42 }), undefined);
			assert.strictEqual(declaredEntryLabel("not-an-object"), undefined);
		});

		test("stillDeclaredIn judges presence, not acceptance, and a non-array container proves nothing", () => {
			const present = stillDeclaredIn([{ label: "S", baseUrl: "http://s.test", auth: { apiKey: 42 } }]);
			assert.ok(present("S"), "a misconfigured entry's label is still declared");
			assert.ok(!present("gone"), "a label no raw entry carries reads as removed");
			assert.ok(stillDeclaredIn(undefined)("anything"), "a non-array container reads everything as present");
			assert.ok(!stillDeclaredIn([])("anything"), "an empty array is a real remove-everything");
		});
	});

	suite("headers, discovery.declared, and budget", () => {
		test("apiVersion parses trimmed and KEEPS the empty string (append nothing is a real value)", () => {
			assert.strictEqual(parseOne({ apiVersion: "v2" }).entries[0]?.apiVersion, "v2");
			assert.strictEqual(parseOne({ apiVersion: " v2 " }).entries[0]?.apiVersion, "v2");
			assert.strictEqual(parseOne({ apiVersion: "" }).entries[0]?.apiVersion, "");
			assert.strictEqual(parseOne({ apiVersion: "  " }).entries[0]?.apiVersion, "");
			assert.ok(!("apiVersion" in (parseOne({}).entries[0] ?? {})), "absent stays absent");
		});

		test("a non-string apiVersion is a diagnostic and is ignored; the entry stays usable (it is not auth)", () => {
			const invalid = parseOne({ apiVersion: 2 });
			assert.strictEqual(invalid.entries.length, 1);
			assert.ok(!("apiVersion" in (invalid.entries[0] ?? {})));
			assert.ok(
				invalid.problems.some((problem) => problem.includes("apiVersion that is not a string")),
				`${invalid.problems}`
			);
		});

		test("headers parse under the request path's charset rules; case collisions keep the first and report", () => {
			const { entries, problems } = parseOne({
				headers: { "X-Env": "prod", "x-env": "stage", "bad header": "v", "x-count": 2 },
			});
			assert.deepStrictEqual(entries[0]?.headers, { "X-Env": "prod", "x-count": "2" });
			assert.ok(
				problems.some((problem) => problem.includes("repeats an earlier name")),
				`${problems}`
			);
			assert.ok(
				problems.some((problem) => problem.includes("invalid custom header name")),
				`${problems}`
			);
		});

		test("discovery.declared keeps usable exact IDs, deduplicated; junk entries are counted", () => {
			const { entries, problems } = parseOne({
				discovery: { declared: ["deepseek-r1", "deepseek-r1", "  ", 42, "qwen"] },
			});
			assert.deepStrictEqual(entries[0]?.declaredModels, ["deepseek-r1", "qwen"]);
			assert.ok(
				problems.some((problem) => problem.includes("2 unusable discovery.declared value(s)")),
				`${problems}`
			);
		});

		test("unknown discovery keys are named (a typo must not silently read as nothing configured)", () => {
			// The same per-key precision as the unknown auth keys: the report names
			// the structural key, so "expectedFailure" cannot silently read as "no
			// expected failures". Diagnostic only - the entry stays usable.
			const { entries, problems } = parseOne({
				discovery: { expectedFailure: ["modelInfo"], declared: ["deepseek-r1"] },
			});
			assert.strictEqual(entries.length, 1, "an unknown discovery key is a diagnostic, not a rejection");
			assert.ok(!("expectedFailures" in (entries[0] ?? {})), "the typo must not apply as expectedFailures");
			assert.deepStrictEqual(entries[0]?.declaredModels, ["deepseek-r1"], "the known sibling key still applies");
			assert.deepStrictEqual(problems, ['entry 1 has an unknown discovery key "expectedFailure", ignored']);
		});

		test("unknown models keys are named (a typo must not silently read as no per-entry records)", () => {
			const { entries, problems } = parseOne({
				models: { parameter: { "*": { temperature: 0 } }, capabilities: { "*": { supports_vision: true } } },
			});
			assert.strictEqual(entries.length, 1, "an unknown models key is a diagnostic, not a rejection");
			assert.ok(!("modelParameters" in (entries[0] ?? {})), "the typo must not apply as models.parameters");
			assert.deepStrictEqual(
				entries[0]?.modelCapabilities,
				{ "*": { supports_vision: true } },
				"the known sibling key still applies"
			);
			assert.deepStrictEqual(problems, ['entry 1 has an unknown models key "parameter", ignored']);
		});

		test("an invalid budget is a diagnostic and is ignored; the entry stays usable (it is not auth)", () => {
			const invalid = parseOne({ budget: 0 });
			assert.strictEqual(invalid.entries.length, 1);
			assert.ok(!("budget" in (invalid.entries[0] ?? {})));
			assert.ok(invalid.problems.some((problem) => problem.includes("budget")));

			const valid = parseOne({ budget: 50 });
			assert.strictEqual(valid.entries[0]?.budget, 50);
			assert.deepStrictEqual(valid.problems, []);
		});

		test("the accessors resolve headers and declared models only when label and normalized base URL agree", () => {
			const raw = [
				{
					label: "Prod",
					baseUrl: "http://prod.test/",
					apiVersion: "",
					headers: { "x-env": "prod" },
					discovery: { declared: ["deepseek-r1"] },
				},
			];
			assert.deepStrictEqual(entryHeadersFor(raw, "Prod", "http://prod.test"), { "x-env": "prod" });
			assert.deepStrictEqual(entryDeclaredModelsFor(raw, "Prod", "http://prod.test"), ["deepseek-r1"]);
			assert.strictEqual(entryApiVersionFor(raw, "Prod", "http://prod.test"), "", '"" resolves as a real value');
			assert.strictEqual(entryHeadersFor(raw, "Prod", "http://other.test"), undefined);
			assert.strictEqual(entryDeclaredModelsFor(raw, "Nope", "http://prod.test"), undefined);
			assert.strictEqual(entryApiVersionFor(raw, "Prod", "http://other.test"), undefined);
		});

		test("none of apiVersion, headers, declaredModels, or budget enter the group args or their fingerprint", () => {
			const bare: DeclaredServer = { label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1" };
			const withFields: DeclaredServer = {
				...bare,
				apiVersion: "v2",
				headers: { "x-env": "prod" },
				declaredModels: ["deepseek-r1"],
				budget: 50,
			};
			const stored: StoredServerSecrets = {};
			assert.deepStrictEqual(buildGroupArgs(withFields, stored), buildGroupArgs(bare, stored));
			assert.strictEqual(
				fingerprint(JSON.stringify(buildGroupArgs(withFields, stored))),
				fingerprint(JSON.stringify(buildGroupArgs(bare, stored)))
			);
		});

		test("the engine's view carries apiVersion, the empty override included (the edit form's prefill)", async () => {
			const recorded = makeSyncEnv([
				{ label: "A", baseUrl: "http://a.test", apiVersion: "v2" },
				{ label: "B", baseUrl: "http://b.test", apiVersion: "" },
				{ label: "C", baseUrl: "http://c.test" },
			]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			const byLabel = new Map(engine.getDeclared().map((view) => [view.label, view]));
			assert.strictEqual(byLabel.get("A")?.apiVersion, "v2");
			assert.strictEqual(byLabel.get("B")?.apiVersion, "", '"" must survive the view construction');
			assert.ok(!("apiVersion" in (byLabel.get("C") ?? {})), "absent stays absent");
		});
	});

	suite("FINGERPRINT STABILITY across the entry restructure (R3's migration depends on this pin)", () => {
		// The migration rewrites entries from the flat pre-redesign fields to the nested
		// auth shape without touching SERVER_SYNC_FINGERPRINTS_KEY or any SecretStorage
		// value. That is sound only while a migrated entry flattens to byte-identical
		// group args - same keys, same values, same insertion order - as its flat
		// original, for every credential combination the old world honored.
		const pin = (flat: DeclaredServer, nested: Record<string, unknown>, stored: StoredServerSecrets = {}) => {
			const { entries, problems } = parseServersSetting([nested]);
			assert.deepStrictEqual(problems, [], JSON.stringify(nested));
			const parsed = entries[0];
			assert.ok(parsed, "the nested entry must parse");
			const flatArgs = buildGroupArgs(flat, stored);
			const nestedArgs = buildGroupArgs(parsed, stored);
			assert.deepStrictEqual(nestedArgs, flatArgs);
			assert.deepStrictEqual(Object.keys(nestedArgs), Object.keys(flatArgs), "key order is part of the rendering");
			assert.strictEqual(fingerprint(JSON.stringify(nestedArgs)), fingerprint(JSON.stringify(flatArgs)));
		};

		test("apiKey only", () => {
			pin(
				{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1" },
				{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } }
			);
		});

		test("oauth with every field", () => {
			pin(
				{
					label: "A",
					baseUrl: "http://a.test",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "c1",
					oauthClientSecret: "shh",
					oauthScopes: "read write",
				},
				{
					label: "A",
					baseUrl: "http://a.test",
					auth: {
						oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", clientSecret: "shh", scopes: "read write" },
					},
				}
			);
		});

		test("the old apiKey+oauth combo maps to the oauth apiKey companion", () => {
			pin(
				{
					label: "A",
					baseUrl: "http://a.test",
					apiKey: "sk-1",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "c1",
				},
				{
					label: "A",
					baseUrl: "http://a.test",
					auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", apiKey: "sk-1" } },
				}
			);
		});

		test("the old oauth+virtualKey combo maps to the oauth virtualKey companion", () => {
			pin(
				{
					label: "A",
					baseUrl: "http://a.test",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "c1",
					virtualKeyHeader: "x-vk",
					virtualKeyValue: "vk-1",
				},
				{
					label: "A",
					baseUrl: "http://a.test",
					auth: {
						oauth: {
							tokenUrl: "https://idp.test/token",
							clientId: "c1",
							virtualKey: { header: "x-vk", value: "vk-1" },
						},
					},
				}
			);
		});

		test("virtualKey only", () => {
			pin(
				{ label: "A", baseUrl: "http://a.test", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-1" },
				{ label: "A", baseUrl: "http://a.test", auth: { virtualKey: { header: "x-vk", value: "vk-1" } } }
			);
		});

		test("the old apiKey+virtualKey combo (no oauth) maps to the apiKey form with a sibling companion", () => {
			pin(
				{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-1" },
				{
					label: "A",
					baseUrl: "http://a.test",
					auth: { apiKey: "sk-1", virtualKey: { header: "x-vk", value: "vk-1" } },
				}
			);
		});

		test("stored-only secrets keep resolving: a no-auth entry with a stored apiKey still sends the bearer", () => {
			// The quick-start shape: the entry omits auth entirely and the value
			// sits in SecretStorage; the migration writes no auth object for it.
			pin({ label: "A", baseUrl: "http://a.test" }, { label: "A", baseUrl: "http://a.test" }, { apiKey: "sk-stored" });
			assert.strictEqual(
				buildGroupArgs(parseServersSetting([{ label: "A", baseUrl: "http://a.test" }]).entries[0] as DeclaredServer, {
					apiKey: "sk-stored",
				}).apiKey,
				"sk-stored"
			);
		});

		test("stored virtualKey value fills the declared header's slot", () => {
			pin(
				{ label: "A", baseUrl: "http://a.test", virtualKeyHeader: "x-vk" },
				{ label: "A", baseUrl: "http://a.test", auth: { virtualKey: { header: "x-vk" } } },
				{ virtualKeyValue: "vk-stored" }
			);
		});

		// The ruled exceptions: auth fragments the old runtime never honored on the wire
		// drop at migration, so THESE entries' fingerprints change once on upgrade - a
		// single group update with identical wire behavior.
		test("ACCEPTED EXCEPTION: a wire-inert partial-oauth fragment drops and the fingerprint changes once", () => {
			const flat: DeclaredServer = { label: "A", baseUrl: "http://a.test", apiKey: "sk-1", oauthClientId: "c1" };
			// entries.ts drops the lone oauth piece: the migrated entry is the
			// plain apiKey form.
			const { entries, problems } = parseServersSetting([
				{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } },
			]);
			assert.deepStrictEqual(problems, []);
			const migrated = entries[0];
			assert.ok(migrated, "the migrated entry must parse");
			const flatArgs = buildGroupArgs(flat, {});
			const migratedArgs = buildGroupArgs(migrated, {});
			assert.notDeepStrictEqual(migratedArgs, flatArgs, "the fragment was in the old args, so the args differ");
			assert.strictEqual(migratedArgs.baseUrl, flatArgs.baseUrl);
			assert.strictEqual(migratedArgs.apiKey, flatArgs.apiKey, "every wire-relevant credential is unchanged");
			assert.strictEqual(migratedArgs.oauthTokenUrl, undefined, "neither side could ever exchange a token");
		});

		test("ACCEPTED EXCEPTION: a header-less virtualKey value drops and the fingerprint changes once", () => {
			const flat: DeclaredServer = { label: "A", baseUrl: "http://a.test", apiKey: "sk-1", virtualKeyValue: "vk-1" };
			const { entries, problems } = parseServersSetting([
				{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } },
			]);
			assert.deepStrictEqual(problems, []);
			const migrated = entries[0];
			assert.ok(migrated, "the migrated entry must parse");
			const flatArgs = buildGroupArgs(flat, {});
			const migratedArgs = buildGroupArgs(migrated, {});
			assert.notDeepStrictEqual(migratedArgs, flatArgs);
			assert.strictEqual(migratedArgs.apiKey, flatArgs.apiKey);
			assert.strictEqual(
				migratedArgs.virtualKeyValue,
				undefined,
				"a value without its header never left the process on either side"
			);
		});
	});
});
