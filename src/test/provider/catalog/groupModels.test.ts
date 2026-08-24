import * as assert from "node:assert";
import * as fc from "fast-check";
import {
	attachGroupServer,
	type GroupServer,
	groupClientId,
	type LiteLLMModelInfo,
	markStale,
	type PreAttachModelInfo,
	parseGroupConfiguration,
	parseModelMetadata,
} from "../../../provider/catalog/groupModels";
import { DEFAULT_REASONING_EFFORT_LEVELS, reasoningEffortSchema } from "../../../provider/catalog/modelConfiguration";
import { type OAuthConfig, oauthCredentialFingerprint } from "../../../provider/transport/auth";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { fingerprint } from "../../../shared/util/fingerprint";
import { resolveFuzzSeed } from "../../fuzzStream";
import { expectDefined, makeModelInfo } from "../../pureHelpers";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

/** The menu the built-in default level list produces; fixtures here carry no per-level server flags. */
const REASONING_EFFORT_SCHEMA = reasoningEffortSchema(DEFAULT_REASONING_EFFORT_LEVELS);

const OAUTH_FIELDS = {
	oauthTokenUrl: "http://idp.test/oauth2/token",
	oauthClientId: "client-1",
	oauthClientSecret: "secret-1",
	oauthScopes: "read write",
};

