import * as assert from "node:assert";
import * as fc from "fast-check";
import type { DeclaredServer, StoredServerSecrets } from "../../../extension/servers/serverSync";
import {
	acceptedEntry,
	buildGroupArgs,
	parseServersSetting,
	serverSettingReports,
} from "../../../extension/servers/serverSync";
import { OPTIONAL_ENTRY_FIELDS, SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { HEADER_NAME_PATTERN } from "../../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

/**
 * Robustness properties for the servers-setting entry parser: parsing is total and
 * deterministic over user-authored garbage and never mutates its input, acceptance
 * matches an independently restated auth grammar, and a parse -> serialize -> parse round
 * trip is a fixed point whose flattened group args are byte-identical - the persisted
 * sync fingerprints hash exactly that JSON rendering, so drift here would silently
 * re-push every provider group.
 */

const labelPool = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"] as const;

const labelArb = fc.oneof(
	{ weight: 4, arbitrary: fc.constantFrom<unknown>(...labelPool) },
	fc.constantFrom<unknown>("  alpha\t", "", "   ", "\n", "__proto__", "constructor", "prototype", 7, null, undefined)
);

const baseUrlArb = fc.oneof(
	{ weight: 4, arbitrary: fc.constantFrom<unknown>("http://one.test", " http://two.test/ ") },
	fc.constantFrom<unknown>("", "  ", undefined, 42, {})
);

const junkScalar = fc.constantFrom<unknown>(42, null, true, "", "  ", [], {});

/** A virtualKey object, weighted toward valid pairs so companions really flow; junk arms keep the parser honest. */
const virtualKeyArb = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record(
			{
				header: fc.oneof(
					{ weight: 5, arbitrary: fc.constantFrom<unknown>("x-litellm-key", " X-Key ") },
					fc.constantFrom<unknown>("bad header", "", "  ", "bad\nname", 42, undefined)
				),
				value: fc.oneof(
					{ weight: 5, arbitrary: fc.constantFrom<unknown>("vk-1", " padded ", "") },
					fc.constantFrom<unknown>(42, null, undefined)
				),
			},
			{ requiredKeys: [] }
		),
	},
	fc.constantFrom<unknown>("vk-as-string", 42, null, ["vk"]),
	fc.constant({ header: "x-key", value: "vk", extra: true })
);

/** An oauth object, weighted toward the complete unit; partial units, junk field types, and unknown keys stay in. */
const oauthArb = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record(
			{
				tokenUrl: fc.oneof(
					{ weight: 6, arbitrary: fc.constant<unknown>("http://idp.test/token") },
					fc.constantFrom<unknown>("", "  ", 42, undefined)
				),
				clientId: fc.oneof(
					{ weight: 6, arbitrary: fc.constant<unknown>("client-1") },
					fc.constantFrom<unknown>("", 42, undefined)
				),
				clientSecret: fc.constantFrom<unknown>("secret", "secret", "", 42, undefined),
				scopes: fc.constantFrom<unknown>("a b", "a b", "", 7, undefined),
				apiKey: fc.constantFrom<unknown>("companion-key", "companion-key", "", 42, undefined),
				virtualKey: fc.oneof({ weight: 1, arbitrary: virtualKeyArb }, fc.constant(undefined)),
			},
			{ requiredKeys: [] }
		),
	},
	fc.constantFrom<unknown>("oauth-as-string", 42, null),
	fc.constant({ tokenUrl: "http://idp.test/token", clientId: "c", bogus: 1 })
);

