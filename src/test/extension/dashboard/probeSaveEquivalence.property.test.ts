/**
 * The probe-save equivalence pin (seed-pinned, FUZZ_RUNS-scaled): for
 * arbitrary drafts - field combinations, secret directives, an existing entry
 * with inline credentials, a stored blob, a label that keeps or renames the
 * entry - Test Connection and Save either refuse with the SAME message, or the
 * connection the probe sends equals the credentials the saved entry's provider
 * group would be handed (the written entry parsed by serverSync's own parser,
 * secrets resolved by buildGroupArgs over the post-save blob, narrowed by the
 * group parser). OAuth and the virtual key compare as complete units, the only
 * form in which the transport sends them. A second pin holds the host's plan
 * resolution (derived from the entry and the blob) equal to the resolution the
 * real form parser reports for the draft the user saved: the gap that once let
 * a retired label's orphan blob resolve host-side behind a form showing "none"
 * - on a fresh label and on a rename onto one alike.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { ReplacedEntryIdentity, RequestPayload, SecretDirective } from "../../../dashboard/endpoints";
import type { ServerFormDraft } from "../../../dashboard/serverForm";
import { EMPTY_SERVER_FORM, parseServerForm } from "../../../dashboard/serverForm";
import { executeDashboardIntent } from "../../../extension/dashboard/intents";
import {
	planResolves,
	readKeepSources,
	requireEntryShownByForm,
	secretPlans,
} from "../../../extension/dashboard/saveServer";
import { buildGroupArgs } from "../../../extension/servers/serverSync/engine";
import { inlineSecretValues, secretLocations } from "../../../extension/servers/serverSync/secrets";
import { acceptedEntry } from "../../../extension/servers/serverSync/setting";
import { parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import type { SecretFieldId, SecretLocation } from "../../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { recordFromKeys } from "../../../shared/util/json";
import { resolveFuzzSeed } from "../../fuzzStream";
import { makeEnv, type RecordedEnv, serverPayload } from "./recordedEnv";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 120;
const SEED = resolveFuzzSeed();

const optionArb = (values: readonly string[]) => fc.option(fc.constantFrom(...values), { nil: undefined });

const directiveArb = (values: readonly string[]): fc.Arbitrary<SecretDirective> =>
	fc.oneof(
		fc.constant<SecretDirective>({ action: "keep" }),
		fc.constant<SecretDirective>({ action: "clear" }),
		fc.record({
			action: fc.constant<"set">("set"),
			location: fc.constantFrom<"settings" | "secure">("settings", "secure"),
			value: fc.constantFrom(...values),
		})
	);

const secretsArb: fc.Arbitrary<Record<SecretFieldId, SecretDirective>> = fc.record({
	apiKey: directiveArb(["sk-test-set", " sk-test-set-padded ", "  "]),
	oauthClientSecret: directiveArb(["sk-test-cs-set", " sk-test-cs-padded ", "  "]),
	virtualKeyValue: directiveArb(["sk-test-vk-set", " sk-test-vk-padded ", "  "]),
});

const fieldsArb = fc.record({
	oauthTokenUrl: optionArb(["http://idp.test/token", " http://idp.test/token "]),
	oauthClientId: optionArb(["client-1"]),
	oauthScopes: optionArb(["read write"]),
	virtualKeyHeader: optionArb(["x-litellm-key"]),
});

const existingArb = fc.constantFrom<Record<string, unknown> | undefined>(
	undefined,
	{ label: "Prod", baseUrl: "http://prod.test" },
	{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-test-existing-inline" } },
	{
		label: "Prod",
		baseUrl: "http://prod.test",
		auth: {
			oauth: {
				tokenUrl: "http://idp.test/token",
				clientId: "client-1",
				clientSecret: "sk-test-existing-cs",
				virtualKey: { header: "x-litellm-key", value: "sk-test-existing-vkv" },
			},
		},
	},
	{ label: "Prod", baseUrl: "http://prod.test", auth: { virtualKey: { header: "x-litellm-key" } } }
);

const blobArb: fc.Arbitrary<Partial<Record<SecretFieldId, string>>> = fc.record(
	{
		apiKey: fc.constant("sk-test-stored-key"),
		oauthClientSecret: fc.constant("sk-test-stored-cs"),
		virtualKeyValue: fc.constant("sk-test-stored-vkv"),
	},
	{ requiredKeys: [] }
);

const orphanArb: fc.Arbitrary<Partial<Record<SecretFieldId, string>>> = fc.record(
	{
		apiKey: fc.constant("sk-test-orphan-key"),
		oauthClientSecret: fc.constant("sk-test-orphan-cs"),
		virtualKeyValue: fc.constant("sk-test-orphan-vkv"),
	},
	{ requiredKeys: [] }
);

function compact(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * The replace identity an edit form of `existing` would display: the entry's own base URL and the pushed secret
 * locations - the production derivation (secretLocations over the entry and its label's blob).
 */
