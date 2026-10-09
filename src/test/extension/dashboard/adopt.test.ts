import * as assert from "node:assert";
import type { LiveDeclaration } from "../../../extension/dashboard/adopt";
import { resolveAdoptableCredentials, resolveExternalGroupIdentity } from "../../../extension/dashboard/adopt";
import type { DashboardStateInputs } from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync/engine";
import type { GroupServer } from "../../../provider/catalog/groupModels";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { fixedHeaderValue } from "../../../shared/util/headers";
import { makeServerStatus } from "../../testUtils";
import { buildState, makeDeclared, makeReader } from "./stateHelpers";

const live = (identities: readonly DeclaredServerView[] = []): LiveDeclaration => ({
	identities,
	carriers: [],
	secretValues: new Map(),
});

suite("extension/dashboard/adopt", () => {
	suite("resolveAdoptableCredentials", () => {
		const groupServers = new Map<string, GroupServer>([
			[
				"group:aaa:http://ext.test",
				{
					baseUrl: normalizeBaseUrl("http://ext.test"),
					apiKey: fixedHeaderValue("sk-one"),
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
					virtualKey: { header: "x-litellm-api-key", value: fixedHeaderValue("vk-1") },
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
			// Two groups on one host: the status window's Map re-inserts entries on refresh, so the rows arrive in
			// either order. The handle rides the serverId, where the old rendered-ordinal match could hand back the
			// OTHER group's key.
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			const first = handleOf(snapshots, [], "ext.test (1)");
			const second = handleOf(snapshots, [], "ext.test (2)");
			for (const ordering of [snapshots, [...snapshots].reverse()]) {
				assert.deepStrictEqual(resolveAdoptableCredentials(ordering, live(), "http://ext.test", first, lookup), {
					credentials: { apiKey: "sk-one" },
				});
				assert.deepStrictEqual(resolveAdoptableCredentials(ordering, live(), "http://ext.test/", second, lookup), {
					credentials: OAUTH_CREDENTIALS,
				});
			}
		});

		test("refuses a source that is declared at intent time (a forged intent cannot clone a declared group's secret)", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			// The handles as pushed while both rows were external; the first group's entry is then declared (adopted or
			// hand-written) before the intent lands.
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
				resolveAdoptableCredentials(snapshots, live(declared), "http://ext.test", first, lookup),
				undefined,
				"the declared group's credentials must not resolve for an adopt intent"
			);
			assert.deepStrictEqual(
				resolveAdoptableCredentials(snapshots, live(declared), "http://ext.test", second, lookup),
				{ credentials: OAUTH_CREDENTIALS },
				"the still-external sibling stays adoptable"
			);
		});

		test("binds the handle to the intent's base URL, so copied credentials cannot be re-pointed at another host", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test")];
			const handle = handleOf(snapshots, [], "ext.test");
			assert.strictEqual(
				resolveAdoptableCredentials(snapshots, live(), "http://attacker.test", handle, lookup),
				undefined
			);
		});

		test("resolves nothing for an unknown handle, and a registry-only snapshot as a source without credentials", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test")];
			assert.strictEqual(
				resolveAdoptableCredentials(snapshots, live(), "http://ext.test", "not-a-minted-handle", lookup),
				undefined,
				"a handle the extension never minted resolves nothing"
			);
			const registryOnly = [
				{
					status: makeServerStatus({ serverId: "registry-1", label: "ext.test", baseUrl: "http://ext.test" }),
					models: [],
				},
			];
			assert.deepStrictEqual(
				resolveAdoptableCredentials(
					registryOnly,
					live(),
					"http://ext.test",
					handleOf(registryOnly, [], "ext.test"),
					lookup
				),
				{ credentials: undefined },
				"a registry snapshot is external with no group credentials to adopt"
			);
		});

		test("a group holding a declared label's stored secret value is a leftover, never a credential source", () => {
			// The entry moved to another URL and kept its secure key; the pre-label group at the old URL still carries
			// that value, so copying it would hand a declared key out under a new label.
			const snapshots = [snapshotFor("group:aaa:http://ext.test")];
			const handle = handleOf(snapshots, [], "ext.test");
			const moved = live([makeDeclared({ label: "Prod", baseUrl: "http://new.test" })]);
			assert.deepStrictEqual(
				resolveAdoptableCredentials(snapshots, moved, "http://ext.test", handle, lookup),
				{ credentials: { apiKey: "sk-one" } },
				"with no stored value under the label, the group is the user's own"
			);
			const holding = { ...moved, secretValues: new Map([["Prod", ["sk-one"]]]) };
			assert.strictEqual(resolveAdoptableCredentials(snapshots, holding, "http://ext.test", handle, lookup), undefined);
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, holding, "http://ext.test", handle, lookup),
				undefined
			);
		});

		test("resolveExternalGroupIdentity yields the group's own tombstone identity, under the same trust rules", () => {
			const snapshots = [snapshotFor("group:aaa:http://ext.test"), snapshotFor("group:bbb:http://ext.test")];
			const handle = handleOf(snapshots, [], "ext.test (1)");
			assert.deepStrictEqual(resolveExternalGroupIdentity(snapshots, live(), "http://ext.test", handle, lookup), {
				by: "group",
				groupId: "group:aaa:http://ext.test",
				label: "ext.test",
				baseUrl: "http://ext.test",
			});
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, live(), "http://attacker.test", handle, lookup),
				undefined,
				"bound to the intent's base URL like the adopt path"
			);
			const declared = [
				makeDeclared({ label: "Prod", baseUrl: "http://ext.test", expectedClientId: "group:aaa:http://ext.test" }),
			];
			assert.strictEqual(
				resolveExternalGroupIdentity(snapshots, live(declared), "http://ext.test", handle, lookup),
				undefined,
				"a declared group's identity must not resolve for a hide intent"
			);
		});
	});
});