/** An entry's auth object: every form, valid and ambiguous companions, unknown keys, outright junk. */
const authArb = fc.oneof(
	{ weight: 2, arbitrary: fc.constant(undefined) },
	{
		weight: 3,
		arbitrary: fc.record({ apiKey: fc.oneof(fc.constantFrom<unknown>("sk-1", " padded ", ""), junkScalar) }),
	},
	{ weight: 2, arbitrary: fc.record({ virtualKey: virtualKeyArb }) },
	{ weight: 2, arbitrary: fc.record({ apiKey: fc.constantFrom<unknown>("sk-1", 42), virtualKey: virtualKeyArb }) },
	{ weight: 4, arbitrary: fc.record({ oauth: oauthArb }) },
	// Ambiguous: a second form beside oauth is a shape error, never guessed at.
	{ weight: 1, arbitrary: fc.record({ oauth: oauthArb, apiKey: fc.constant("sk-1") }) },
	{ weight: 1, arbitrary: fc.record({ oauth: oauthArb, virtualKey: virtualKeyArb }) },
	{
		weight: 2,
		arbitrary: fc.constantFrom<unknown>(
			{},
			{ unknownKey: "x" },
			{ apiKey: "k", bogus: 1 },
			"auth-as-string",
			42,
			null,
			[]
		),
	}
);

const headerValueArb = fc.oneof(
	fc.constantFrom<unknown>("plain", "", "a".repeat(4000), "bad\nvalue", "trailing ", 42, true, null, {}),
	fc.string({ maxLength: 30 })
);

const headersArb = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom<unknown>("headers-as-string", 42, []),
	fc.dictionary(
		fc.constantFrom("x-team", "X-Team", "x-trace", "bad header", "", "__proto__", "a".repeat(300)),
		headerValueArb,
		{ maxKeys: 4 }
	)
);

const recordValueArb = fc.oneof(fc.jsonValue({ maxDepth: 1 }), fc.constant(undefined));
const modelsArb = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom<unknown>("models-as-string", 42, []),
	fc.record(
		{
			parameters: fc.oneof(
				fc.dictionary(
					fc.constantFrom("gpt-*", "claude", "*", "/re.*/"),
					fc.dictionary(fc.constantFrom("temperature", "top_p", "_force"), recordValueArb, { maxKeys: 2 }),
					{ maxKeys: 3 }
				),
				junkScalar
			),
			capabilities: fc.oneof(
				fc.dictionary(
					fc.constantFrom("gpt-*", "*"),
					fc.dictionary(fc.constantFrom("toolCalling", "imageInput", "bogus"), recordValueArb, { maxKeys: 2 }),
					{ maxKeys: 2 }
				),
				junkScalar
			),
		},
		{ requiredKeys: [] }
	)
);

const discoveryArb = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom<unknown>("discovery-as-string", 42),
	fc.record(
		{
			expectedFailures: fc.oneof(
				fc.array(fc.constantFrom<unknown>("modelListing", "modelInfo", "bogus", 42, ""), { maxLength: 4 }),
				junkScalar
			),
			declared: fc.oneof(
				fc.array(fc.constantFrom<unknown>("model-a", " model-b ", "", "  ", 42), { maxLength: 4 }),
				junkScalar
			),
		},
		{ requiredKeys: [] }
	)
);

const budgetArb = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom<unknown>(0, -5, 50, 0.01, 1e308, Number.NaN, Number.POSITIVE_INFINITY, "50", null, {})
);

/** One raw settings element: a nested-shape record with junk in every slot, or outright junk. */
const rawEntryArb = fc.oneof(
	{
		weight: 5,
		arbitrary: fc
			.record({
				label: labelArb,
				baseUrl: baseUrlArb,
				auth: authArb,
				headers: headersArb,
				models: modelsArb,
				discovery: discoveryArb,
				budget: budgetArb,
			})
			.map((entry) => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))),
	},
	{ weight: 1, arbitrary: fc.jsonValue({ maxDepth: 2 }) }
);

const rawSettingArb = fc.array(rawEntryArb, { maxLength: 6 });

const storedArb: fc.Arbitrary<StoredServerSecrets> = fc.dictionary(
	fc.constantFrom(...SECRET_FIELD_IDS),
	fc.constantFrom("stored-secret", "other-stored"),
	{ maxKeys: 3 }
) as fc.Arbitrary<StoredServerSecrets>;

/**
 * A parsed entry rendered back to the nested settings shape (the same assembly
 * saveServer.ts applies): flat credential fields fold into the auth grammar by rank, and
 * the extension-side fields return to their headers/models/discovery/budget slots.
 */