function displayedIdentity(
	existing: Record<string, unknown>,
	blob: Partial<Record<SecretFieldId, string>>
): ReplacedEntryIdentity {
	const parsed = acceptedEntry([existing], "Prod");
	assert.ok(parsed !== undefined, "the existing fixtures all parse");
	return {
		label: "Prod",
		baseUrl: parsed.entry.baseUrl,
		...(parsed.entry.apiVersion === undefined ? {} : { apiVersion: parsed.entry.apiVersion }),
		...pickNonSecretOptionalFields(parsed.entry),
		secrets: secretLocations(parsed.entry, blob),
	};
}

async function outcomeOf(run: Promise<unknown>): Promise<Error | undefined> {
	try {
		await run;
		return undefined;
	} catch (error) {
		assert.ok(error instanceof Error, "intents fail with Error instances");
		return error;
	}
}

/**
 * A recorded env over `setting`, with "Prod"'s blob seeded, plus a retired label's leftover blob under any other draft
 * label.
 */
function seededEnv(
	setting: unknown,
	blob: Partial<Record<SecretFieldId, string>>,
	orphan: Partial<Record<SecretFieldId, string>>,
	label: string
): RecordedEnv {
	const env = makeEnv(setting);
	if (Object.keys(blob).length > 0) {
		env.storedSecrets.set("Prod", { ...blob } as Record<string, string>);
	}
	// A retired label's leftover blob, under the draft's label when that label is not "Prod".
	if (label !== "Prod" && Object.keys(orphan).length > 0) {
		env.storedSecrets.set(label, { ...orphan } as Record<string, string>);
	}
	return env;
}

/** The credential units the probe's connection carries, absent units left undefined for the caller's compaction. */
function probeEffectiveCredentials(connection: RecordedEnv["probes"][number]): Record<string, unknown> {
	return {
		apiKey: connection.apiKey,
		oauth: connection.oauth === undefined ? undefined : compact({ ...connection.oauth }),
		virtualKey: connection.virtualKey === undefined ? undefined : { ...connection.virtualKey },
	};
}

/** The secret location the form showed per field: an edit form shows inline over stored, an add form shows none. */
function shownLocationOf(
	editing: boolean,
	inline: Partial<Record<SecretFieldId, string>>,
	blob: Partial<Record<SecretFieldId, string>>
): (field: SecretFieldId) => SecretLocation {
	return (field) => {
		if (!editing) {
			return "none";
		}
		if (inline[field] !== undefined) {
			return "settings";
		}
		if (blob[field] !== undefined) {
			return "secure";
		}
		return "none";
	};
}

/**
 * The form draft the user saved: an edit form prefilled with each field's shown location, an add form left at
 * EMPTY_SERVER_FORM; `removals` are the clear ticks, so every field stays inactive and resolves by its location alone.
 */
function secretFormDraft(
	editing: boolean,
	label: string,
	removals: Record<SecretFieldId, boolean>,
	shown: (field: SecretFieldId) => SecretLocation
): ServerFormDraft {
	return {
		...EMPTY_SERVER_FORM,
		label,
		baseUrl: "http://prod.test",
		...(editing
			? recordFromKeys(SECRET_FIELD_IDS, (field) => ({
					value: "",
					location: "secure" as const,
					clear: removals[field],
					existing: shown(field),
				}))
			: recordFromKeys(SECRET_FIELD_IDS, (field) => ({ ...EMPTY_SERVER_FORM[field], clear: removals[field] }))),
	};
}

/** The case a field's resolution assertion names: the directive, the shown location, and the form it sat in. */
function describeFieldCase(field: SecretFieldId, removal: boolean, shown: SecretLocation, editing: boolean): string {
	return `${field}: ${removal ? "removal" : "keep"} on a "${shown}" location, ${editing ? "edit" : "add"} form`;
}

/** The replace identity an edit form carries, or undefined for the add form and when no entry exists. */
function replaceIdentityFor(
	existing: Record<string, unknown> | undefined,
	declaresReplacement: boolean,
	blob: Partial<Record<SecretFieldId, string>>
): ReturnType<typeof displayedIdentity> | undefined {
	return existing !== undefined && declaresReplacement ? displayedIdentity(existing, blob) : undefined;
}

/** An inactive field's directive is clear or keep, nothing else (parseInactiveSecret never sets). */
function clearOrKeepDirectives(removals: Record<SecretFieldId, boolean>): Record<SecretFieldId, SecretDirective> {
	return recordFromKeys(
		SECRET_FIELD_IDS,
		(field): SecretDirective => (removals[field] ? { action: "clear" } : { action: "keep" })
	);
}

