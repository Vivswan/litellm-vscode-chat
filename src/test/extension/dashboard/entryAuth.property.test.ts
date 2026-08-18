/**
 * The shared auth assembler's guards (seed-pinned, FUZZ_RUNS-scaled), with
 * serverSync's parser as the independent oracle:
 *  - round trip: every pairing-legal field combination assembles into an auth
 *    object the parser ACCEPTS and reads back to exactly the usable inline
 *    fields, so no credential can silently change or vanish between a save
 *    and the sync engine;
 *  - refusal: the assembler fails exactly the combinations that violate the
 *    pairing rules, routed to the right form field;
 *  - strip: no assembler output can carry a secret outside the auth subtree -
 *    stripEntrySecrets certifies every assembled entry and removes every
 *    inline secret value, so a no-secrets export of an assembled entry can
 *    never ship plaintext credentials.
 *
 * Header names stay valid here on purpose: their charset is the intent
 * boundary's rule (validateConnectionFields), not the assembler's.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { PairingFailure, SecretResolution } from "../../../extension/dashboard/entryAuth";
import { assembleEntryAuth, pairingFailureMessage } from "../../../extension/dashboard/entryAuth";
import { parseServersSetting } from "../../../extension/servers/serverSync/setting";
import { stripEntrySecrets } from "../../../extension/settingsTransfer/secretSurgery";
import type { OptionalEntryFieldId } from "../../../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS, SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

/** A field pool per slot: absent, usable, padded-usable, and whitespace-only shapes. */
const valueArb = (values: readonly string[]) => fc.option(fc.constantFrom(...values), { nil: undefined });

const fieldsArb = fc.record({
	apiKey: valueArb(["sk-test-key", " sk-test-padded ", "  "]),
	oauthTokenUrl: valueArb(["http://idp.test/token", " http://idp.test/token ", "  "]),
	oauthClientId: valueArb(["client-1", " client-1 "]),
	oauthClientSecret: valueArb(["sk-test-secret", " sk-test-secret-padded ", "  "]),
	oauthScopes: valueArb(["read write", "  "]),
	virtualKeyHeader: valueArb(["x-litellm-key", " x-litellm-key "]),
	virtualKeyValue: valueArb(["sk-test-vk", " sk-test-vk-padded ", "  "]),
});

const resolvesArb: fc.Arbitrary<SecretResolution> = fc.record({
	apiKey: fc.boolean(),
	oauthClientSecret: fc.boolean(),
	virtualKeyValue: fc.boolean(),
});

type Fields = { readonly [K in OptionalEntryFieldId]?: string | undefined };

/** The parser's usable-text rule, restated. */
function usable(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** The pairing rules restated naively, in the assembler's failure order. */
function expectedFailure(fields: Fields, resolves: SecretResolution): PairingFailure | undefined {
	const present = (field: "apiKey" | "oauthClientSecret" | "virtualKeyValue"): boolean =>
		usable(fields[field]) !== undefined || resolves[field] === true;
	const tokenUrl = usable(fields.oauthTokenUrl);
	const clientId = usable(fields.oauthClientId);
	const extras = present("oauthClientSecret") || usable(fields.oauthScopes) !== undefined;
	if ((clientId !== undefined || extras) && tokenUrl === undefined) {
		return "oauthTokenUrl";
	}
	if ((tokenUrl !== undefined || extras) && clientId === undefined) {
		return "oauthClientId";
	}
	const header = usable(fields.virtualKeyHeader);
	if (header !== undefined && !present("virtualKeyValue")) {
		return "virtualKeyValue";
	}
	if (header === undefined && present("virtualKeyValue")) {
		return "virtualKeyHeader";
	}
	return undefined;
}

/** The usable inline fields, trimmed: what the parser must read back. */
function usableFields(fields: Fields): Partial<Record<OptionalEntryFieldId, string>> {
	const out: { -readonly [K in OptionalEntryFieldId]?: string } = {};
	for (const { id } of OPTIONAL_ENTRY_FIELDS) {
		const value = usable(fields[id]);
		if (value !== undefined) {
			out[id] = value;
		}
	}
	return out;
}

suite("extension/dashboard/entryAuth: assemble -> parse round trip", () => {
	test("every pairing-legal combination parses back to exactly its usable fields", () => {
		fc.assert(
			fc.property(fieldsArb, resolvesArb, (fields, resolves) => {
				const assembled = assembleEntryAuth(fields, resolves);
				const failure = expectedFailure(fields, resolves);
				if (failure !== undefined) {
					assert.strictEqual(assembled.failure, failure, "the refusal routes to the pairing rule's field");
					// The message routes on the failing field's ASCII id.
					assert.ok(pairingFailureMessage(failure).startsWith(`${failure}: `));
					return;
				}
				assert.strictEqual(assembled.failure, undefined);
				const entry = {
					label: "round-trip",
					baseUrl: "http://round-trip.test",
					...(assembled.auth !== undefined ? { auth: assembled.auth } : {}),
				};
				const { entries, problems } = parseServersSetting([entry]);
				assert.deepStrictEqual(problems, [], "an assembled entry must never parse misconfigured");
				assert.strictEqual(entries.length, 1);
				const parsed = entries[0];
				assert.ok(parsed !== undefined);
				const expected = usableFields(fields);
				for (const { id } of OPTIONAL_ENTRY_FIELDS) {
					assert.strictEqual(parsed[id], expected[id], `field ${id} must round-trip exactly`);
				}
			}),
			{ seed: SEED, numRuns: NUM_RUNS }
		);
	});

	test("no assembler output carries a secret the strip cannot remove", () => {
		fc.assert(
			fc.property(fieldsArb, resolvesArb, (fields, resolves) => {
				const assembled = assembleEntryAuth(fields, resolves);
				if (assembled.failure !== undefined) {
					return;
				}
				const entry = {
					label: "strip",
					baseUrl: "http://strip.test",
					...(assembled.auth !== undefined ? { auth: assembled.auth } : {}),
				};
				const stripped = stripEntrySecrets(entry);
				assert.strictEqual(stripped.unsanitizable, false, "assembled entries are always certifiable");
				const rendered = JSON.stringify(stripped.entry);
				const expected = usableFields(fields);
				for (const field of SECRET_FIELD_IDS) {
					const secret = expected[field];
					if (secret !== undefined) {
						assert.ok(!rendered.includes(secret), `a no-secrets export must not carry ${field}`);
						assert.strictEqual(stripped.secrets[field], secret, `the blob must hold ${field}`);
					}
				}
			}),
			{ seed: SEED, numRuns: NUM_RUNS }
		);
	});
});
