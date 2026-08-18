import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { SecretDirective } from "../../../dashboard/endpoints";
import type { AuthFormId, SecretFieldDraft, ServerFormDraft, ServerFormField } from "../../../dashboard/serverForm";
import { changedServerFormFields, EMPTY_SERVER_FORM, parseServerForm } from "../../../dashboard/serverForm";
import type { SecretFieldId } from "../../../shared/serverEntry";
import { NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
const SEED = resolveFuzzSeed();

// Values with deliberate whitespace variety: bare, padded, whitespace-only,
// and strings that collide with the prefill pool, so every parseSecret branch
// (trimmed-empty keep, prefill keep, set) is reachable from both sides.
const secretValue = fc.oneof(
	fc.constantFrom("", " ", "\t", "  "),
	fc
		.tuple(fc.constantFrom("sk-a", "sk-b", "sk-stored"), fc.constantFrom("", " ", "\t "), fc.constantFrom("", " "))
		.map(([core, lead, trail]) => `${lead}${core}${trail}`),
	fc.string({ maxLength: 8 })
);

const secretDraft: fc.Arbitrary<SecretFieldDraft> = fc.record({
	value: secretValue,
	location: fc.constantFrom("settings", "secure"),
	clear: fc.boolean(),
	existing: fc.constantFrom("none", "settings", "secure"),
	prefill: fc.option(fc.constantFrom("sk-a", "sk-b", "sk-stored"), { nil: undefined }),
});

/** One side of a comparison: the picked auth form plus all three secret fields. */
interface FormSide {
	readonly authForm: AuthFormId;
	readonly apiKey: SecretFieldDraft;
	readonly oauthClientSecret: SecretFieldDraft;
	readonly virtualKeyValue: SecretFieldDraft;
}

const formSide: fc.Arbitrary<FormSide> = fc.record({
	authForm: fc.constantFrom<AuthFormId>("none", "apiKey", "virtualKey", "oauth"),
	apiKey: secretDraft,
	oauthClientSecret: secretDraft,
	virtualKeyValue: secretDraft,
});

/**
 * A draft whose non-secret fields satisfy the picked form's pair rules, so
 * savability is decided by the secret fields alone (blocked combinations are
 * discarded by the property's precondition).
 */
function buildDraft(side: FormSide): ServerFormDraft {
	return {
		...EMPTY_SERVER_FORM,
		label: "Prod",
		baseUrl: "http://localhost:4000",
		...side,
		...(side.authForm === "oauth" ? { oauthTokenUrl: "https://idp.test/token", oauthClientId: "client" } : {}),
		...(side.authForm === "virtualKey" ? { virtualKeyHeader: "x-litellm-key" } : {}),
	};
}

/** The three directives Save would carry for this draft, straight from the assembled intent; undefined when blocked. */
function savedDirectives(draft: ServerFormDraft): Readonly<Record<SecretFieldId, SecretDirective>> | undefined {
	const parse = parseServerForm(draft);
	return parse.ok ? parse.intent.secrets : undefined;
}

function sameDirective(a: SecretDirective, b: SecretDirective): boolean {
	if (a.action === "set") {
		return b.action === "set" && a.location === b.location && a.value === b.value;
	}
	return a.action === b.action;
}

/** A pool value with lead/trail whitespace variety, so trim-only differences appear on both sides. */
const paddedFrom = (...cores: readonly string[]): fc.Arbitrary<string> =>
	fc
		.tuple(fc.constantFrom(...cores), fc.constantFrom("", " ", "\t "), fc.constantFrom("", " "))
		.map(([core, lead, trail]) => `${lead}${core}${trail}`);

/**
 * Whole drafts whose non-secret fields mix bare, padded, junk, and leftover
 * values across every auth form: enough variety to reach each normalization
 * (trim, active-gating, budget and declared-models parses) from both sides,
 * while keeping both-sides-savable common enough for the precondition.
 */
const nonSecretDraft: fc.Arbitrary<ServerFormDraft> = fc
	.record({
		authForm: fc.constantFrom<AuthFormId>("none", "apiKey", "virtualKey", "oauth"),
		label: paddedFrom("Prod", "Staging"),
		baseUrl: paddedFrom("http://localhost:4000", "http://localhost:4001"),
		apiVersion: fc.record({
			mode: fc.constantFrom<"auto" | "none" | "custom">("auto", "none", "custom"),
			custom: fc.constantFrom("", " ", "v2", " v2 ", "2024-01"),
		}),
		oauthTokenUrl: fc.oneof(
			fc.constantFrom("", " ", "notaurl"),
			paddedFrom("https://idp.test/token", "https://idp2.test/token")
		),
		oauthClientId: fc.constantFrom("", " ", "client", " client ", "client2"),
		oauthScopes: fc.constantFrom("", " ", "read", " read write ", "write"),
		virtualKeyHeader: fc.constantFrom("", " ", "x-key", " x-key "),
		virtualKeyValue: fc
			.constantFrom("", "vk", " vk ")
			.map((value): SecretFieldDraft => ({ ...EMPTY_SERVER_FORM.virtualKeyValue, value })),
		declaredModels: fc.constantFrom("", "\n \n", "gpt-4", " gpt-4 \ngpt-4", "gpt-4\ngpt-5", "gpt-5\ngpt-4"),
		budget: fc.constantFrom("", " ", "5", " 5 ", "5.0", "10"),
	})
	.map((fields) => ({ ...EMPTY_SERVER_FORM, ...fields }));

/** The fields the count normalizes; each is also a key of the assembled save payload. */
const NORMALIZED_FIELDS = [
	"label",
	"baseUrl",
	"apiVersion",
	...NON_SECRET_OPTIONAL_FIELD_IDS,
	"declaredModels",
	"budget",
] as const satisfies readonly ServerFormField[];

describe("dashboard/serverForm save-bar properties", () => {
	test("an active secret counts as changed exactly when the directive Save assembles differs from the baseline's", () => {
		// Zero discards and dense whitespace coverage on the field the apiKey
		// form always saves, whatever the secret draft holds.
		fc.assert(
			fc.property(secretDraft, secretDraft, (nowSecret, wasSecret) => {
				const side = (apiKey: SecretFieldDraft): FormSide => ({
					authForm: "apiKey",
					apiKey,
					oauthClientSecret: EMPTY_SERVER_FORM.oauthClientSecret,
					virtualKeyValue: EMPTY_SERVER_FORM.virtualKeyValue,
				});
				const now = buildDraft(side(nowSecret));
				const was = buildDraft(side(wasSecret));
				const nowWrites = savedDirectives(now);
				const wasWrites = savedDirectives(was);
				assert.ok(nowWrites !== undefined && wasWrites !== undefined, "the apiKey form must stay savable");
				const counted = changedServerFormFields(now, was).includes("apiKey");
				assert.strictEqual(counted, !sameDirective(nowWrites.apiKey, wasWrites.apiKey));
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("across arbitrary auth forms, every secret counts exactly when its saved directive differs", () => {
		// Inactive fields demote to keep/clear in the intent; the count must
		// read the same demotion. Blocked drafts save nothing, so they are
		// outside the claim and discarded.
		fc.assert(
			fc.property(formSide, formSide, (nowSide, wasSide) => {
				const now = buildDraft(nowSide);
				const was = buildDraft(wasSide);
				const nowWrites = savedDirectives(now);
				const wasWrites = savedDirectives(was);
				fc.pre(nowWrites !== undefined && wasWrites !== undefined);
				if (nowWrites === undefined || wasWrites === undefined) {
					return;
				}
				const changed = changedServerFormFields(now, was);
				for (const field of SECRET_FIELD_IDS) {
					assert.strictEqual(changed.includes(field), !sameDirective(nowWrites[field], wasWrites[field]), field);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("across arbitrary auth forms, every normalized non-secret field counts exactly when its saved value differs", () => {
		// The exact claim of the fix: a raw draft comparison over-counts padded
		// or inactive-leftover text here, and an over-normalized one would
		// under-count a real edit. Blocked drafts save nothing and are outside
		// the claim, so they are discarded.
		fc.assert(
			fc.property(nonSecretDraft, nonSecretDraft, (now, was) => {
				const nowParse = parseServerForm(now);
				const wasParse = parseServerForm(was);
				fc.pre(nowParse.ok && wasParse.ok);
				if (!nowParse.ok || !wasParse.ok) {
					return;
				}
				const changed = changedServerFormFields(now, was);
				for (const field of NORMALIZED_FIELDS) {
					const savedDiffers: boolean =
						JSON.stringify(nowParse.intent.server[field] ?? null) !==
						JSON.stringify(wasParse.intent.server[field] ?? null);
					assert.strictEqual(changed.includes(field), savedDiffers, field);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
