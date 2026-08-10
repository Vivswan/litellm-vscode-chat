import * as assert from "node:assert";
import * as fc from "fast-check";
import { buildGroupArgs } from "../../../extension/servers/serverSync/engine";
import type { StoredServerSecrets } from "../../../extension/servers/serverSync/secrets";
import {
	acceptedEntry,
	parseServersSetting,
	serverSettingReports,
} from "../../../extension/servers/serverSync/setting";
import { parseEnvelope } from "../../../extension/settingsTransfer/envelope";
import { buildSettingsExport } from "../../../extension/settingsTransfer/exportBuild";
import type { CollisionDecision, CollisionDecisions } from "../../../extension/settingsTransfer/importPlan";
import {
	planSettingsImport,
	resolveImportPlan,
	suggestRenamedLabel,
} from "../../../extension/settingsTransfer/importPlan";
import { materializeEntrySecrets, stripEntrySecrets } from "../../../extension/settingsTransfer/secretSurgery";
import { buildPreImportSnapshot, planSnapshotRestore } from "../../../extension/settingsTransfer/snapshot";
import { ALL_SETTING_KEYS, SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

/**
 * The settings-transfer core's four load-bearing properties: secret surgery
 * is lossless for the parser's view of an entry (and stripping never invents
 * a diagnostic), a full export -> parse -> plan -> apply round trip against
 * an empty target reproduces the original configuration up to the documented
 * secret handling (with the group-args equivalence as the oracle, so wire
 * behavior - not just bytes - is pinned), a snapshot restore is an exact
 * inverse over any divergent post-import state, and resolveImportPlan's
 * merge invariants hold under arbitrary garbage and arbitrary decisions.
 */

const LABEL_POOL = ["alpha", "beta", "gamma", "delta", "epsilon"] as const;

function compact(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

const optionalInline = (values: readonly string[]) => fc.option(fc.constantFrom(...values), { nil: undefined });

/** A grammar-valid virtualKey object, its secret value optional and possibly padded. */
const validVirtualKeyArb = fc
	.record({ value: optionalInline(["vk-inline", " vk-padded "]) })
	.map(({ value }) => compact({ header: "x-litellm-key", value }));

/** A grammar-valid oauth unit with optional secrets and companions. */
const validOAuthArb = fc
	.record({
		clientSecret: optionalInline(["cs-inline", " cs-padded "]),
		scopes: optionalInline(["read write"]),
		apiKey: optionalInline(["companion-inline"]),
		virtualKey: fc.option(validVirtualKeyArb, { nil: undefined }),
	})
	.map((fields) => compact({ tokenUrl: "http://idp.test/token", clientId: "client-1", ...fields }));

/** A grammar-valid auth object of every form (or none), so every entry parses. */
const validAuthArb = fc.oneof(
	fc.constant(undefined),
	fc.record({ apiKey: fc.constantFrom("sk-inline", " sk-padded ", "") }),
	fc.record({ apiKey: optionalInline(["sk-inline"]), virtualKey: validVirtualKeyArb }).map((auth) => compact(auth)),
	validOAuthArb.map((oauth) => ({ oauth }))
);

function validEntryArb(label: string): fc.Arbitrary<Record<string, unknown>> {
	return fc
		.record({
			auth: validAuthArb,
			budget: fc.option(fc.constantFrom(5, 50), { nil: undefined }),
			models: fc.option(fc.constant({ parameters: { "gpt-*": { temperature: 0 } } }), { nil: undefined }),
		})
		.map((fields) => compact({ label, baseUrl: `http://${label}.test`, ...fields }));
}

/** A servers array of unique-label, grammar-valid entries. */
const validServersArb: fc.Arbitrary<Record<string, unknown>[]> = fc
	.uniqueArray(fc.constantFrom(...LABEL_POOL), { maxLength: LABEL_POOL.length })
	.chain((labels) =>
		labels.length === 0 ? fc.constant([]) : fc.tuple(...labels.map((label) => validEntryArb(label)))
	);

/**
 * Stored blob values stay unpadded here on purpose: the inline settings
 * grammar trims, so a padded STORED value is not representable in an export
 * file (materialize places it verbatim, but the reimport parses it trimmed);
 * secretSurgery.test.ts pins the verbatim placement itself.
 */
const blobArb: fc.Arbitrary<StoredServerSecrets> = fc
	.record({
		apiKey: optionalInline(["sk-stored"]),
		oauthClientSecret: optionalInline(["cs-stored"]),
		virtualKeyValue: optionalInline(["vk-stored"]),
	})
	.map((blob) => compact(blob) as StoredServerSecrets);

const blobsByLabelArb = fc.dictionary(fc.constantFrom(...LABEL_POOL), blobArb, { maxKeys: LABEL_POOL.length });

/** Junk-heavy raw entries for the robustness sides (the same style as the setting parser's property suite). */
const junkEntryArb = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.constantFrom(...LABEL_POOL, "toString", "__proto__", "", "  ", undefined).chain((label) =>
			fc
				.record({
					baseUrl: fc.constantFrom<unknown>("http://one.test", "", 42, undefined),
					auth: fc.oneof(
						validAuthArb,
						fc.constantFrom<unknown>(
							{},
							{ unknownKey: "x" },
							{ apiKey: 42 },
							{ apiKey: "sk", oauth: { tokenUrl: "http://idp.test", clientId: "c", apiKey: "inner" } },
							{ virtualKey: { value: "vk-only" } },
							{ oauth: { tokenUrl: "http://idp.test", clientId: "c", virtualKey: { header: "x-b", value: "nested" } } },
							"auth-as-string",
							42
						)
					),
					budget: fc.constantFrom<unknown>(undefined, 5, "junk"),
				})
				.map((fields) => compact({ label, ...fields }))
		),
	},
	{ weight: 1, arbitrary: fc.constantFrom<unknown>("junk", 42, null, [], { nested: true }) }
);

