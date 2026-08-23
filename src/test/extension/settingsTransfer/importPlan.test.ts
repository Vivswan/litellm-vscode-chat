import * as assert from "node:assert";
import { buildGroupArgs } from "../../../extension/servers/serverSync/engine";
import type { StoredSecretsRecord, StoredServerSecrets } from "../../../extension/servers/serverSync/secrets";
import { acceptedEntry } from "../../../extension/servers/serverSync/setting";
import type {
	CollisionDecision,
	CollisionDecisions,
	ImportApplication,
	ImportPlan,
	IncomingServer,
	SecretWrite,
	ServerCollision,
	SettingWrite,
	SkippedKey,
} from "../../../extension/settingsTransfer/importPlan";
import {
	planSettingsImport,
	resolveImportPlan,
	staleStoredKeyFields,
	suggestRenamedLabel,
	USAGE_STATUS_BAR_MODE_VALUES,
} from "../../../extension/settingsTransfer/importPlan";
import { SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";
import { USAGE_STATUS_BAR_MODES } from "../../../shared/config/settings";

function server(label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { label, baseUrl: `http://${label.toLowerCase()}.test`, ...extra };
}

suite("extension/settingsTransfer/importPlan", () => {
	test("the frozen signatures and result shapes", () => {
		const plan: (
			envelopeSettings: Readonly<Record<string, unknown>>,
			currentServersRaw: unknown,
			storedSecrets?: Readonly<Record<string, StoredServerSecrets>>
		) => ImportPlan = planSettingsImport;
		const resolve: (plan: ImportPlan, decisions: CollisionDecisions) => ImportApplication = resolveImportPlan;
		const suggest: (label: string, takenLabels: ReadonlySet<string>) => string = suggestRenamedLabel;
		assert.strictEqual(typeof plan, "function");
		assert.strictEqual(typeof resolve, "function");
		assert.strictEqual(typeof suggest, "function");
		const write: SettingWrite = { key: "chat.timeout", value: 1 };
		const skipped: SkippedKey = { key: "chat.promptCaching", reason: "wrong-type" };
		const decision: CollisionDecision = { action: "rename", newLabel: "B" };
		const collision: ServerCollision = { label: "A", connectionChanged: false };
		const incoming: IncomingServer = {
			raw: server("A"),
			report: { index: 0, label: "A", baseUrl: "http://a.test", problems: [], accepted: true },
			skipped: false,
		};
		const secretWrite: SecretWrite = { label: "A", secrets: {}, owners: {}, restamps: {}, guardedClears: {} };
		assert.ok(write && skipped && decision && collision && incoming && secretWrite);
	});

	test("the local usage.statusBar vocabulary mirrors the settings module's enum", () => {
		assert.deepStrictEqual([...USAGE_STATUS_BAR_MODE_VALUES], [...USAGE_STATUS_BAR_MODES]);
	});

	suite("planSettingsImport", () => {
		test("known non-servers keys become writes in ALL_SETTING_KEYS order", () => {
			const plan = planSettingsImport(
				{
					"chat.promptCaching": false,
					"models.parameters": { "*": { temperature: 1 } },
					"chat.timeout": 60000,
				},
				undefined
			);
			assert.deepStrictEqual(plan.settingsWrites, [
				{ key: "models.parameters", value: { "*": { temperature: 1 } } },
				{ key: "chat.timeout", value: 60000 },
				{ key: "chat.promptCaching", value: false },
			]);
			assert.deepStrictEqual(plan.skippedKeys, []);
			assert.deepStrictEqual(plan.incomingServers, []);
			assert.deepStrictEqual(plan.collisions, []);
			assert.strictEqual(plan.secretFieldCount, 0);
		});

		test("the scalar type gate skips wrong-JS-typed spec'd values and out-of-enum statusBar modes", () => {
			const plan = planSettingsImport(
				{
					"chat.timeout": "60000",
					"discovery.cacheTtl": null,
					"chat.promptCaching": 1,
					"models.openRouterCatalog": true,
					"usage.statusBar": "sometimes",
					"usage.alertThresholds": "not-an-array",
					"models.capabilities": 42,
				},
				undefined
			);
			assert.deepStrictEqual(plan.skippedKeys, [
				{ key: "usage.statusBar", reason: "wrong-type" },
				{ key: "chat.timeout", reason: "wrong-type" },
				{ key: "discovery.cacheTtl", reason: "wrong-type" },
				{ key: "chat.promptCaching", reason: "wrong-type" },
			]);
			// Structured keys pass through to their readers' existing leniency.
			assert.deepStrictEqual(plan.settingsWrites, [
				{ key: "models.capabilities", value: 42 },
				{ key: "usage.alertThresholds", value: "not-an-array" },
				{ key: "models.openRouterCatalog", value: true },
			]);
		});

		test("every declared usage.statusBar mode passes the gate", () => {
			for (const mode of USAGE_STATUS_BAR_MODES) {
				const plan = planSettingsImport({ "usage.statusBar": mode }, undefined);
				assert.deepStrictEqual(plan.settingsWrites, [{ key: "usage.statusBar", value: mode }]);
			}
		});

		test("a non-array servers value lands in skippedKeys instead of dropping silently", () => {
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: { label: "A" } }, undefined);
			assert.deepStrictEqual(plan.skippedKeys, [{ key: SERVERS_SETTING_KEY, reason: "wrong-type" }]);
			assert.deepStrictEqual(plan.settingsWrites, []);
			assert.deepStrictEqual(plan.incomingServers, []);
		});

		test("incoming entries carry per-entry verdicts; unlabeled and reserved-label entries are skipped", () => {
			const incoming = [
				server("A"),
				{ baseUrl: "http://nolabel.test" },
				server("__proto__"),
				"junk",
				server("Broken", { auth: { unknownKey: true } }),
			];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, undefined);
			assert.deepStrictEqual(
				plan.incomingServers.map((entry) => entry.skipped),
				[false, true, true, true, false]
			);
			assert.deepStrictEqual(
				plan.incomingServers.map((entry) => entry.raw),
				incoming
			);
			// The misconfigured-but-labeled entry imports (its report carries the
			// problems for the preview); only label-less entries cannot.
			const broken = plan.incomingServers[4];
			assert.ok(broken !== undefined && !broken.skipped && broken.report.problems.length > 0);
			assert.strictEqual(broken.report.accepted, false);
		});

		test("an entry whose auth cannot be certified secret-free is skipped with the reason", () => {
			// Landing it would write the presumed credential into the settings
			// file, breaking the secrets-go-to-secure-storage promise.
			const incoming = [server("A"), server("Malformed", { auth: [{ apiKey: "sk-hidden" }] })];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, undefined);
			assert.deepStrictEqual(
				plan.incomingServers.map((entry) => entry.skipped),
				[false, true]
			);
			const malformed = plan.incomingServers[1];
			assert.ok(malformed !== undefined);
			assert.strictEqual(malformed.report.accepted, false);
			assert.ok(malformed.report.problems.some((problem) => problem.includes("secret storage")));
			// Skipped whole: no collision, no landing, no secret write.
			const application = resolveImportPlan(plan, {});
			assert.deepStrictEqual(application.counts, { imported: 1, overwritten: 0, renamed: 0, skipped: 1 });
			assert.ok(!JSON.stringify(application.serversValue).includes("sk-hidden"));
			assert.deepStrictEqual(
				application.secretWrites.map((write) => write.label),
				["A"]
			);
		});

		test("a skipped uncertifiable entry does not shadow a valid same-label entry's fingerprint", () => {
			// The skipped element stays out of the fingerprint parse; the valid
			// element resolution lands is the one the collision compares.
			const incoming = [server("A", { auth: [{ apiKey: "sk-hidden" }] }), server("A")];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, [server("A")]);
			assert.deepStrictEqual(plan.collisions, [{ label: "A", connectionChanged: false }]);
			const application = resolveImportPlan(plan, { A: { action: "overwrite" } });
			assert.deepStrictEqual(application.counts, { imported: 0, overwritten: 1, renamed: 0, skipped: 1 });
			assert.deepStrictEqual(application.serversValue, [server("A")]);
		});

		test("collisions are the importable labels already declared, deduplicated, in file order", () => {
			const current = [server("A"), server("B"), { label: "C ", baseUrl: "" }];
			const incoming = [server("C"), server("New"), server("A"), server("A", { budget: 5 })];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, current);
			assert.deepStrictEqual(
				plan.collisions.map((collision) => collision.label),
				["C", "A"]
			);
		});

		test("connectionChanged is false for an identical entry and for model-record-only edits", () => {
			const current = [server("A", { auth: { apiKey: "sk-1" } })];
			const identical = planSettingsImport(
				{ [SERVERS_SETTING_KEY]: [server("A", { auth: { apiKey: "sk-1" } })] },
				current
			);
			assert.deepStrictEqual(identical.collisions, [{ label: "A", connectionChanged: false }]);

			// Fields buildGroupArgs excludes (models, headers, discovery, budget)
			// never churn the group, so they must not flag.
			const recordsOnly = planSettingsImport(
				{
					[SERVERS_SETTING_KEY]: [
						server("A", {
							auth: { apiKey: "sk-1" },
							models: { parameters: { "*": { temperature: 0 } } },
							headers: { "x-team": "core" },
							budget: 50,
						}),
					],
				},
				current
			);
			assert.deepStrictEqual(recordsOnly.collisions, [{ label: "A", connectionChanged: false }]);

			// The false direction of the buildGroupArgs agreement: a flag of
			// false means the engine's own args rendering is identical too.
			const currentEntry = acceptedEntry(current, "A")?.entry;
			const recordsOnlyServers = recordsOnly.incomingServers.map((entry) => entry.raw);
			const recordsOnlyEntry = acceptedEntry(recordsOnlyServers, "A")?.entry;
			assert.ok(currentEntry !== undefined && recordsOnlyEntry !== undefined);
			assert.strictEqual(
				JSON.stringify(buildGroupArgs(recordsOnlyEntry, {})),
				JSON.stringify(buildGroupArgs(currentEntry, {}))
			);
		});

		test("connectionChanged flags baseUrl and auth-material changes, agreeing with buildGroupArgs", () => {
			const current = [server("A", { auth: { apiKey: "sk-1" } })];
			const variants: readonly Record<string, unknown>[] = [
				{ ...server("A", { auth: { apiKey: "sk-1" } }), baseUrl: "http://moved.test" },
				server("A", { auth: { apiKey: "sk-2" } }),
				server("A"),
				server("A", { auth: { virtualKey: { header: "x-key", value: "vk" } } }),
				server("A", { auth: { oauth: { tokenUrl: "http://idp.test", clientId: "c" } } }),
			];
			for (const variant of variants) {
				const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [variant] }, current);
				assert.deepStrictEqual(plan.collisions, [{ label: "A", connectionChanged: true }], JSON.stringify(variant));
				// The flag must agree with the engine's own args rendering: with no
				// stored secrets, group args differ exactly when the flag says so.
				const currentEntry = acceptedEntry(current, "A")?.entry;
				const incomingEntry = acceptedEntry([variant], "A")?.entry;
				assert.ok(currentEntry !== undefined && incomingEntry !== undefined);
				assert.notStrictEqual(
					JSON.stringify(buildGroupArgs(incomingEntry, {})),
					JSON.stringify(buildGroupArgs(currentEntry, {}))
				);
			}
		});

		test("a side that does not parse flags the collision; two unparseable sides do not", () => {
			const misconfigured = server("A", { auth: { unknownKey: true } });
			const valid = server("A");
			assert.deepStrictEqual(planSettingsImport({ [SERVERS_SETTING_KEY]: [valid] }, [misconfigured]).collisions, [
				{ label: "A", connectionChanged: true },
			]);
			assert.deepStrictEqual(planSettingsImport({ [SERVERS_SETTING_KEY]: [misconfigured] }, [valid]).collisions, [
				{ label: "A", connectionChanged: true },
			]);
			assert.deepStrictEqual(
				planSettingsImport({ [SERVERS_SETTING_KEY]: [misconfigured] }, [misconfigured]).collisions,
				[{ label: "A", connectionChanged: false }]
			);
		});

		test("storedSecrets stops the over-report when a secret merely moves between inline and SecretStorage", () => {
			const current = [server("A")];
			const incoming = [server("A", { auth: { apiKey: "sk-1" } })];
			// Inline-only comparison (no blobs supplied) cannot tell and flags.
			assert.deepStrictEqual(planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, current).collisions, [
				{ label: "A", connectionChanged: true },
			]);
			// With the label's blob supplied, the effective material is equal.
			assert.deepStrictEqual(
				planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, current, { A: { apiKey: "sk-1" } }).collisions,
				[{ label: "A", connectionChanged: false }]
			);
		});

		test("storedSecrets keeps the true positives true", () => {
			const current = [server("A")];
			// A different stored value still flags.
			assert.deepStrictEqual(
				planSettingsImport({ [SERVERS_SETTING_KEY]: [server("A", { auth: { apiKey: "sk-2" } })] }, current, {
					A: { apiKey: "sk-1" },
				}).collisions,
				[{ label: "A", connectionChanged: true }]
			);
			// A secret-less incoming entry against a stored secret still flags:
			// the overwrite clears the label's blob.
			assert.deepStrictEqual(
				planSettingsImport({ [SERVERS_SETTING_KEY]: [server("A")] }, current, { A: { apiKey: "sk-1" } }).collisions,
				[{ label: "A", connectionChanged: true }]
			);
			// The current side's inline value wins over the supplied blob,
			// mirroring buildGroupArgs.
			assert.deepStrictEqual(
				planSettingsImport(
					{ [SERVERS_SETTING_KEY]: [server("A", { auth: { apiKey: "sk-inline" } })] },
					[server("A", { auth: { apiKey: "sk-inline" } })],
					{ A: { apiKey: "sk-other" } }
				).collisions,
				[{ label: "A", connectionChanged: false }]
			);
		});

		test("storedSecrets under an Object.prototype member name resolves via hasOwn, never the prototype", () => {
			// The blob record INHERITS a "toString" entry carrying a secret: a plain
			// index read would find it and wrongly flag the collision.
			const entry = server("toString");
			const inherited = Object.create({ toString: { apiKey: "sk-ghost" } }) as Readonly<
				Record<string, StoredServerSecrets>
			>;
			const collisions = planSettingsImport({ [SERVERS_SETTING_KEY]: [entry] }, [entry], inherited).collisions;
			assert.deepStrictEqual(collisions, [{ label: "toString", connectionChanged: false }]);
		});

		test("secretFieldCount counts inline secret values across importable entries only", () => {
			const incoming = [
				server("A", { auth: { apiKey: "sk-1", virtualKey: { header: "x-key", value: "vk-1" } } }),
				{ baseUrl: "http://nolabel.test", auth: { apiKey: "sk-skipped" } },
				server("B", { auth: { oauth: { tokenUrl: "http://idp.test", clientId: "c", clientSecret: "cs" } } }),
			];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, undefined);
			assert.strictEqual(plan.secretFieldCount, 3);
		});

		test("currentServersRaw is carried verbatim", () => {
			const current = [server("A")];
			assert.strictEqual(planSettingsImport({}, current).currentServersRaw, current);
		});
	});

	suite("resolveImportPlan", () => {
		test("overwrite replaces in place: same index, label unchanged, neighbors byte-identical", () => {
			const current = [server("A"), server("B", { auth: { apiKey: "sk-b" } }), server("C")];
			const incomingB = server("B", { baseUrl: "http://new-b.test", auth: { apiKey: "sk-new" } });
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [incomingB] }, current);
			const application = resolveImportPlan(plan, { B: { action: "overwrite" } });
			assert.deepStrictEqual(application.serversValue, [
				current[0],
				{ label: "B", baseUrl: "http://new-b.test" },
				current[2],
			]);
			// Existing non-colliding entries ride through by reference: never
			// mutated, never reordered.
			assert.strictEqual(application.serversValue?.[0], current[0]);
			assert.strictEqual(application.serversValue?.[2], current[2]);
			assert.deepStrictEqual(application.secretWrites, [
				{
					label: "B",
					secrets: { apiKey: "sk-new" },
					owners: { apiKey: "http://new-b.test" },
					restamps: {},
					guardedClears: {},
				},
			]);
			assert.deepStrictEqual(application.touchedLabels, ["B"]);
			assert.deepStrictEqual(application.counts, { imported: 0, overwritten: 1, renamed: 0, skipped: 0 });
		});

		test("new and renamed entries append at the end in file order", () => {
			const current = [server("A")];
			const incoming = [server("New1"), server("A", { budget: 5 }), server("New2")];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, current);
			const application = resolveImportPlan(plan, { A: { action: "rename", newLabel: "A-imported" } });
			assert.deepStrictEqual(application.serversValue, [
				current[0],
				server("New1"),
				{ ...server("A", { budget: 5 }), label: "A-imported" },
				server("New2"),
			]);
			assert.deepStrictEqual(application.touchedLabels, ["New1", "A-imported", "New2"]);
			assert.deepStrictEqual(application.counts, { imported: 2, overwritten: 0, renamed: 1, skipped: 0 });
			// The renamed entry's secrets go under the NEW label.
			assert.deepStrictEqual(
				application.secretWrites.map((write) => write.label),
				["New1", "A-imported", "New2"]
			);
		});

		test("a skip decision drops the entry entirely", () => {
			const current = [server("A", { budget: 1 })];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [server("A", { budget: 2 })] }, current);
			const application = resolveImportPlan(plan, { A: { action: "skip" } });
			assert.strictEqual(application.serversValue, undefined);
			assert.deepStrictEqual(application.secretWrites, []);
			assert.deepStrictEqual(application.touchedLabels, []);
			assert.deepStrictEqual(application.counts, { imported: 0, overwritten: 0, renamed: 0, skipped: 1 });
		});

		test("serversValue is undefined when the file carries no servers key", () => {
			const application = resolveImportPlan(planSettingsImport({ "chat.timeout": 1 }, [server("A")]), {});
			assert.strictEqual(application.serversValue, undefined);
			assert.deepStrictEqual(application.settingsWrites, [{ key: "chat.timeout", value: 1 }]);
		});

		test("every landing entry is stripped and emits a secret write, empty blobs included", () => {
			const incoming = [server("Keys", { auth: { apiKey: "sk-1" } }), server("NoKeys")];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, undefined);
			const application = resolveImportPlan(plan, {});
			assert.deepStrictEqual(application.serversValue, [server("Keys"), server("NoKeys")]);
			// The empty record still matters at apply time: stale blob fields not
			// among the writes are cleared.
			assert.deepStrictEqual(application.secretWrites, [
				{
					label: "Keys",
					secrets: { apiKey: "sk-1" },
					owners: { apiKey: "http://keys.test" },
					restamps: {},
					guardedClears: {},
				},
				{ label: "NoKeys", secrets: {}, owners: {}, restamps: {}, guardedClears: {} },
			]);
			assert.ok(!JSON.stringify(application.serversValue).includes("sk-1"));
		});

		test("an entry's non-secret fields ride through verbatim, the mcp opt-in included", () => {
			// Secret surgery rewrites the auth object and nothing else: a new
			// per-entry field must survive an export/import round trip without
			// joining any allow-list, or a user moving machines would silently
			// lose it.
			const incoming = [
				server("Derived", { auth: { apiKey: "sk-1" }, mcp: true, budget: 25 }),
				server("Named", { mcp: { url: "https://gw.example/tools/mcp" } }),
			];
			const application = resolveImportPlan(planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, undefined), {});
			assert.deepStrictEqual(application.serversValue, [
				server("Derived", { mcp: true, budget: 25 }),
				server("Named", { mcp: { url: "https://gw.example/tools/mcp" } }),
			]);
		});

		test("a pre-redesign flat entry lands restructured, its flat secrets moved to secret storage", () => {
			// Old-format export files (flat credential fields, envelope v1) must
			// keep importing AND work immediately: the entry lands in the current
			// shape (the same restructure the activation migration applies), so
			// its group never syncs credential-less while waiting for the next
			// activation. The lone oauthTokenUrl is a partial OAuth the old
			// runtime ignored; the restructure drops it like the migration does.
			const incoming = [server("Old", { apiKey: "sk-test-flat", oauthTokenUrl: "http://idp.test/token" })];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, undefined);
			assert.strictEqual(plan.incomingServers[0]?.skipped, false, "the flat shape must not be skipped");
			const application = resolveImportPlan(plan, {});
			assert.deepStrictEqual(application.serversValue, [server("Old")]);
			assert.deepStrictEqual(application.secretWrites, [
				{
					label: "Old",
					secrets: { apiKey: "sk-test-flat" },
					owners: { apiKey: "http://old.test" },
					restamps: {},
					guardedClears: {},
				},
			]);
			assert.strictEqual(application.counts.imported, 1);
			assert.ok(!JSON.stringify(application.serversValue).includes("sk-test-flat"));
		});

		test("a pre-redesign flat OAuth export lands new-shaped with its client secret paired to the token URL", () => {
			const incoming = [
				server("Old", {
					oauthTokenUrl: "http://idp.test/token",
					oauthClientId: "cid",
					oauthClientSecret: "cs-test-1",
				}),
			];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, undefined);
			const application = resolveImportPlan(plan, {});
			assert.deepStrictEqual(application.serversValue, [
				{ ...server("Old"), auth: { oauth: { tokenUrl: "http://idp.test/token", clientId: "cid" } } },
			]);
			// The ownership stamp pairs the moved client secret with the token URL
			// the restructured entry actually sends it to; pre-restructure the
			// entry parsed credential-less and the stamp would have refused it.
			assert.deepStrictEqual(application.secretWrites, [
				{
					label: "Old",
					secrets: { oauthClientSecret: "cs-test-1" },
					owners: { oauthClientSecret: "http://idp.test/token" },
					restamps: {},
					guardedClears: {},
				},
			]);
			assert.ok(!JSON.stringify(application.serversValue).includes("cs-test-1"));
		});

		test("plan-skipped entries and within-file duplicate labels count as skipped", () => {
			const incoming = [server("A"), { baseUrl: "http://nolabel.test" }, server("A", { budget: 9 })];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, undefined);
			const application = resolveImportPlan(plan, {});
			// The parser's first-entry-wins rule: the duplicate could never take
			// effect, so it drops rather than landing a shadowed sibling.
			assert.deepStrictEqual(application.serversValue, [server("A")]);
			assert.deepStrictEqual(application.counts, { imported: 1, overwritten: 0, renamed: 0, skipped: 2 });
		});

		test("a baseUrl-less fragment never shadows a valid same-label sibling, matching the parser's claim rule", () => {
			// parseServersSetting would ignore the fragment (no usable baseUrl, so it
			// claims no label); the import must land the entry the parser acts on.
			const fragment = { label: "A", auth: { apiKey: "sk-frag" } };
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [fragment, server("A", { budget: 7 })] }, undefined);
			assert.strictEqual(plan.secretFieldCount, 0, "only the representative's inline secrets count");
			const application = resolveImportPlan(plan, {});
			assert.deepStrictEqual(application.serversValue, [server("A", { budget: 7 })]);
			assert.deepStrictEqual(application.secretWrites, [
				{ label: "A", secrets: {}, owners: {}, restamps: {}, guardedClears: {} },
			]);
			assert.deepStrictEqual(application.counts, { imported: 1, overwritten: 0, renamed: 0, skipped: 1 });

			// With no claiming sibling, the fragment itself still imports.
			const alone = resolveImportPlan(planSettingsImport({ [SERVERS_SETTING_KEY]: [fragment] }, undefined), {});
			assert.deepStrictEqual(alone.serversValue, [{ label: "A" }]);
			// The fragment has no usable baseUrl, so its secret is stamped for no
			// destination ("") and stays refused until a deliberate re-pairing.
			assert.deepStrictEqual(alone.secretWrites, [
				{ label: "A", secrets: { apiKey: "sk-frag" }, owners: { apiKey: "" }, restamps: {}, guardedClears: {} },
			]);
		});

		test("a garbage current servers value is replaced by the merged array instead of crashing", () => {
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [server("A")] }, "corrupted");
			const application = resolveImportPlan(plan, {});
			assert.deepStrictEqual(application.serversValue, [server("A")]);
			assert.deepStrictEqual(application.counts, { imported: 1, overwritten: 0, renamed: 0, skipped: 0 });
		});

		test("a rename target the flow should have rejected resolves to skip instead of clobbering", () => {
			const current = [server("A"), server("B", { auth: { apiKey: "sk-b" } })];
			for (const newLabel of ["B", "A", "__proto__", "", "   "]) {
				const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [server("A", { budget: 2 })] }, current);
				const application = resolveImportPlan(plan, { A: { action: "rename", newLabel } });
				assert.strictEqual(application.serversValue, undefined, `newLabel=${JSON.stringify(newLabel)}`);
				assert.deepStrictEqual(application.secretWrites, []);
				assert.deepStrictEqual(application.counts, { imported: 0, overwritten: 0, renamed: 0, skipped: 1 });
			}
		});

		test("a padded rename target is trimmed into both the entry and its secret-write label", () => {
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [server("A", { auth: { apiKey: "sk" } })] }, [
				server("A"),
			]);
			const application = resolveImportPlan(plan, { A: { action: "rename", newLabel: "  A-new  " } });
			assert.deepStrictEqual(application.serversValue, [server("A"), { ...server("A"), label: "A-new" }]);
			assert.deepStrictEqual(application.secretWrites, [
				{
					label: "A-new",
					secrets: { apiKey: "sk" },
					owners: { apiKey: "http://a.test" },
					restamps: {},
					guardedClears: {},
				},
			]);
			assert.deepStrictEqual(application.touchedLabels, ["A-new"]);
		});

		test("a colliding label named after an Object.prototype member falls back to skip, never to the inherited method", () => {
			// A plain index read of decisions["toString"] would return the
			// inherited function instead of the missing-decision fallback.
			const label = "toString";
			const current = [server(label)];
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [server(label, { budget: 2 })] }, current);
			assert.deepStrictEqual(
				plan.collisions.map((collision) => collision.label),
				[label]
			);
			const application = resolveImportPlan(plan, {});
			assert.strictEqual(application.serversValue, undefined);
			assert.deepStrictEqual(application.counts, { imported: 0, overwritten: 0, renamed: 0, skipped: 1 });
			// With a real decision under the same label, it resolves normally.
			const decisions: CollisionDecisions = { [label]: { action: "overwrite" as const } };
			const overwrite = resolveImportPlan(plan, decisions);
			assert.deepStrictEqual(overwrite.counts, { imported: 0, overwritten: 1, renamed: 0, skipped: 0 });
			assert.deepStrictEqual(overwrite.touchedLabels, [label]);
		});
	});

	suite("staleStoredKeyFields and keepStoredFields", () => {
		/** A plan whose overwrite of "A" re-points the base URL; the label's blob holds a stamped key. */
		function repointedPlan(incomingExtra: Record<string, unknown> = {}): ImportPlan {
			return planSettingsImport(
				{ [SERVERS_SETTING_KEY]: [{ label: "A", baseUrl: "http://new.test", ...incomingExtra }] },
				[{ label: "A", baseUrl: "http://old.test" }]
			);
		}
		const stampedRecord: StoredSecretsRecord = {
			values: { apiKey: "sk-old" },
			owners: { apiKey: "http://old.test" },
		};

		test("a stale-stamped stored field the file does not carry is exactly the question's field set", () => {
			assert.deepStrictEqual(staleStoredKeyFields(repointedPlan(), "A", stampedRecord), ["apiKey"]);
		});

		test("no question when the file carries the field, the stamp matches, or the value is unstamped", () => {
			// The file's own value overwrites with a fresh stamp; nothing to ask.
			const carried = repointedPlan({ auth: { apiKey: "sk-new" } });
			assert.deepStrictEqual(staleStoredKeyFields(carried, "A", stampedRecord), []);
			// The stamp already names the imported destination.
			const matching: StoredSecretsRecord = { values: { apiKey: "sk-old" }, owners: { apiKey: "http://new.test" } };
			assert.deepStrictEqual(staleStoredKeyFields(repointedPlan(), "A", matching), []);
			// Unstamped values predate stamping and keep the plan's default clear.
			const unstamped: StoredSecretsRecord = { values: { apiKey: "sk-old" }, owners: {} };
			assert.deepStrictEqual(staleStoredKeyFields(repointedPlan(), "A", unstamped), []);
		});

		test("an incoming entry that does not parse has no derivable destination, so no question", () => {
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [{ label: "A", baseUrl: 42, budget: 1 }] }, [
				{ label: "A", baseUrl: "http://old.test" },
			]);
			assert.deepStrictEqual(staleStoredKeyFields(plan, "A", stampedRecord), []);
		});

		test("a use-same consent rides the overwrite into a restamp write: imported destination, consent stamp recorded", () => {
			const plan = repointedPlan();
			const application = resolveImportPlan(plan, {
				A: { action: "overwrite", staleKeyConsent: { answer: "use-same", stamps: { apiKey: "http://old.test" } } },
			});
			assert.deepStrictEqual(application.secretWrites, [
				{
					label: "A",
					secrets: {},
					owners: { apiKey: "http://new.test" },
					restamps: { apiKey: "http://old.test" },
					guardedClears: {},
				},
			]);
			assert.deepStrictEqual(application.serversValue, [{ label: "A", baseUrl: "http://new.test" }]);
		});

		test("a clear consent rides as a guarded clear, keyed to the same recorded stamp", () => {
			const application = resolveImportPlan(repointedPlan(), {
				A: { action: "overwrite", staleKeyConsent: { answer: "clear", stamps: { apiKey: "http://old.test" } } },
			});
			assert.deepStrictEqual(application.secretWrites, [
				{
					label: "A",
					secrets: {},
					owners: {},
					restamps: {},
					guardedClears: { apiKey: "http://old.test" },
				},
			]);
		});

		test("an incoming entry without the virtual key header never asks about a live stored value", () => {
			// The imported entry cannot send the value (no header names it), so
			// the documented clear-as-stale stands; declaring the header makes the
			// question real.
			const record: StoredSecretsRecord = {
				values: { virtualKeyValue: "vk-live" },
				owners: { virtualKeyValue: "http://old.test" },
			};
			const current = [{ label: "A", baseUrl: "http://old.test", auth: { virtualKey: { header: "x-key" } } }];
			const headerless = planSettingsImport(
				{ [SERVERS_SETTING_KEY]: [{ label: "A", baseUrl: "http://new.test" }] },
				current
			);
			assert.deepStrictEqual(staleStoredKeyFields(headerless, "A", record), []);
			const headed = planSettingsImport(
				{
					[SERVERS_SETTING_KEY]: [
						{ label: "A", baseUrl: "http://new.test", auth: { virtualKey: { header: "x-key" } } },
					],
				},
				current
			);
			assert.deepStrictEqual(staleStoredKeyFields(headed, "A", record), ["virtualKeyValue"]);
		});

		test("an overwrite without a stale-key consent keeps the default clear-by-omission write", () => {
			const application = resolveImportPlan(repointedPlan(), { A: { action: "overwrite" } });
			assert.deepStrictEqual(application.secretWrites, [
				{ label: "A", secrets: {}, owners: {}, restamps: {}, guardedClears: {} },
			]);
		});

		test("a dormant stored value the standing entry never resolved keeps the default clear, unasked", () => {
			// The stamp names neither the current nor the imported destination:
			// the overwrite re-points nothing the label was actually serving, so
			// the documented clear-as-stale stands without a question.
			const dormant: StoredSecretsRecord = {
				values: { apiKey: "sk-dormant" },
				owners: { apiKey: "http://elsewhere.test" },
			};
			assert.deepStrictEqual(staleStoredKeyFields(repointedPlan(), "A", dormant), []);
		});

		test("an incoming entry that does not use the field asks nothing about it", () => {
			// A stored client secret is live for the current OAuth entry, but the
			// imported entry has no token URL: nothing to re-pair the value with.
			const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: [{ label: "A", baseUrl: "http://x.test" }] }, [
				{
					label: "A",
					baseUrl: "http://x.test",
					auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "cid" } },
				},
			]);
			const live: StoredSecretsRecord = {
				values: { oauthClientSecret: "cs-live" },
				owners: { oauthClientSecret: "https://idp.test/token" },
			};
			assert.deepStrictEqual(staleStoredKeyFields(plan, "A", live), []);
		});
	});

	suite("suggestRenamedLabel", () => {
		test("suffixes -imported, then counts up from 2 to the first free name", () => {
			assert.strictEqual(suggestRenamedLabel("A", new Set(["A"])), "A-imported");
			assert.strictEqual(suggestRenamedLabel("A", new Set(["A", "A-imported"])), "A-imported-2");
			assert.strictEqual(
				suggestRenamedLabel("A", new Set(["A", "A-imported", "A-imported-2", "A-imported-3"])),
				"A-imported-4"
			);
		});
	});
});
