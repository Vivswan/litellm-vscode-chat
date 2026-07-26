import * as assert from "node:assert";
import {
	attachGroupServer,
	type GroupServer,
	getGroupServer,
	groupClientId,
	parseGroupConfiguration,
} from "../../provider/groupModels";
import { fingerprint } from "../../shared/fingerprint";
import { expectDefined, makeModelInfo } from "../testUtils";

const OAUTH_FIELDS = {
	oauthTokenUrl: "http://idp.test/oauth2/token",
	oauthClientId: "client-1",
	oauthClientSecret: "secret-1",
	oauthScopes: "read write",
};

suite("provider/groupModels", () => {
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
		const plain: GroupServer = { baseUrl: "http://litellm.test", apiKey: "k" };

		test("servers without OAuth or a virtual key keep the pre-OAuth identity format", () => {
			assert.strictEqual(groupClientId(plain), `group:${fingerprint("k")}:http://litellm.test`);
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
	});

	suite("getGroupServer", () => {
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
			assert.deepStrictEqual(getGroupServer(model), server);
		});

		test("a malformed oauth sub-object coming back across the host boundary degrades to absent", () => {
			const model = makeModelInfo({
				litellm: {
					supportsPromptCaching: false,
					server: {
						baseUrl: "http://litellm.test",
						apiKey: "k",
						oauth: { tokenUrl: "http://idp.test/token" },
						virtualKey: { header: "x-vk" },
					} as unknown as GroupServer,
				},
			});
			assert.deepStrictEqual(getGroupServer(model), { baseUrl: "http://litellm.test", apiKey: "k" });
		});
	});
});
