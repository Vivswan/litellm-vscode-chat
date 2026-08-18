/**
 * The probe-save equivalence pin (seed-pinned, FUZZ_RUNS-scaled): for
 * arbitrary drafts - field combinations, secret directives, an existing entry
 * with inline credentials, a stored blob - Test Connection and Save either
 * refuse with the SAME message, or the connection the probe sends equals the
 * credentials the saved entry's provider group would be handed (the written
 * entry parsed by serverSync's own parser, secrets resolved by buildGroupArgs
 * over the post-save blob). OAuth and the virtual key compare as complete
 * units, the only form in which the transport sends them.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { RequestPayload, SecretDirective } from "../../../dashboard/endpoints";
import { executeDashboardIntent } from "../../../extension/dashboard/intents";
import { buildGroupArgs } from "../../../extension/servers/serverSync/engine";
import { acceptedEntry } from "../../../extension/servers/serverSync/setting";
import type { SecretFieldId } from "../../../shared/serverEntry";
import { resolveFuzzSeed } from "../../fuzzStream";
import { makeEnv, type RecordedEnv, serverPayload } from "./recordedEnv";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 120;
const SEED = resolveFuzzSeed();

const optionArb = (values: readonly string[]) => fc.option(fc.constantFrom(...values), { nil: undefined });

/** One secret field's directive; set values include padded and whitespace-only shapes. */
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
	oauthClientSecret: directiveArb(["sk-test-cs-set", " sk-test-cs-padded "]),
	virtualKeyValue: directiveArb(["sk-test-vk-set", " sk-test-vk-padded ", "  "]),
});

const fieldsArb = fc.record({
	oauthTokenUrl: optionArb(["http://idp.test/token", " http://idp.test/token "]),
	oauthClientId: optionArb(["client-1"]),
	oauthScopes: optionArb(["read write"]),
	virtualKeyHeader: optionArb(["x-litellm-key"]),
});

/** An existing "Prod" entry with credentials in each grammar form, or none (a create). */
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

function compact(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
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

suite("extension/dashboard: probe-save equivalence", () => {
	test("Test Connection probes exactly the credentials the saved entry's group would be handed", async () => {
		await fc.assert(
			fc.asyncProperty(fieldsArb, secretsArb, existingArb, blobArb, async (fields, secrets, existing, blob) => {
				const setting = existing !== undefined ? [existing] : [];
				const payload = {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", ...compact(fields) }),
					secrets,
					...(existing !== undefined ? { replaceLabel: "Prod" } : {}),
				} satisfies RequestPayload<"saveServerSetting">;
				const seeded = (): RecordedEnv => {
					const env = makeEnv(setting);
					if (Object.keys(blob).length > 0) {
						env.storedSecrets.set("Prod", { ...blob } as Record<string, string>);
					}
					return env;
				};

				const saveEnv = seeded();
				const probeEnv = seeded();
				const saveError = await outcomeOf(
					executeDashboardIntent({ method: "saveServerSetting", payload }, saveEnv.env)
				);
				const probeError = await outcomeOf(
					executeDashboardIntent({ method: "testServerDraft", payload }, probeEnv.env)
				);

				if (saveError !== undefined || probeError !== undefined) {
					// A draft one path refuses, the other must refuse identically: a
					// probe verdict for an unsavable draft (or a saved entry the probe
					// refused to test) is exactly the divergence this pin forbids.
					assert.strictEqual(probeError?.message, saveError?.message, "refusals must match");
					assert.strictEqual(probeError?.name, saveError?.name);
					return;
				}

				const written = saveEnv.serverWrites.at(-1);
				assert.ok(written !== undefined, "the save landed a settings write");
				const saved = acceptedEntry(written, "Prod");
				assert.ok(saved !== undefined, "a save never writes an entry the parser rejects");
				const args = buildGroupArgs(saved.entry, saveEnv.storedSecrets.get("Prod") ?? {});
				const connection = probeEnv.probes[0];
				assert.ok(connection !== undefined, "the probe ran");

				// The effective credentials on each side: OAuth and the virtual key
				// count only as complete units, mirroring the transport.
				const savedEffective = {
					apiKey: args.apiKey ?? "",
					oauth:
						args.oauthTokenUrl !== undefined && args.oauthClientId !== undefined
							? compact({
									tokenUrl: args.oauthTokenUrl,
									clientId: args.oauthClientId,
									clientSecret: args.oauthClientSecret ?? "",
									scopes: args.oauthScopes,
								})
							: undefined,
					virtualKey:
						args.virtualKeyHeader !== undefined && args.virtualKeyValue !== undefined
							? { header: args.virtualKeyHeader, value: args.virtualKeyValue }
							: undefined,
				};
				const probeEffective = {
					apiKey: connection.apiKey,
					oauth: connection.oauth !== undefined ? compact({ ...connection.oauth }) : undefined,
					virtualKey: connection.virtualKey !== undefined ? { ...connection.virtualKey } : undefined,
				};
				assert.deepStrictEqual(compact(probeEffective), compact(savedEffective));
			}),
			{ seed: SEED, numRuns: NUM_RUNS }
		);
	});
});