const junkServersArb = fc.array(junkEntryArb, { maxLength: 6 });

suite("extension/settingsTransfer property: secret surgery", () => {
	test("strip then materialize restores the parser's view; stripping never invents a diagnostic", () => {
		fc.assert(
			fc.property(fc.clone(junkServersArb, 2), ([rawEntries, pristine]) => {
				for (let index = 0; index < rawEntries.length; index += 1) {
					const raw = rawEntries[index];
					if (!isRecord(raw)) {
						continue;
					}
					const stripped = stripEntrySecrets(raw);
					// The stripped entry never carries an inline secret value, and a
					// second strip finds nothing (idempotence) - the certification
					// verdict included.
					const again = stripEntrySecrets(stripped.entry);
					assert.deepStrictEqual(again.secrets, {});
					assert.deepStrictEqual(again.entry, stripped.entry);
					assert.strictEqual(again.unsanitizable, stripped.unsanitizable);

					// Stripping never degrades an entry. An accepted entry stays
					// accepted with identical diagnostics. A rejected entry either
					// keeps a subset of its problems or heals: stripping an
					// ambiguous companion (oauth beside a sibling apiKey) is
					// mandatory - a secret must never survive a no-secrets export -
					// and can only turn a misconfigured shape valid, unmasking the
					// downstream diagnostics the parser's early return had hidden.
					const beforeReport = serverSettingReports([raw])[0];
					const afterReport = serverSettingReports([stripped.entry])[0];
					const before = beforeReport?.problems ?? [];
					const after = afterReport?.problems ?? [];
					if (beforeReport?.accepted === true) {
						assert.strictEqual(afterReport?.accepted, true, "stripping must never reject an accepted entry");
						assert.deepStrictEqual(after, before);
					} else {
						const authRejected = before.some((problem) => problem.includes("is misconfigured"));
						for (const problem of after) {
							assert.ok(before.includes(problem) || authRejected, `stripping invented: ${problem}`);
						}
					}

					// For an entry the parser accepts, strip -> materialize with the
					// extracted blob is lossless in the parsed view and places
					// every field (nothing unmaterialized). Accepted entries may
					// still carry non-fatal diagnostics (an ignored junk budget,
					// say); the round trip preserves those exactly, never clears
					// or invents them.
					const originalParse = parseServersSetting([raw]);
					if (originalParse.entries.length === 1) {
						const restored = materializeEntrySecrets(stripped.entry, stripped.secrets);
						assert.strictEqual(restored.unmaterialized, 0);
						const restoredParse = parseServersSetting([restored.entry]);
						assert.deepStrictEqual(restoredParse.problems, originalParse.problems);
						assert.deepStrictEqual(restoredParse.entries, originalParse.entries);
					}
				}
				assert.deepStrictEqual(rawEntries, pristine, "surgery must never mutate its input");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("extension/settingsTransfer property: export -> import round trip", () => {
	const nonServersStateArb = fc
		.record(
			{
				"chat.timeout": fc.integer({ min: 1000, max: 1_000_000 }),
				"discovery.cacheTtl": fc.integer({ min: 0, max: 100_000 }),
				"chat.promptCaching": fc.boolean(),
				"ui.maskSecretInputs": fc.boolean(),
				"usage.statusBar": fc.constantFrom("always", "alerts-only", "off"),
				"models.parameters": fc.constant({ "gpt-*": { temperature: 0.5 } }),
				"usage.alertThresholds": fc.constant([0.5, 0.9]),
			},
			{ requiredKeys: [] }
		)
		.map((state) => compact(state));

	test("applying the plan to an empty target reproduces the original configuration and wire behavior", async () => {
		await fc.assert(
			fc.asyncProperty(
				nonServersStateArb,
				fc.option(validServersArb, { nil: undefined }),
				blobsByLabelArb,
				fc.boolean(),
				async (nonServers, servers, blobs, includeSecrets) => {
					const state: Record<string, unknown> = { ...nonServers };
					if (servers !== undefined) {
						state[SERVERS_SETTING_KEY] = servers;
					}
					const exported = await buildSettingsExport({
						readGlobalSetting: (key) => state[key],
						readServerSecrets: (label) => Promise.resolve(blobs[label] ?? {}),
						extensionVersion: "9.9.9",
						includeSecrets,
					});

					const parsed = parseEnvelope(JSON.stringify(exported.envelope));
					assert.ok(parsed.ok);
					assert.deepStrictEqual(parsed.unknownKeys, []);
					assert.strictEqual(parsed.exportedBy, "9.9.9");
					assert.strictEqual(exported.omittedUnsanitizableCount, 0, "record-only arrays never omit anything");

					const plan = planSettingsImport(parsed.settings, undefined);
					assert.deepStrictEqual(plan.skippedKeys, [], "an export of valid values never trips the type gate");
					assert.deepStrictEqual(plan.collisions, [], "an empty target has nothing to collide with");
					const application = resolveImportPlan(plan, {});

					// Non-servers keys reproduce exactly, absent keys stay absent.
					for (const key of ALL_SETTING_KEYS) {
						if (key === SERVERS_SETTING_KEY) {
							continue;
						}
						const written = application.settingsWrites.find((write) => write.key === key);
						assert.deepStrictEqual(written?.value, state[key], key);
					}

					if (servers === undefined || servers.length === 0) {
						assert.strictEqual(application.serversValue, undefined);
						return;
					}
					const applied = application.serversValue;
					assert.ok(applied !== undefined);
					assert.strictEqual(application.counts.imported, servers.length);

					const originalParse = parseServersSetting(servers);
					const appliedParse = parseServersSetting([...applied]);
					assert.deepStrictEqual(appliedParse.problems, []);
					assert.deepStrictEqual(
						appliedParse.entries.map((entry) => entry.label),
						originalParse.entries.map((entry) => entry.label)
					);

					for (const original of originalParse.entries) {
						const appliedEntry = appliedParse.entries.find((entry) => entry.label === original.label);
						const write = application.secretWrites.find((candidate) => candidate.label === original.label);
						assert.ok(appliedEntry !== undefined && write !== undefined);
						const blob = blobs[original.label] ?? {};

						if (!includeSecrets) {
							// No placeholders, no secrets: the applied entry is the
							// stripped original, and the effective group args are the
							// original's minus every secret field.
							assert.deepStrictEqual(write.secrets, {});
							const expected = Object.fromEntries(
								Object.entries(buildGroupArgs(original, {})).filter(
									([key]) => !(SECRET_FIELD_IDS as readonly string[]).includes(key)
								)
							);
							assert.deepStrictEqual(buildGroupArgs(appliedEntry, {}), expected);
							continue;
						}

						// With secrets: the written blob is the original EFFECTIVE
						// value per field - inline (trimmed) beats stored - for every
						// field the entry's shape gives a home; homeless stored
						// fields are the unmaterialized ones.
						const legal = (field: (typeof SECRET_FIELD_IDS)[number]): boolean =>
							field === "apiKey" ||
							(field === "oauthClientSecret" && original.oauthTokenUrl !== undefined) ||
							(field === "virtualKeyValue" && original.virtualKeyHeader !== undefined);
						const expectedSecrets: Record<string, string> = {};
						for (const field of SECRET_FIELD_IDS) {
							const effective = original[field] ?? (legal(field) ? blob[field] : undefined);
							if (effective !== undefined) {
								expectedSecrets[field] = effective;
							}
						}
						assert.deepStrictEqual({ ...write.secrets }, expectedSecrets);
						// The group args after import (stripped entry + written blob)
						// match the original's with its homeless stored fields dropped.
						const prunedBlob = Object.fromEntries(
							Object.entries(blob).filter(([field]) => legal(field as (typeof SECRET_FIELD_IDS)[number]))
						) as StoredServerSecrets;
						assert.deepStrictEqual(buildGroupArgs(appliedEntry, write.secrets), buildGroupArgs(original, prunedBlob));
					}

					if (includeSecrets) {
						// Every homeless stored field is counted, never guessed in.
						let expectedUnmaterialized = 0;
						for (const original of originalParse.entries) {
							const blob = blobs[original.label] ?? {};
							if (blob.oauthClientSecret !== undefined && original.oauthTokenUrl === undefined) {
								expectedUnmaterialized += 1;
							}
							if (blob.virtualKeyValue !== undefined && original.virtualKeyHeader === undefined) {
								expectedUnmaterialized += 1;
							}
						}
						assert.strictEqual(exported.unmaterializedSecretCount, expectedUnmaterialized);
					} else {
						assert.strictEqual(exported.secretFieldCount, 0);
						const rendered = JSON.stringify(exported.envelope);
						for (const sentinel of ["stored", "inline", "padded"]) {
							assert.ok(!rendered.includes(sentinel), `a "${sentinel}" value leaked into a no-secrets export`);
						}
					}
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a with-secrets self-import's collision flags agree with the engine's own args rendering", async () => {
		await fc.assert(
			fc.asyncProperty(validServersArb, blobsByLabelArb, async (servers, blobs) => {
				if (servers.length === 0) {
					return;
				}
				const exported = await buildSettingsExport({
					readGlobalSetting: (key) => (key === SERVERS_SETTING_KEY ? servers : undefined),
					readServerSecrets: (label) => Promise.resolve(blobs[label] ?? {}),
					extensionVersion: "9.9.9",
					includeSecrets: true,
				});
				const parsed = parseEnvelope(JSON.stringify(exported.envelope));
				assert.ok(parsed.ok);
				const incomingRaw = parsed.settings[SERVERS_SETTING_KEY];
				assert.ok(Array.isArray(incomingRaw));
				const incomingArray: readonly unknown[] = incomingRaw;
				const plan = planSettingsImport(parsed.settings, servers, blobs);
				assert.strictEqual(plan.collisions.length, servers.length, "every label self-collides");
				for (const collision of plan.collisions) {
					const currentEntry = acceptedEntry(servers, collision.label)?.entry;
					const incomingEntry = acceptedEntry(incomingArray, collision.label)?.entry;
					assert.ok(currentEntry !== undefined && incomingEntry !== undefined);
					// The flag's ground truth: would the group args the engine
					// builds actually change? The current side resolves against
					// the label's blob; the incoming side's inline values become
					// its blob at apply time, leaving its args as they parse.
					const argsChange =
						JSON.stringify(buildGroupArgs(incomingEntry, {})) !==
						JSON.stringify(buildGroupArgs(currentEntry, blobs[collision.label] ?? {}));
					assert.strictEqual(collision.connectionChanged, argsChange, collision.label);
				}
				// The headline no-false-positive case: when every stored field
				// found an inline home, a self-import changes nothing and no
				// collision may flag.
				if (exported.unmaterializedSecretCount === 0) {
					assert.deepStrictEqual(
						plan.collisions.filter((collision) => collision.connectionChanged),
						[]
					);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("extension/settingsTransfer property: snapshot restore", () => {
	const settingsStateArb = fc.dictionary(fc.constantFrom(...ALL_SETTING_KEYS), fc.jsonValue({ maxDepth: 2 }), {
		maxKeys: ALL_SETTING_KEYS.length,
	});
	const labelArb = fc.constantFrom(...LABEL_POOL, "renamed-imported", "brand-new");

	test("restore is an exact inverse over any divergent post-import state", async () => {
		await fc.assert(
			fc.asyncProperty(
				settingsStateArb,
				fc.dictionary(labelArb, blobArb, { maxKeys: 4 }),
				fc.array(labelArb, { maxLength: 6 }),
				settingsStateArb,
				fc.dictionary(labelArb, blobArb, { maxKeys: 4 }),
				async (settingsBefore, blobsBefore, touchedLabels, settingsAfter, blobsAfter) => {
					const snapshot = await buildPreImportSnapshot(
						(key) => settingsBefore[key],
						(label) => Promise.resolve(blobsBefore[label] ?? {}),
						touchedLabels
					);
					const restore = planSnapshotRestore(snapshot);

					const settingsState: Record<string, unknown> = { ...settingsAfter };
					for (const write of restore.settingWrites) {
						settingsState[write.key] = write.value;
					}
					for (const key of restore.settingRemovals) {
						delete settingsState[key];
					}
					for (const key of ALL_SETTING_KEYS) {
						assert.deepStrictEqual(settingsState[key], settingsBefore[key], key);
					}

					const blobState: Record<string, StoredServerSecrets> = { ...blobsAfter };
					for (const write of restore.blobWrites) {
						blobState[write.label] = write.secrets;
					}
					for (const label of restore.blobRemovals) {
						delete blobState[label];
					}
					for (const label of touchedLabels) {
						assert.deepStrictEqual(blobState[label] ?? {}, blobsBefore[label] ?? {}, label);
					}
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("extension/settingsTransfer property: merge invariants", () => {
	// "rename-taken" and "rename-reserved" are targets the flow's validation
	// would reject, and "missing" withholds the decision entirely (labels like
	// "toString" make a plain index read return an Object.prototype method);
	// resolveImportPlan must degrade every one of them to skip, never clobber
	// or crash.
	type DecisionSeed = "overwrite" | "skip" | "rename" | "rename-taken" | "rename-reserved" | "missing";
	const decisionSeedsArb = fc.array(
		fc.constantFrom<DecisionSeed>("overwrite", "skip", "rename", "rename-taken", "rename-reserved", "missing"),
		{ maxLength: 8 }
	);

	/** The parser's usable-label rule, restated from the raw element for the oracle below. */
	function rawLabelOf(element: unknown): string | undefined {
		if (!isRecord(element) || typeof element.label !== "string") {
			return undefined;
		}
		const label = element.label.trim();
		return label.length > 0 && !isUnsafeRecordKey(label) ? label : undefined;
	}

	/**
	 * The documented resolution rules restated from the RAW incoming array,
	 * independently of resolveImportPlan and serverSettingReports: per label,
	 * the parser's claimant (first element with a usable label AND baseUrl)
	 * lands, or the first labeled element when nothing claims; collisions
	 * follow the decisions; invalid rename targets, shadowed siblings, and
	 * entries whose auth the surgery cannot certify secret-free drop. Landing
	 * labels carry their source index so the assertions can pin WHICH element
	 * landed, not just how many. Shares no resolution code with the
	 * implementation (stripEntrySecrets stands in for the certification rule
	 * only; the surgery property pins it separately), so the two cannot drift
	 * together.
	 */
	function expectedOutcomes(
		incoming: readonly unknown[],
		decisions: CollisionDecisions,
		baseLabels: ReadonlySet<string>
	): {
		appended: { label: string; index: number }[];
		overwritten: { label: string; index: number }[];
		skipped: number;
	} {
		const hasUsableBaseUrl = (element: unknown): boolean =>
			isRecord(element) && typeof element.baseUrl === "string" && element.baseUrl.trim().length > 0;
		const unplaceable = (element: unknown): boolean => isRecord(element) && stripEntrySecrets(element).unsanitizable;
		const representative = new Map<string, number>();
		const fallback = new Map<string, number>();
		incoming.forEach((element, index) => {
			const label = rawLabelOf(element);
			if (label === undefined || unplaceable(element)) {
				return;
			}
			if (hasUsableBaseUrl(element) && !representative.has(label)) {
				representative.set(label, index);
			}
			if (!fallback.has(label)) {
				fallback.set(label, index);
			}
		});
		for (const [label, index] of fallback) {
			if (!representative.has(label)) {
				representative.set(label, index);
			}
		}

		const landed = new Set<string>();
		const appended: { label: string; index: number }[] = [];
		const overwritten: { label: string; index: number }[] = [];
		let skipped = 0;
		incoming.forEach((element, index) => {
			const label = rawLabelOf(element);
			if (label === undefined || unplaceable(element) || representative.get(label) !== index || landed.has(label)) {
				skipped += 1;
				return;
			}
			if (!baseLabels.has(label)) {
				landed.add(label);
				appended.push({ label, index });
				return;
			}
			const decision = Object.hasOwn(decisions, label) ? decisions[label] : undefined;
			if (decision === undefined || decision.action === "skip") {
				skipped += 1;
				return;
			}
			if (decision.action === "overwrite") {
				landed.add(label);
				overwritten.push({ label, index });
				return;
			}
			const target = decision.newLabel.trim();
			if (target.length === 0 || isUnsafeRecordKey(target) || landed.has(target) || baseLabels.has(target)) {
				skipped += 1;
				return;
			}
			landed.add(target);
			appended.push({ label: target, index });
		});
		return { appended, overwritten, skipped };
	}

	test("resolveImportPlan holds the in-place/append/untouched invariants under arbitrary decisions", () => {
		fc.assert(
			fc.property(
				fc.clone(fc.tuple(junkServersArb, junkServersArb), 2),
				decisionSeedsArb,
				([[current, incoming], [pristineCurrent, pristineIncoming]], decisionSeeds) => {
					const plan = planSettingsImport({ [SERVERS_SETTING_KEY]: incoming }, current);
					const base = Array.isArray(current) ? current : [];
					const baseLabels = new Set(
						base.flatMap((item) => {
							const label = rawLabelOf(item);
							return label !== undefined ? [label] : [];
						})
					);

					// One decision per collision label, derived deterministically.
					const taken = new Set<string>([
						...baseLabels,
						...plan.collisions.map((collision) => collision.label),
						...plan.incomingServers.flatMap((entry) => (entry.report.label !== undefined ? [entry.report.label] : [])),
					]);
					const decisions: Record<string, CollisionDecision> = {};
					plan.collisions.forEach((collision, index) => {
						const action = decisionSeeds[index % Math.max(decisionSeeds.length, 1)] ?? "overwrite";
						if (action === "missing") {
							return;
						}
						if (action === "rename") {
							const newLabel = suggestRenamedLabel(collision.label, taken);
							taken.add(newLabel);
							decisions[collision.label] = { action, newLabel };
						} else if (action === "rename-taken") {
							decisions[collision.label] = { action: "rename", newLabel: collision.label };
						} else if (action === "rename-reserved") {
							decisions[collision.label] = { action: "rename", newLabel: "__proto__" };
						} else {
							decisions[collision.label] = { action };
						}
					});
					const frozenDecisions: CollisionDecisions = decisions;

					const application = resolveImportPlan(plan, frozenDecisions);
					assert.deepStrictEqual(
						resolveImportPlan(plan, frozenDecisions),
						application,
						"resolution must be deterministic"
					);

					const expected = expectedOutcomes(incoming, frozenDecisions, baseLabels);
					assert.strictEqual(application.counts.imported + application.counts.renamed, expected.appended.length);
					assert.strictEqual(application.counts.overwritten, expected.overwritten.length);
					assert.strictEqual(application.counts.skipped, expected.skipped);

					// The entry and secrets a landing label carries are the oracle's
					// representative element, stripped - pinned by content so a
					// resolver picking the wrong same-label element cannot pass on
					// label and counts alone. stripEntrySecrets is safe as the
					// content oracle here; the surgery property pins it separately.
					const expectedLanding = (label: string, index: number) => {
						const raw = incoming[index];
						assert.ok(isRecord(raw));
						const relabeled = rawLabelOf(raw) === label ? raw : { ...raw, label };
						return stripEntrySecrets(relabeled);
					};

					const landed = application.counts.imported + application.counts.overwritten + application.counts.renamed;
					assert.strictEqual(landed + application.counts.skipped, plan.incomingServers.length);
					assert.strictEqual(application.serversValue === undefined, landed === 0);
					assert.strictEqual(application.secretWrites.length, landed);
					assert.deepStrictEqual(
						application.secretWrites.map((write) => write.label).sort(),
						[...expected.overwritten, ...expected.appended].map((outcome) => outcome.label).sort(),
						"every landing label gets exactly one secret write"
					);
					for (const outcome of [...expected.overwritten, ...expected.appended]) {
						const write = application.secretWrites.find((candidate) => candidate.label === outcome.label);
						assert.deepStrictEqual(
							write?.secrets,
							expectedLanding(outcome.label, outcome.index).secrets,
							`the secret write for "${outcome.label}" must come from its representative element`
						);
					}
					assert.deepStrictEqual(
						application.touchedLabels,
						[...new Set(application.secretWrites.map((write) => write.label))],
						"touched labels are exactly the secret-write labels"
					);

					if (application.serversValue !== undefined) {
						assert.strictEqual(application.serversValue.length, base.length + expected.appended.length);
						// The appended tail corresponds 1:1, in order and by content,
						// to the landing new and renamed representatives.
						assert.deepStrictEqual(
							application.serversValue.slice(base.length),
							expected.appended.map((outcome) => expectedLanding(outcome.label, outcome.index).entry)
						);
						const overwriteByLabel = new Map(expected.overwritten.map((outcome) => [outcome.label, outcome.index]));
						base.forEach((item, index) => {
							const label = rawLabelOf(item);
							const isOverwriteTarget =
								label !== undefined &&
								overwriteByLabel.has(label) &&
								base.findIndex((candidate) => rawLabelOf(candidate) === label) === index;
							if (isOverwriteTarget && label !== undefined) {
								// Replaced IN PLACE: same index, and by content the
								// representative element, stripped.
								const sourceIndex = overwriteByLabel.get(label);
								assert.ok(sourceIndex !== undefined);
								assert.deepStrictEqual(application.serversValue?.[index], expectedLanding(label, sourceIndex).entry);
							} else {
								// Untouched by reference: never mutated, never reordered.
								assert.strictEqual(application.serversValue?.[index], item);
							}
						});
					}

					assert.deepStrictEqual(current, pristineCurrent, "the current setting must never be mutated");
					assert.deepStrictEqual(incoming, pristineIncoming, "the incoming array must never be mutated");
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