function serializeEntry(entry: DeclaredServer): Record<string, unknown> {
	const virtualKey =
		entry.virtualKeyHeader !== undefined
			? {
					header: entry.virtualKeyHeader,
					...(entry.virtualKeyValue !== undefined ? { value: entry.virtualKeyValue } : {}),
				}
			: undefined;
	const auth: Record<string, unknown> = {};
	if (entry.oauthTokenUrl !== undefined && entry.oauthClientId !== undefined) {
		auth.oauth = {
			tokenUrl: entry.oauthTokenUrl,
			clientId: entry.oauthClientId,
			...(entry.oauthClientSecret !== undefined ? { clientSecret: entry.oauthClientSecret } : {}),
			...(entry.oauthScopes !== undefined ? { scopes: entry.oauthScopes } : {}),
			...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
			...(virtualKey !== undefined ? { virtualKey } : {}),
		};
	} else {
		if (entry.apiKey !== undefined) {
			auth.apiKey = entry.apiKey;
		}
		if (virtualKey !== undefined) {
			auth.virtualKey = virtualKey;
		}
	}
	const models: Record<string, unknown> = {
		...(entry.modelParameters !== undefined ? { parameters: entry.modelParameters } : {}),
		...(entry.modelCapabilities !== undefined ? { capabilities: entry.modelCapabilities } : {}),
	};
	const discovery: Record<string, unknown> = {
		...(entry.expectedFailures !== undefined ? { expectedFailures: entry.expectedFailures } : {}),
		...(entry.declaredModels !== undefined ? { declared: entry.declaredModels } : {}),
	};
	return {
		label: entry.label,
		baseUrl: entry.baseUrl,
		...(Object.keys(auth).length > 0 ? { auth } : {}),
		...(entry.headers !== undefined ? { headers: entry.headers } : {}),
		...(Object.keys(models).length > 0 ? { models } : {}),
		...(Object.keys(discovery).length > 0 ? { discovery } : {}),
		...(entry.budget !== undefined ? { budget: entry.budget } : {}),
	};
}

