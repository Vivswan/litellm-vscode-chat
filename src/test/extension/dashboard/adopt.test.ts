/**
 * resolveAdoptableCredentials: which external group's credentials an adopt may copy.
 */
import * as assert from "node:assert";
import { resolveAdoptableCredentials, resolveExternalGroupIdentity } from "../../../extension/dashboard/adopt";
import type { DashboardStateInputs } from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { makeServerStatus } from "../../testUtils";
import { buildState, makeDeclared, makeReader } from "./stateHelpers";

suite("extension/dashboard/adopt", () => {
	suite("resolveAdoptableCredentials", () => {
		const groupServers = new Map([
			[
				"group:aaa:http://ext.test",
				{
					baseUrl: normalizeBaseUrl("http://ext.test"),
					apiKey: "sk-one",
				},
			],
			[
				"group:bbb:http://ext.test",
				{
					baseUrl: normalizeBaseUrl("http://ext.test"),
					apiKey: "",
					oauth: {
						tokenUrl: "https://idp.test/token",
						clientId: "client-1",
						clientSecret: "oauth-secret",
						scopes: "read",
					},
					virtualKey: { header: "x-litellm-api-key", value: "vk-1" },
				},
			],
		]);
		const lookup = (serverId: string) => groupServers.get(serverId);
		const snapshotFor = (serverId: string) => ({
			status: makeServerStatus({ serverId, label: "ext.test", baseUrl: "http://ext.test" }),
			models: [],
		});
		const OAUTH_CREDENTIALS = {
			oauthTokenUrl: "https://idp.test/token",
			oauthClientId: "client-1",
			oauthClientSecret: "oauth-secret",
			oauthScopes: "read",
			virtualKeyHeader: "x-litellm-api-key",
			virtualKeyValue: "vk-1",
		};
		/** The handle a row carries, obtained the way the webview obtains it: from the built state. */
		const handleOf = (
			snapshots: DashboardStateInputs["snapshots"],
			declared: DeclaredServerView[],
			label: string
		): string => {
			const server = buildState(snapshots, makeReader({}), declared).servers.find((s) => s.label === label);
			assert.ok(server?.adoptHandle !== undefined, `no adopt handle on row ${label}`);
			return server.adoptHandle;
		};

		test("resolves by the row handle, immune to snapshot order churn on a shared base URL", () => {
			// Two groups on one host: the status window's Map re-inserts entries on
			// refresh, so the rows arrive in either order. The handle rides the
			// serverId, where the old rendered-ordinal match could hand back the
			// OTHER group's key.
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			const first = handleOf(snapshots, [], "ext.test (1)");
			const second = handleOf(snapshots, [], "ext.test (2)");
			for (const ordering of [snapshots, [...snapshots].reverse()]) {
				assert.deepStrictEqual(resolveAdoptableCredentials(ordering, [], "http://ext.test", first, lookup), {
					apiKey: "sk-one",
				});
				assert.deepStrictEqual(
					resolveAdoptableCredentials(ordering, [], "http://ext.test/", second, lookup),
					OAUTH_CREDENTIALS
				);
			}
		});

		test("refuses a source that is declared at intent time (a forged intent cannot clone a declared group's secret)", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			// The handles as pushed while both rows were external; the first
			// group's entry is then declared (adopted or hand-written) before the
			// intent lands.
			const first = handleOf(snapshots, [], "ext.test (1)");
			const second = handleOf(snapshots, [], "ext.test (2)");
			const declared = [
				makeDeclared({
					label: "Prod",
					baseUrl: "http://ext.test",
					expectedClientId: "group:aaa:http://ext.test",
				}),
			];
			assert.strictEqual(
				resolveAdoptableCredentials(snapshots, declared, "http://ext.test", first, lookup),
				undefined,
				"the declared group's credentials must not resolve for an adopt intent"
			);
			assert.deepStrictEqual(
				resolveAdoptableCredentials(snapshots, declared, "http://ext.test", second, lookup),
				OAUTH_CREDENTIALS,
				"the still-external sibling stays adoptable"
			);
		});

		test("binds the handle to the intent's base URL, so copied credentials cannot be re-pointed at another host", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test")];
			const handle = handleOf(snapshots, [], "ext.test");
			assert.strictEqual(resolveAdoptableCredentials(snapshots, [], "http://attacker.test", handle, lookup), undefined);
		});

		test("returns undefined for an unknown handle or a snapshot without group credentials", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test")];
			assert.strictEqual(
				resolveAdoptableCredentials(snapshots, [], "http://ext.test", "not-a-minted-handle", lookup),
				undefined,
				"a handle the extension never minted resolves nothing"
			);
			const registryOnly = [
				{
					status: makeServerStatus({ serverId: "registry-1", label: "ext.test", baseUrl: "http://ext.test" }),
					models: [],
				},
			];
			assert.strictEqual(
				resolveAdoptableCredentials(
					registryOnly,
					[],
					"http://ext.test",
					handleOf(registryOnly, [], "ext.test"),
					lookup
				),
				undefined,
				"a registry snapshot has no group credentials to adopt"
			);
		});

		test("resolveExternalGroupIdentity yields the raw status identity, under the same trust rules", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			// Both ordinal rows resolve to the same raw status identity: the
			// tombstone is keyed by the snapshot's own label, never the display
			// ordinal.
			const handle = handleOf(snapshots, [], "ext.test (1)");
			assert.deepStrictEqual(resolveExternalGroupIdentity(snapshots, [], "http://ext.test", handle), {
				label: "ext.test",
				baseUrl: "http://ext.test",
			});
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, [], "http://attacker.test", handle),
				undefined,
				"bound to the intent's base URL like the adopt path"
			);
			const declared = [
				makeDeclared({ label: "Prod", baseUrl: "http://ext.test", expectedClientId: "group:aaa:http://ext.test" }),
			];
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, declared, "http://ext.test", handle),
				undefined,
				"a declared group's identity must not resolve for a hide intent"
			);
		});
	});
});