suite("extension/dashboard: probe-save equivalence", () => {
	test("Test Connection probes exactly the credentials the saved entry's group would be handed", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					fields: fieldsArb,
					secrets: secretsArb,
					existing: existingArb,
					blob: blobArb,
					orphan: orphanArb,
					// Independent of `existing` on purpose: an entry under the label with NO replace identity is the add
					// form saving onto a taken label, the route whose secret resolution differs from an edit's.
					declaresReplacement: fc.boolean(),
					// The draft's label, independent of the replaced entry's: "Renamed" with a replace identity is a
					// rename, whose keeps must resolve the source entry alone - never the orphan blob seeded under
					// "Renamed".
					label: fc.constantFrom("Prod", "Renamed"),
				}),
				async ({ fields, secrets, existing, blob, orphan, declaresReplacement, label }) => {
					const setting = existing === undefined ? [] : [existing];
					const replace = replaceIdentityFor(existing, declaresReplacement, blob);
					const payload = {
						server: serverPayload({ label, baseUrl: "http://prod.test", ...compact(fields) }),
						secrets,
						...(replace === undefined ? {} : { replace }),
					} satisfies RequestPayload<"saveServerSetting">;

					const saveEnv = seededEnv(setting, blob, orphan, label);
					const probeEnv = seededEnv(setting, blob, orphan, label);
					const saveError = await outcomeOf(
						executeDashboardIntent({ method: "saveServerSetting", payload }, saveEnv.env)
					);
					const probeError = await outcomeOf(
						executeDashboardIntent({ method: "testServerDraft", payload }, probeEnv.env)
					);

					if (saveError !== undefined || probeError !== undefined) {
						// A draft one path refuses, the other must refuse identically: a probe verdict for an unsavable
						// draft (or a saved entry the probe refused to test) is exactly the divergence this pin
						// forbids.
						assert.strictEqual(probeError?.message, saveError?.message, "refusals must match");
						assert.strictEqual(probeError?.name, saveError?.name);
						return;
					}

					const written = saveEnv.serverWrites.at(-1);
					assert.ok(written !== undefined, "the save landed a settings write");
					const saved = acceptedEntry(written, label);
					assert.ok(saved !== undefined, "a save never writes an entry the parser rejects");
					const args = buildGroupArgs(saved.entry, saveEnv.storedSecrets.get(label) ?? {});
					const connection = probeEnv.probes[0];
					assert.ok(connection !== undefined, "the probe ran");

					// The credentials the provider is handed: the saved args narrowed by the group parser, where OAuth
					// and the virtual key count only as complete units and a header-illegal value is dropped.
					const savedGroup = parseGroupConfiguration(args)?.server;
					assert.ok(savedGroup !== undefined, "a saved entry's group args parse");
					const savedEffective = {
						apiKey: savedGroup.apiKey,
						oauth: savedGroup.oauth,
						virtualKey: savedGroup.virtualKey,
					};
					assert.deepStrictEqual(compact(probeEffectiveCredentials(connection)), compact(savedEffective));
				}
			),
			{ seed: SEED, numRuns: NUM_RUNS }
		);
	});

	test("a secret resolves host-side exactly when the form the user saved showed one", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					apiKey: fc.boolean(),
					oauthClientSecret: fc.boolean(),
					virtualKeyValue: fc.boolean(),
				}),
				existingArb,
				blobArb,
				orphanArb,
				fc.boolean(),
				// A draft label of "Renamed" makes an edit a rename; the orphan blob seeded under it must never count
				// as shown.
				fc.constantFrom("Prod", "Renamed"),
				async (removals, existing, blob, orphan, declaresReplacement, label) => {
					const setting = existing === undefined ? [] : [existing];
					const env = seededEnv(setting, blob, orphan, label);
					const replace = replaceIdentityFor(existing, declaresReplacement, blob);
					const targetLabel = replace?.label ?? label;
					const sources = await readKeepSources(setting, label, targetLabel, (secretsLabel) =>
						env.env.readServerSecrets(secretsLabel)
					);
					// Which entry the form was showing, by the production rule itself: the edit form identifies the
					// entry it replaces (replace), the add form never does - not even when its label collides with an
					// entry and the save replaces it.
					const showing = requireEntryShownByForm(replace, sources);
					const editing = showing !== undefined;
					// What that form showed per field. The edit form is prefilled from the pushed entry locations
					// (serverSync's secretLocations rule: inline wins over the blob); the add form is
					// EMPTY_SERVER_FORM, every field "none".
					const inline = sources.accepted === undefined ? {} : inlineSecretValues(sources.accepted.entry);
					const shown = shownLocationOf(editing, inline, blob);
					// Auth stays on "none", where all three fields are inactive and each one's still-attached problem
					// appears exactly when the form's own resolution says the field resolves - the webview signal this
					// pins against the host's plans.
					const draft = secretFormDraft(editing, label, removals, shown);
					const parse = parseServerForm(
						draft,
						editing && replace !== undefined ? { original: replace } : { takenLabels: ["Prod"] }
					);
					// The contested half is the resolution the parse reports through its problems.
					const plans = secretPlans(clearOrKeepDirectives(removals), showing, sources.storedOld);
					for (const field of SECRET_FIELD_IDS) {
						const formResolves = !parse.ok && parse.problems[field] !== undefined;
						assert.strictEqual(
							planResolves(plans[field]),
							formResolves,
							describeFieldCase(field, removals[field], shown(field), editing)
						);
					}
				}
			),
			{ seed: SEED, numRuns: NUM_RUNS }
		);
	});
});