suite("provider/catalog/groupModels", () => {
	suite("parseGroupConfiguration", () => {
		test("a full OAuth configuration yields the oauth unit with trimmed fields", () => {
			const server = expectDefined(
				parseGroupConfiguration({
					baseUrl: "http://litellm.test",
					...OAUTH_FIELDS,
					oauthTokenUrl: " http://idp.test/oauth2/token ",
					oauthScopes: " read write ",
				})
			);
			assert.deepStrictEqual(server.oauth, {
				tokenUrl: "http://idp.test/oauth2/token",
				clientId: "client-1",
				clientSecret: "secret-1",
				scopes: "read write",
			});
		});

		test("OAuth degrades to absent when the token URL or client ID is missing or unusable", () => {
			const cases: Array<Record<string, unknown>> = [
				{ oauthClientId: "client-1" },
				{ oauthTokenUrl: "http://idp.test/token" },
				{ oauthTokenUrl: "   ", oauthClientId: "client-1" },
				{ oauthTokenUrl: "http://idp.test/token", oauthClientId: 42 },
				{ oauthTokenUrl: "http://idp.test/token", oauthClientId: "" },
			];
			for (const partial of cases) {
				const server = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", ...partial }));
				assert.strictEqual(server.oauth, undefined, `expected no oauth unit for ${JSON.stringify(partial)}`);
			}
		});

		test("a missing or non-string client secret degrades to the empty secret of a public client", () => {
			const server = expectDefined(
				parseGroupConfiguration({
					baseUrl: "http://litellm.test",
					oauthTokenUrl: "http://idp.test/token",
					oauthClientId: "client-1",
					oauthClientSecret: 42,
				})
			);
			assert.strictEqual(expectDefined(server.oauth).clientSecret, "");
		});

		test("blank scopes are omitted from the oauth unit", () => {
			const server = expectDefined(
				parseGroupConfiguration({
					baseUrl: "http://litellm.test",
					oauthTokenUrl: "http://idp.test/token",
					oauthClientId: "client-1",
					oauthScopes: "   ",
				})
			);
			assert.strictEqual(expectDefined(server.oauth).scopes, undefined);
		});

		test("the virtual key is present only with both a valid header name and a value", () => {
			const full = expectDefined(
				parseGroupConfiguration({
					baseUrl: "http://litellm.test",
					virtualKeyHeader: "x-litellm-api-key",
					virtualKeyValue: "vk-1",
				})
			);
			assert.deepStrictEqual(full.virtualKey, { header: "x-litellm-api-key", value: "vk-1" });

			const cases: Array<Record<string, unknown>> = [
				{ virtualKeyHeader: "x-litellm-api-key" },
				{ virtualKeyValue: "vk-1" },
				{ virtualKeyHeader: "", virtualKeyValue: "vk-1" },
				{ virtualKeyHeader: "not a header name", virtualKeyValue: "vk-1" },
				{ virtualKeyHeader: "x-key:", virtualKeyValue: "vk-1" },
				{ virtualKeyHeader: "x-litellm-api-key", virtualKeyValue: 42 },
			];
			for (const partial of cases) {
				const server = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", ...partial }));
				assert.strictEqual(server.virtualKey, undefined, `expected no virtual key for ${JSON.stringify(partial)}`);
			}
		});

		test("virtual-key values are trimmed, and interior control characters degrade the key to absent", () => {
			const trimmed = expectDefined(
				parseGroupConfiguration({
					baseUrl: "http://litellm.test",
					virtualKeyHeader: "x-vk",
					virtualKeyValue: "\r\n vk-1 \r\n",
				})
			);
			assert.deepStrictEqual(
				trimmed.virtualKey,
				{ header: "x-vk", value: "vk-1" },
				"leading and trailing whitespace is harmless and stripped"
			);

			const invalidValues = ["vk\r\nInjected: x", "vk\n1", "vk\r1", "vk\u00001", "   "];
			for (const virtualKeyValue of invalidValues) {
				const server = expectDefined(
					parseGroupConfiguration({ baseUrl: "http://litellm.test", virtualKeyHeader: "x-vk", virtualKeyValue })
				);
				assert.strictEqual(
					server.virtualKey,
					undefined,
					`expected no virtual key for value ${JSON.stringify(virtualKeyValue)}`
				);
			}
		});

		test("a rejected virtual key logs the header name once and never the value; absence stays silent", () => {
			const lines: string[] = [];
			const log = (message: string, data?: unknown) => lines.push(`${message} ${JSON.stringify(data ?? null)}`);

			const noKey = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test" }, log));
			assert.strictEqual(noKey.virtualKey, undefined);
			assert.strictEqual(lines.length, 0, "an unconfigured virtual key must not be logged as rejected");

			const config = {
				baseUrl: "http://litellm.test",
				virtualKeyHeader: "x-header-with-typo-value",
				virtualKeyValue: "secret\nvalue",
			};
			assert.strictEqual(expectDefined(parseGroupConfiguration(config, log)).virtualKey, undefined);
			assert.strictEqual(expectDefined(parseGroupConfiguration(config, log)).virtualKey, undefined);

			const warnings = lines.filter((line) => line.includes("x-header-with-typo-value"));
			assert.strictEqual(warnings.length, 1, `the rejection must be logged once. Lines: ${lines.join(" | ")}`);
			assert.ok(
				lines.every((line) => !line.includes("secret")),
				`the virtual key value leaked into the log: ${lines.join(" | ")}`
			);
		});

		test("unknown configuration fields are ignored", () => {
			const server = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", futureField: { nested: true } })
			);
			assert.deepStrictEqual(server, { baseUrl: "http://litellm.test", apiKey: "k" });
		});

		test("the entry label is consumed trimmed; junk or blank labels degrade to absent", () => {
			const labeled = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", label: " Prod " })
			);
			assert.strictEqual(labeled.label, "Prod");
			for (const label of [42, "", "   ", null]) {
				const server = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", label }));
				assert.strictEqual(server.label, undefined, `expected no label for ${JSON.stringify(label)}`);
			}
		});

		test("pre-OAuth narrowing is unchanged: trailing slashes trimmed, non-string apiKey means keyless", () => {
			assert.deepStrictEqual(parseGroupConfiguration({ baseUrl: "http://litellm.test//", apiKey: 42 }), {
				baseUrl: "http://litellm.test",
				apiKey: "",
			});
			assert.strictEqual(parseGroupConfiguration({ apiKey: "k" }), undefined);
			assert.strictEqual(parseGroupConfiguration("http://litellm.test"), undefined);
			assert.strictEqual(parseGroupConfiguration(null), undefined);
		});
	});

	suite("groupClientId", () => {
		const plain: GroupServer = { baseUrl: normalizeBaseUrl("http://litellm.test"), apiKey: "k" };

		test("one identity format: group:<fingerprint of the identity tuple>:<baseUrl>", () => {
			// The equality pin of the encoding itself: the fixed-arity tuple with
			// one slot per component, absent components as null, hashed as one
			// JSON string. A slot added, dropped, or reordered fails here.
			const tuple = JSON.stringify(["http://litellm.test", null, "k", null, null]);
			assert.strictEqual(groupClientId(plain), `group:${fingerprint(tuple)}:http://litellm.test`);
		});

		test("entries sharing a base URL and every credential get distinct identities from their labels", () => {
			// Two declared entries, one server, one key. Without the label both
			// would collapse to one status-window entry and the second could never
			// report.
			const prod = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", label: "Prod" })
			);
			const staging = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", label: "Staging" })
			);
			assert.notStrictEqual(groupClientId(prod), groupClientId(staging));
			assert.notStrictEqual(groupClientId(prod), groupClientId(plain), "labeled and unlabeled identities differ");
			const relabeled = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", label: "Prod" })
			);
			assert.strictEqual(groupClientId(prod), groupClientId(relabeled), "equal configurations, equal identities");
		});

		test("a labeled OAuth configuration cannot encode like an unlabeled one", () => {
			// The label slot is null or a string, so a labeled identity's tuple can
			// never equal an unlabeled one's.
			const unlabeled = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", ...OAUTH_FIELDS }));
			const labeled = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", ...OAUTH_FIELDS, label: "Prod" })
			);
			assert.notStrictEqual(groupClientId(labeled), groupClientId(unlabeled));
		});

		test("rotating the client secret mints a new identity", () => {
			const withOAuth = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", ...OAUTH_FIELDS }));
			const rotated = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", ...OAUTH_FIELDS, oauthClientSecret: "rotated" })
			);
			assert.notStrictEqual(groupClientId(rotated), groupClientId(withOAuth));
			assert.notStrictEqual(groupClientId(withOAuth), groupClientId(plain));
		});

		test("rotating the virtual key mints a new identity, and no identity embeds the secrets", () => {
			const withKey = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-1" })
			);
			const rotated = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-2" })
			);
			assert.notStrictEqual(groupClientId(rotated), groupClientId(withKey));
			assert.ok(!groupClientId(withKey).includes("vk-1"));

			const withOAuth = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", ...OAUTH_FIELDS }));
			assert.ok(!groupClientId(withOAuth).includes("secret-1"));
		});

		test("equal configurations map to equal identities", () => {
			const first = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", ...OAUTH_FIELDS }));
			const second = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", ...OAUTH_FIELDS }));
			assert.strictEqual(groupClientId(first), groupClientId(second));
		});

		test("rotating any credential part mints a new identity: every OAuth field, the API key, both virtual-key halves", () => {
			// The OAuth half of the identity is oauthCredentialFingerprint, so each
			// rotation must move the fingerprint and the group ID together; a field
			// the fingerprint stopped covering would fail both assertions.
			const base = {
				baseUrl: "http://litellm.test",
				apiKey: "k",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client-1",
				oauthClientSecret: "secret-1",
				oauthScopes: "read",
				virtualKeyHeader: "x-vk",
				virtualKeyValue: "vk-1",
			};
			const baseline = expectDefined(parseGroupConfiguration(base));
			const rotations: Partial<typeof base>[] = [
				{ apiKey: "k2" },
				{ oauthTokenUrl: "https://idp2.test/token" },
				{ oauthClientId: "client-2" },
				{ oauthClientSecret: "secret-2" },
				{ oauthScopes: "read write" },
				{ virtualKeyHeader: "x-vk-2" },
				{ virtualKeyValue: "vk-2" },
			];
			for (const rotation of rotations) {
				const rotated = expectDefined(parseGroupConfiguration({ ...base, ...rotation }));
				const which = Object.keys(rotation).join(",");
				assert.notStrictEqual(groupClientId(rotated), groupClientId(baseline), `rotating ${which}`);
				if (rotated.oauth !== undefined && baseline.oauth !== undefined) {
					const oauthRotation = which.startsWith("oauth");
					assert.strictEqual(
						oauthCredentialFingerprint(rotated.oauth) !== oauthCredentialFingerprint(baseline.oauth),
						oauthRotation,
						`the OAuth fingerprint moves exactly with OAuth rotations (${which})`
					);
				}
			}
		});

		test("adding or dropping the whole OAuth or virtual-key unit mints a new identity", () => {
			const bare = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k" }));
			const withOAuth = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", ...OAUTH_FIELDS })
			);
			const withKey = expectDefined(
				parseGroupConfiguration({
					baseUrl: "http://litellm.test",
					apiKey: "k",
					virtualKeyHeader: "x-vk",
					virtualKeyValue: "vk-1",
				})
			);
			assert.notStrictEqual(groupClientId(withOAuth), groupClientId(bare));
			assert.notStrictEqual(groupClientId(withKey), groupClientId(bare));
			assert.notStrictEqual(groupClientId(withOAuth), groupClientId(withKey));
		});

		test("an API key spelling another identity's encoding never collides with the identity it spells", () => {
			// Deterministic regression pairs the seeded property may never sample:
			// the API key is free-form, so a bare key can be byte-for-byte the JSON
			// text of another identity's tuple (current format), a retired format's
			// credential JSON, or raw delimiter material. JSON slot escaping must
			// keep every such key inside its own slot; a collision would merge
			// status entries and reuse the wrong discovery cache.
			const genuineLabeled = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", label: "Prod" })
			);
			const genuineOAuth = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", ...OAUTH_FIELDS }));
			const genuineWithKey = expectDefined(
				parseGroupConfiguration({
					baseUrl: "http://litellm.test",
					apiKey: "k",
					virtualKeyHeader: "x-vk",
					virtualKeyValue: "vk-1",
				})
			);
			const spellings: ReadonlyArray<[string, string, GroupServer]> = [
				[
					"the current tuple text of the labeled identity",
					JSON.stringify(["http://litellm.test", "Prod", "k", null, null]),
					genuineLabeled,
				],
				["the retired labeled form's credential JSON", '["k",null,null,"Prod"]', genuineLabeled],
				[
					"the retired credentialed form's credential JSON",
					JSON.stringify(["", oauthCredentialFingerprint(expectDefined(genuineOAuth.oauth)), null]),
					genuineOAuth,
				],
				["raw delimiter material", "k\nvirtual-key\nx-vk\nvk-1", genuineWithKey],
			];
			for (const [name, apiKey, genuine] of spellings) {
				const smuggled = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey }));
				assert.notStrictEqual(groupClientId(smuggled), groupClientId(genuine), name);
			}
		});

		test("property: one injective encoding covers every identity component the old namespaces guarded (seed-pinned)", () => {
			// Ground truth is component-wise equality, independent of any string
			// encoding, so an encoding flaw that let two different identities
			// serialize identically would fail here. Small domains make component
			// collisions common, so both directions get real coverage: equal
			// components must share an ID, and ANY differing component must move
			// it. The API key domain carries the old smuggling vectors - keys
			// spelling the JSON text of labeled, credentialed, and current-format
			// identities, plus raw delimiter material - which the retired
			// labeled:/cred: namespace segments used to guard.
			const baseUrlArb = fc.constantFrom(...["http://a.test", "http://b.test"].map((url) => normalizeBaseUrl(url)));
			const labelArb = fc.option(fc.constantFrom("Prod", "Staging"), { nil: undefined });
			const apiKeyArb = fc.constantFrom(
				"",
				"k",
				"k2",
				'["http://a.test","Prod","k",null,null]',
				'["k",null,null,"Prod"]',
				'["",null,null]',
				"k\nvirtual-key\nx-vk\nvk-1"
			);
			const oauthArb = fc.option(
				fc
					.tuple(
						fc.constantFrom("http://idp.test/token", "http://idp2.test/token"),
						fc.constantFrom("client-1", "client-2"),
						fc.constantFrom("", "secret-1"),
						fc.option(fc.constantFrom("read", ""), { nil: undefined })
					)
					.map(
						([tokenUrl, clientId, clientSecret, scopes]): OAuthConfig => ({
							tokenUrl,
							clientId,
							clientSecret,
							...(scopes !== undefined ? { scopes } : {}),
						})
					),
				{ nil: undefined }
			);
			const virtualKeyArb = fc.option(
				fc
					.tuple(fc.constantFrom("x-vk", "x-vk-2"), fc.constantFrom("vk-1", "vk-2"))
					.map(([header, value]) => ({ header, value })),
				{ nil: undefined }
			);
			const serverArb = fc.tuple(baseUrlArb, labelArb, apiKeyArb, oauthArb, virtualKeyArb).map(
				([baseUrl, label, apiKey, oauth, virtualKey]): GroupServer => ({
					baseUrl,
					apiKey,
					...(label !== undefined ? { label } : {}),
					...(oauth !== undefined ? { oauth } : {}),
					...(virtualKey !== undefined ? { virtualKey } : {}),
				})
			);
			// OAuth compares by its credential fingerprint, production's own unit of
			// OAuth identity (scopes "" and absent are the same material there).
			const sameIdentity = (a: GroupServer, b: GroupServer): boolean =>
				a.baseUrl === b.baseUrl &&
				(a.label ?? null) === (b.label ?? null) &&
				a.apiKey === b.apiKey &&
				(a.oauth ? oauthCredentialFingerprint(a.oauth) : null) ===
					(b.oauth ? oauthCredentialFingerprint(b.oauth) : null) &&
				(a.virtualKey?.header ?? null) === (b.virtualKey?.header ?? null) &&
				(a.virtualKey?.value ?? null) === (b.virtualKey?.value ?? null);
			fc.assert(
				fc.property(serverArb, serverArb, (a, b) => {
					assert.strictEqual(
						groupClientId(a) === groupClientId(b),
						sameIdentity(a, b),
						`IDs must agree with identities:\n${JSON.stringify(a)}\n${JSON.stringify(b)}`
					);
				}),
				{ seed: SEED, numRuns: NUM_RUNS }
			);
		});
	});

	suite("parseModelMetadata", () => {
		test("OAuth and virtual-key units survive the attach round trip", () => {
			const server = expectDefined(
				parseGroupConfiguration({
					baseUrl: "http://litellm.test",
					apiKey: "k",
					...OAUTH_FIELDS,
					virtualKeyHeader: "x-vk",
					virtualKeyValue: "vk-1",
				})
			);
			const model = attachGroupServer(makeModelInfo(), server);
			assert.deepStrictEqual(parseModelMetadata(model).server, server);
		});

		test("the entry label survives the attach round trip, so the request path can reach it", () => {
			const server = expectDefined(
				parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k", label: "Prod" })
			);
			const parsed = expectDefined(parseModelMetadata(attachGroupServer(makeModelInfo(), server)).server);
			assert.strictEqual(parsed.label, "Prod");
			assert.strictEqual(groupClientId(parsed), groupClientId(server), "one entry, one identity, either side");
		});

		test("attachGroupServer keeps the configuration schema on the model", () => {
			const server = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k" }));
			const model = attachGroupServer(makeModelInfo({ configurationSchema: REASONING_EFFORT_SCHEMA }), server);
			assert.deepStrictEqual(
				model.configurationSchema,
				REASONING_EFFORT_SCHEMA,
				"the metadata rebuild must not drop the picker schema"
			);
		});

		test("attachGroupServer carries the audio-input gate and parseModelMetadata re-narrows it", () => {
			const server = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k" }));
			const audioModel = attachGroupServer(
				makeModelInfo({
					litellm: {
						rawModelId: "test-model",
						supportsPromptCaching: false,
						outputLimitSource: "defaults",
						supportsAudioInput: true,
						serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
					},
				}),
				server
			);
			assert.strictEqual(audioModel.litellm.supportsAudioInput, true, "the metadata rebuild must not drop the gate");
			assert.strictEqual(parseModelMetadata(audioModel).supportsAudioInput, true);
			assert.strictEqual(
				parseModelMetadata(makeModelInfo({ capabilities: { imageInput: true } })).imageInput,
				true,
				"the imageInput capability rides the same one-parse boundary"
			);
			assert.strictEqual(parseModelMetadata(makeModelInfo()).imageInput, false);
			// Older metadata without the field, and junk across the host boundary, read as false.
			assert.strictEqual(parseModelMetadata(makeModelInfo()).supportsAudioInput, false);
			const junk = {
				...makeModelInfo(),
				litellm: { supportsPromptCaching: false, outputLimitSource: "defaults", supportsAudioInput: "yes" },
			} as unknown as LiteLLMModelInfo;
			assert.strictEqual(parseModelMetadata(junk).supportsAudioInput, false);
		});

		test("the type system refuses an attached copy where a pre-attach info belongs", () => {
			const server = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k" }));
			const attached = attachGroupServer(makeModelInfo(), server);
			// The one-token-away mistake the split exists to stop: caching or
			// snapshotting attach(...) output instead of the pre-attach infos.
			// @ts-expect-error an attached copy embeds the group's credentials and is not a PreAttachModelInfo
			const leaked: PreAttachModelInfo = attached;
			void leaked;
			assert.deepStrictEqual(attached.litellm.server, server, "the attached copy itself keeps its server");
		});

		test("a malformed oauth sub-object coming back across the host boundary degrades to absent", () => {
			// Built by hand, not through attachGroupServer: this is the hostile
			// round-trip shape whose type the host boundary cannot vouch for.
			const model = {
				...makeModelInfo(),
				litellm: {
					supportsPromptCaching: false,
					outputLimitSource: "defaults",
					server: {
						baseUrl: "http://litellm.test",
						apiKey: "k",
						oauth: { tokenUrl: "http://idp.test/token" },
						virtualKey: { header: "x-vk" },
					},
				},
			} as unknown as LiteLLMModelInfo;
			assert.deepStrictEqual(parseModelMetadata(model).server, { baseUrl: "http://litellm.test", apiKey: "k" });
		});

		test("a trailing slash coming back across the host boundary re-normalizes to the parsed identity", () => {
			const parsed = expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k" }));
			const roundTrip = {
				...makeModelInfo(),
				litellm: {
					supportsPromptCaching: false,
					outputLimitSource: "defaults",
					server: { baseUrl: "http://litellm.test/", apiKey: "k" },
				},
			} as unknown as LiteLLMModelInfo;
			const server = expectDefined(parseModelMetadata(roundTrip).server);
			assert.strictEqual(server.baseUrl, "http://litellm.test");
			assert.strictEqual(groupClientId(server), groupClientId(parsed), "one server, one identity, either spelling");
		});

		test("a URL that normalizes to nothing degrades to absent, like the configuration parse", () => {
			const model = {
				...makeModelInfo(),
				litellm: {
					supportsPromptCaching: false,
					outputLimitSource: "defaults",
					server: { baseUrl: "///", apiKey: "k" },
				},
			} as unknown as LiteLLMModelInfo;
			assert.strictEqual(parseModelMetadata(model).server, undefined);
		});
	});

	suite("markStale", () => {
		const server = () => expectDefined(parseGroupConfiguration({ baseUrl: "http://litellm.test", apiKey: "k" }));

		test("stamps the warning icon and a connectivity banner on fresh copies, leaving the inputs untouched", () => {
			const attached = [attachGroupServer(makeModelInfo(), server())];
			const stale = markStale(attached, "1/1/2026, 9:30:00 AM");

			assert.strictEqual(stale.length, 1);
			const decorated = expectDefined(stale[0]);
			assert.strictEqual(expectDefined(decorated.statusIcon).id, "warning");
			assert.deepStrictEqual(decorated.warningText, {
				connectivity:
					"The server is unreachable; showing the models from its last successful sync at 1/1/2026, 9:30:00 AM.",
			});
			assert.deepStrictEqual(decorated.litellm.server, server(), "the attached server survives the decoration");

			const input = expectDefined(attached[0]);
			assert.ok(!("statusIcon" in input), "decoration happens on copies; the input must stay clean");
			assert.ok(!("warningText" in input), "decoration happens on copies; the input must stay clean");
		});

		test("accepts attached copies only, so decorated objects cannot enter the cache or snapshot paths", () => {
			// Those paths hold PreAttachModelInfo; if markStale accepted it, a
			// credential-carrying copy could be cached or pushed to the dashboard,
			// and a stale icon would survive a healthy sweep.
			// @ts-expect-error markStale takes AttachedModelInfo, never the pre-attach registration output
			const rejected = () => markStale([makeModelInfo()], "1/1/2026, 9:30:00 AM");
			void rejected;
		});
	});
});