/** Mirror of the parser's usable-text rule, for the independent acceptance oracle below. */
function usableText(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** The documented virtualKey object rules, restated independently of parseVirtualKeyObject. */
function virtualKeyIsAcceptable(raw: unknown): boolean {
	if (!isRecord(raw)) {
		return false;
	}
	if (Object.keys(raw).some((key) => key !== "header" && key !== "value")) {
		return false;
	}
	const header = typeof raw.header === "string" ? usableText(raw.header) : undefined;
	if (header === undefined || !HEADER_NAME_PATTERN.test(header)) {
		return false;
	}
	return raw.value === undefined || typeof raw.value === "string";
}

/**
 * The documented auth grammar (setting.ts's module docstring), restated independently of
 * parseAuth: exactly one form, ranked oauth > apiKey > virtualKey, companions of strictly
 * lower primacy only, unknown keys and type errors misconfigure, and a missing secret
 * VALUE is never misconfiguration. This oracle shares no code with the parser.
 */
function authIsAcceptable(raw: unknown): boolean {
	if (raw === undefined) {
		return true;
	}
	if (!isRecord(raw)) {
		return false;
	}
	if (Object.keys(raw).some((key) => !["apiKey", "oauth", "virtualKey"].includes(key))) {
		return false;
	}
	const hasOAuth = raw.oauth !== undefined;
	const hasApiKey = raw.apiKey !== undefined;
	const hasVirtualKey = raw.virtualKey !== undefined;
	if (!hasOAuth && !hasApiKey && !hasVirtualKey) {
		return false;
	}
	if (hasOAuth && (hasApiKey || hasVirtualKey)) {
		return false;
	}
	if (hasOAuth) {
		const oauth = raw.oauth;
		if (!isRecord(oauth)) {
			return false;
		}
		const known = ["tokenUrl", "clientId", "clientSecret", "scopes", "apiKey", "virtualKey"];
		if (Object.keys(oauth).some((key) => !known.includes(key))) {
			return false;
		}
		if (usableText(oauth.tokenUrl) === undefined || usableText(oauth.clientId) === undefined) {
			return false;
		}
		for (const key of ["clientSecret", "scopes", "apiKey"] as const) {
			if (oauth[key] !== undefined && typeof oauth[key] !== "string") {
				return false;
			}
		}
		return oauth.virtualKey === undefined || virtualKeyIsAcceptable(oauth.virtualKey);
	}
	if (hasApiKey && typeof raw.apiKey !== "string") {
		return false;
	}
	return !hasVirtualKey || virtualKeyIsAcceptable(raw.virtualKey);
}

/**
 * The raw indices the documented acceptance rules keep: an object element with
 * usable label and baseUrl, an unreserved label no earlier entry claimed (a
 * misconfigured entry still CLAIMS its label), and an acceptable auth shape.
 */
function expectedAcceptedIndices(raw: readonly unknown[]): number[] {
	const seen = new Set<string>();
	const accepted: number[] = [];
	raw.forEach((item, index) => {
		if (!isRecord(item)) {
			return;
		}
		const label = usableText(item.label);
		if (label === undefined || usableText(item.baseUrl) === undefined) {
			return;
		}
		if (isUnsafeRecordKey(label) || seen.has(label)) {
			return;
		}
		seen.add(label);
		if (authIsAcceptable(item.auth)) {
			accepted.push(index);
		}
	});
	return accepted;
}

suite("extension/servers/serverSync setting parser properties (nested shape)", () => {
	test("parsing is total, deterministic, and never mutates its input", () => {
		fc.assert(
			// fc.clone yields two structurally identical instances, so the mutation
			// check compares against a pristine twin instead of a structuredClone
			// (which would normalize null-prototype objects).
			fc.property(fc.clone(fc.oneof(rawSettingArb, fc.jsonValue(), fc.anything()), 2), ([raw, pristine]) => {
				const first = parseServersSetting(raw);
				const second = parseServersSetting(raw);
				assert.deepStrictEqual(second, first, "same input must yield the same entries and problems");
				const firstReports = serverSettingReports(raw);
				const secondReports = serverSettingReports(raw);
				assert.deepStrictEqual(secondReports, firstReports, "diagnostics must be deterministic");
				acceptedEntry(raw, "alpha");
				acceptedEntry(raw, "__proto__");
				assert.deepStrictEqual(raw, pristine, "parsing must never mutate the raw setting");
				for (const entry of first.entries) {
					assert.strictEqual(entry.label, entry.label.trim());
					assert.ok(entry.label.length > 0 && entry.baseUrl.trim().length > 0);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("acceptance matches the independently restated grammar; misconfigured entries are reported, never parsed", () => {
		fc.assert(
			fc.property(rawSettingArb, (raw) => {
				const { entries } = parseServersSetting(raw);
				const reports = serverSettingReports(raw);
				assert.strictEqual(reports.length, raw.length, "one verdict per raw element");

				// The oracle shares no code with acceptEntries: a parser bug accepting an
				// ambiguous companion or a partial oauth unit would disagree here.
				assert.deepStrictEqual(
					reports.filter((report) => report.accepted).map((report) => report.index),
					expectedAcceptedIndices(raw),
					"accepted indices must match the documented acceptance rules"
				);

				const accepted = reports.filter((report) => report.accepted);
				assert.deepStrictEqual(
					entries.map((entry) => entry.label),
					accepted.map((report) => report.label),
					"parsed entries and accepted reports must be the same set, in raw order"
				);
				for (const report of reports) {
					if (!report.accepted) {
						// A rejected element the dashboard would show as a row (usable
						// label and baseUrl) must carry at least one concrete problem.
						if (report.label !== undefined && report.baseUrl !== undefined) {
							assert.ok(report.problems.length > 0, "a rejected row must explain itself");
						}
						// Nothing of a rejected element reaches group args: its label
						// either resolves to nothing or to a different, accepted element.
						if (report.label !== undefined) {
							const resolved = acceptedEntry(raw, report.label);
							assert.notStrictEqual(resolved?.index, report.index, "a rejected element must never resolve");
						}
					}
				}
				// acceptedEntry agrees element for element with the reports.
				for (const report of accepted) {
					const resolved = acceptedEntry(raw, report.label ?? "");
					assert.ok(resolved !== undefined && resolved.index === report.index);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("parse -> serialize -> parse is a fixed point with no problems", () => {
		// Self-enforcing coverage: the round trip must actually see accepted
		// entries, the oauth form, and oauth companions - not just empty lists.
		let acceptedTotal = 0;
		let oauthForms = 0;
		let oauthCompanions = 0;
		fc.assert(
			fc.property(rawSettingArb, (raw) => {
				const { entries } = parseServersSetting(raw);
				acceptedTotal += entries.length;
				for (const entry of entries) {
					if (entry.oauthTokenUrl !== undefined) {
						oauthForms += 1;
						if (entry.apiKey !== undefined || entry.virtualKeyHeader !== undefined) {
							oauthCompanions += 1;
						}
					}
				}
				const serialized = entries.map(serializeEntry);
				const reparsed = parseServersSetting(serialized);
				assert.deepStrictEqual(reparsed.problems, [], "a parsed entry serializes to a clean entry");
				assert.deepStrictEqual(reparsed.entries, entries, "the round trip must be a fixed point");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
		if (NUM_RUNS >= 200) {
			assert.ok(acceptedTotal > 0, "the round trip never saw an accepted entry; the generators regressed");
			assert.ok(oauthForms > 0, "the round trip never saw an oauth-form entry; the generators regressed");
			assert.ok(oauthCompanions > 0, "the round trip never saw an oauth companion; the generators regressed");
		}
	});

	test("group args stay byte-stable across the round trip and never carry extension-side fields", () => {
		const canonicalKeys = ["name", "vendor", "baseUrl", "label", ...OPTIONAL_ENTRY_FIELDS.map((field) => field.id)];
		fc.assert(
			fc.property(rawSettingArb, storedArb, (raw, stored) => {
				const { entries } = parseServersSetting(raw);
				const reparsed = parseServersSetting(entries.map(serializeEntry)).entries;
				assert.strictEqual(reparsed.length, entries.length);
				for (let index = 0; index < entries.length; index += 1) {
					const entry = entries[index] as DeclaredServer;
					const roundTripped = reparsed[index] as DeclaredServer;
					const args = buildGroupArgs(entry, stored);
					// The negative half of the fingerprint contract (serverEntry.ts):
					// headers, models.*, discovery.*, and budget never reach group args.
					for (const key of Object.keys(args)) {
						assert.ok(canonicalKeys.includes(key), `group args must never carry "${key}"`);
					}
					assert.strictEqual(
						JSON.stringify(buildGroupArgs(roundTripped, stored)),
						JSON.stringify(args),
						"the persisted fingerprint hashes this JSON; the round trip must not perturb it"
					);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);

		// Deterministic pin: an entry carrying EVERY extension-side field still
		// flattens to credential-only group args.
		const loaded = parseServersSetting([
			{
				label: "loaded",
				baseUrl: "http://loaded.test",
				auth: { apiKey: "sk-1", virtualKey: { header: "x-key", value: "vk-1" } },
				headers: { "x-team": "core" },
				models: { parameters: { "gpt-*": { temperature: 0 } }, capabilities: { "*": { toolCalling: true } } },
				discovery: { expectedFailures: ["modelInfo"], declared: ["model-a"] },
				budget: 50,
			},
		]).entries[0] as DeclaredServer;
		assert.ok(loaded.headers !== undefined && loaded.budget === 50, "the loaded entry must parse its extras");
		assert.deepStrictEqual(Object.keys(buildGroupArgs(loaded, {})), [
			"name",
			"vendor",
			"baseUrl",
			"label",
			"apiKey",
			"virtualKeyHeader",
			"virtualKeyValue",
		]);
	});
});
