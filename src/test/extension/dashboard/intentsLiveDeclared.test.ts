/**
 * The adopt and hide intents resolve a row handle against the setting as it stands, not against the views the last
 * sync pass published. Each row drives the production intent environment (createIntentEnvironment) over the real
 * engine and a fake host, in a window where a weaker resolution would hand out a declared entry's secret.
 */
import * as assert from "node:assert";
import type { RequestPayload } from "../../../dashboard/endpoints";
import type { DashboardServer, DashboardState } from "../../../dashboard/viewModels";
import { adoptSourceHandle, modelScopeKey } from "../../../extension/dashboard/adoptHandle";
import { secretValueHolders } from "../../../extension/dashboard/declaredJoin";
import type { DeclaredServersInput } from "../../../extension/dashboard/declaredServers";
import { declaredViewsFromSetting } from "../../../extension/dashboard/declaredServers";
import type { IntentEnvironment } from "../../../extension/dashboard/intents";
import { DashboardValidationError, executeDashboardIntent } from "../../../extension/dashboard/intents";
import { createIntentEnvironment } from "../../../extension/dashboard/panel";
import { buildDashboardState } from "../../../extension/dashboard/state";
import { GroupRemovalStore } from "../../../extension/servers/groupRemovals";
import type { SecretStore } from "../../../extension/servers/serverSync";
import { acceptedEntry, ServerSyncEngine, serverSettingReports } from "../../../extension/servers/serverSync";
import { readServerSecretsRecord, secretDestination } from "../../../extension/servers/serverSync/secrets";
import type { SettingsAccess } from "../../../extension/settingsAccess";
import { inSettingsWriteTurn, settingValueOf } from "../../../extension/settingsWriteTurn";
import type { GroupServer } from "../../../provider/catalog/groupModels";
import { groupClientId, groupServerLabel, parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../../provider/catalog/statusWindow";
import { serverSecretsKey } from "../../../shared/config/storageKeys";
import { fixedHeaderValue } from "../../../shared/util/headers";
import { makeModelInfo } from "../../pureHelpers";
import { fakeFingerprintSaltSession, makeExtensionStorage, makeServerStatus } from "../../testUtils";
import { makeSecretStore, makeSyncEnv } from "../servers/serverSyncHelpers";
import { makeReader } from "./stateHelpers";

const H = "http://h.test";
/** The status label an unlabeled group at H reports under: discovery's URL-host fallback. */
const HOST = "h.test";
const SECRET = "s3cret";

/** A host whose add hands the group to the provider at once and then, while held, blocks like a slow serve. */
function makeHost() {
	const snapshots: ServerModelsSnapshot[] = [];
	const servers = new Map<string, GroupServer>();
	/** Each group's server ID by the name it was added under; the extension never sees the name itself. */
	const names = new Map<string, string>();
	/** Names the host refuses as an add-only host refuses an existing name. */
	const taken = new Set<string>();
	/** Every add the engine attempted, refused ones included. */
	const attempted: string[] = [];
	let gate: Promise<void> | undefined;
	return {
		snapshots,
		servers,
		names,
		taken,
		attempted,
		addProviderGroup: async (args: Readonly<Record<string, string>>) => {
			attempted.push(args.name ?? "");
			if (taken.has(args.name ?? "")) {
				throw new Error(`Language model group with name ${args.name} already exists for vendor litellm`);
			}
			const server = parseGroupConfiguration(args)?.server;
			assert.ok(server !== undefined);
			const serverId = groupClientId(server);
			servers.set(serverId, server);
			names.set(args.name ?? "", serverId);
			snapshots.push({
				// The status label as discovery reports it: the configured entry label, else the URL host.
				status: makeServerStatus({
					serverId,
					label: server.label ?? groupServerLabel(server.baseUrl),
					baseUrl: args.baseUrl ?? "",
					servedModelCount: 1,
				}),
				// One model per group, so a hide's effect on the models list is observable.
				models: [makeModelInfo({ id: `${args.name}-model`, name: `${args.name}-model` })],
				...(args.label !== undefined ? { entryLabel: args.label } : {}),
			});
			await gate;
		},
		hold(): () => void {
			let release!: () => void;
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				gate = undefined;
				release();
			};
		},
	};
}

interface Fixture {
	engine: ServerSyncEngine;
	env: IntentEnvironment;
	host: ReturnType<typeof makeHost>;
	/** Every array the servers setting was written with. */
	writes: unknown[][];
	/** The real removal store the intents and the push share. */
	removals: GroupRemovalStore;
	/** Runs before every SecretStorage read of the given label's blob (the engine's and the intents'). */
	onSecretRead: ((label: string) => void) | undefined;
	/** Replace the servers setting outright, any value, as a hand edit or another window would. */
	declare(value: unknown): void;
	/** Land a secure API key for a declared label without awaiting, stamped for the entry as the setting holds it. */
	storeSecureKey(label: string, value: string): void;
	/** The state push as the panel assembles it: the engine's views (else the settings fallback), reports, holders. */
	pushedState(): DashboardState;
	/** The declared labels the push's legacy rows belong to: leftovers drawn without adopt or hide. */
	pushedLegacyRows(): string[];
	/** The handle the push's external row for the group added under `name` carries; undefined when none is drawn. */
	pushedHandle(name: string): string | undefined;
	/** The handle of the group added under `name`, whether or not the push draws it. */
	handleOf(name: string): string;
	currentSetting(): unknown;
	/** Every stored API key by label, as SecretStorage holds them now. */
	secretsSnapshot(): Record<string, unknown>;
	/** Every SecretStorage store or delete, as "store <label>" or "delete <label>". */
	secretOps: string[];
}

/** The production intent environment over fakes for the stores, the host, and the removal ledger. */
function makeFixture(): Fixture {
	const host = makeHost();
	// The user scope: undefined until something is set, an explicit [] after a write of none. The engine reads the
	// effective value, where the schema default [] fills an unset scope, as in VS Code.
	let globalSetting: unknown;
	const effective = (): unknown => (globalSetting === undefined ? [] : globalSetting);
	const writes: unknown[][] = [];
	const settingsAccess: SettingsAccess = {
		readGlobal: () => globalSetting,
		readEffective: effective,
		inspect: () => undefined,
		writeGlobal: async (_key, value) => {
			writes.push([...(value as readonly unknown[])]);
			globalSetting = structuredClone(value);
		},
		readServersSetting: () => globalSetting,
		writeServersSetting: async (write) => {
			const value = settingValueOf(write);
			writes.push([...(value as readonly unknown[])]);
			globalSetting = structuredClone(value);
		},
		writeTurn: (apply) => inSettingsWriteTurn((turn) => apply(settingsAccess, turn)),
		updateAuto: async () => {},
		removeConfigured: async () => {},
		snapshotReader: () => ({ get: () => undefined, inspect: () => undefined }),
	};
	const blobs = makeSecretStore();
	const fixture: Fixture = {
		host,
		writes,
		removals: new GroupRemovalStore(makeExtensionStorage().memento, fakeFingerprintSaltSession()),
		secretOps: [],
		currentSetting: effective,
		secretsSnapshot: () =>
			Object.fromEntries(
				[...blobs.values.entries()].map(([key, blob]) => [key.slice(serverSecretsKey("").length), JSON.parse(blob)])
			),
		onSecretRead: undefined,
		declare: (value) => {
			globalSetting = structuredClone(value);
		},
		storeSecureKey: (label, value) => {
			const entry = acceptedEntry(effective(), label)?.entry;
			assert.ok(entry !== undefined);
			blobs.values.set(
				serverSecretsKey(label),
				JSON.stringify({ apiKey: value, _owner: { apiKey: secretDestination(entry, "apiKey") } })
			);
		},
		pushedState: () => {
			const views = fixture.engine.getDeclared();
			const declared: DeclaredServersInput =
				views.length > 0 ? { source: "engine", views } : declaredViewsFromSetting(effective());
			return buildDashboardState({
				snapshots: host.snapshots,
				reader: makeReader({}),
				declared,
				entryReports: serverSettingReports(effective()),
				removedGroups: { tombstones: fixture.removals.tombstones(), origins: [] },
				secretHolders: secretValueHolders(
					host.snapshots,
					(serverId) => host.servers.get(serverId),
					fixture.engine.getSecretValues()
				),
			});
		},
		pushedLegacyRows: () =>
			fixture.pushedState().servers.flatMap((server) => (server.origin === "legacy" ? [server.entryLabel] : [])),
		handleOf: (name) => {
			const serverId = host.names.get(name);
			assert.ok(serverId !== undefined, `no group was added under ${name}`);
			return adoptSourceHandle(serverId);
		},
		pushedHandle: (name) => {
			const handle = fixture.handleOf(name);
			return fixture.pushedState().servers.find((row) => row.adoptHandle === handle)?.adoptHandle;
		},
		engine: undefined as unknown as ServerSyncEngine,
		env: undefined as unknown as IntentEnvironment,
	};
	const secrets: SecretStore = {
		get: async (key) => {
			fixture.onSecretRead?.(key.slice(serverSecretsKey("").length));
			return blobs.get(key);
		},
		store: async (key, value) => {
			fixture.secretOps.push(`store ${key.slice(serverSecretsKey("").length)}`);
			await blobs.store(key, value);
		},
		delete: async (key) => {
			fixture.secretOps.push(`delete ${key.slice(serverSecretsKey("").length)}`);
			await blobs.delete(key);
		},
	};
	fixture.engine = new ServerSyncEngine(
		{
			...makeSyncEnv().env,
			observedSnapshots: () => host.snapshots,
			readServersSetting: effective,
			readSecrets: (label) => readServerSecretsRecord(secrets, label),
			addProviderGroup: host.addProviderGroup,
		},
		400
	);
	fixture.env = createIntentEnvironment({
		provider: { getServerSnapshots: () => host.snapshots, getGroupServer: (serverId) => host.servers.get(serverId) },
		syncEngine: fixture.engine,
		removals: fixture.removals,
		settingsAccess,
		secrets,
		logger: { log: () => {} },
		ua: fixedHeaderValue("test"),
		featureProbes: {},
		refreshCatalogNow: () => {},
		refreshUsageNow: () => {},
	});
	return fixture;
}

function saveSecure(label: string, baseUrl: string, value = SECRET): RequestPayload<"saveServerSetting"> {
	return {
		server: {
			label,
			baseUrl,
			modelCapabilities: {},
			expectedFailures: [],
			headers: {},
			declaredModels: [],
			includeModes: [],
			budget: null,
			mcp: null,
		},
		secrets: {
			apiKey: { action: "set", location: "secure", value },
			oauthClientSecret: { action: "keep" },
			virtualKeyValue: { action: "keep" },
		},
	};
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Opened {
	/** A handle for the group that carries the secret, minted the way the window allows. */
	handle: string;
	close(): Promise<void>;
}

interface Scenario {
	open(fixture: Fixture): Promise<Opened>;
	/** The intents the window applies to; hide has no step between its resolution and its write. */
	intents: readonly ("adopt" | "hide")[];
	adopt: "rejects" | { readonly copies: string };
	/** What hide throws, and adopt when it rejects: the stale-row validation error, or the failed secrets read. */
	refusal: RegExp | typeof DashboardValidationError | ((error: unknown) => boolean);
	/**
	 * The declared setting, the stored API keys, and the tombstones once the intent has run, the window's mid-intent
	 * changes included; `hidden` names the one group hide may tombstone, and its absence means hide refuses.
	 */
	after: {
		readonly setting: unknown;
		readonly secrets: Readonly<Record<string, unknown>>;
		readonly hidden?: readonly { label: string; baseUrl: string }[];
		/**
		 * The push once the window's own mid-intent change has landed, for the windows that make one; the others
		 * expect the push before the intent, minus exactly the hidden group.
		 */
		readonly push?: {
			/** The full rows the move adds; every row and model is compared whole. */
			readonly added: readonly DashboardServer[];
			/** Row fields the move legitimately changes on any row; none in these windows. */
			readonly changed?: readonly string[];
		};
	};
}

const A_ENTRY = { label: "A", baseUrl: "http://a.test" };
const L1_ENTRY = { label: "L1", baseUrl: H };
const L1_INLINE = { label: "L1", baseUrl: H, auth: { apiKey: SECRET } };
/**
 * The row the settings fallback draws for L1_INLINE before any pass has joined it: its key is only known to exist,
 * nothing is checked, and no credential value or scope key reaches the push.
 */
const L1_FALLBACK_ROW: DashboardServer = {
	baseUrl: H,
	config: { secrets: { kind: "unproven" } },
	credentials: "present",
	hasOAuth: false,
	hasVirtualKey: false,
	label: "L1",
	lastChecked: undefined,
	origin: "declared",
	servedModelCount: 0,
	state: "unchecked",
};
/** An OAuth block without its client id: the parser refuses the entry whole. */
const L1_REJECTED = { label: "L1", baseUrl: H, auth: { oauth: { tokenUrl: "https://idp.test/token" } } };
/** L1 after its token URL moved to another identity provider; the client secret is the one its legacy group holds. */
const L1_OAUTH_ROTATED = {
	label: "L1",
	baseUrl: H,
	auth: { oauth: { tokenUrl: "https://idp2.test/token", clientId: "client-1", clientSecret: SECRET } },
};
/** The blob a secure API key stored for an entry at `baseUrl` leaves, owner stamp included. */
const keyBlob = (baseUrl: string, value = SECRET) => ({
	apiKey: value,
	_owner: { apiKey: secretDestination({ baseUrl }, "apiKey") },
});
/** A's own key; a value equal to L1's would make L1's group A's leftover by the stored-value rule. */
const A_KEY = "a-key";
/** A refusal the webview renders as validation text, not as the generic failure: the class and the message both. */
const validation =
	(message: RegExp) =>
	(error: unknown): boolean =>
		error instanceof DashboardValidationError && message.test(error.message);

/**
 * Windows in which a live group carries L1's secret and a resolution short of one consistent, fully read
 * setting+secrets pair would hand it out, and the siblings in which a user's own group beside L1 must stay the
 * user's. Unlabeled groups report under the URL host, as discovery labels them.
 *
 *   mid-pass              -> L1's add has not returned; the views predate L1 and the state push shows its group as an
 *                            external row
 *   first-pass            -> last session's pass created the group; no pass completed this session, so the push falls
 *                            back to the setting
 *   secrets-unreadable    -> L1 is blocked and a legacy unlabeled group carries its secret (joined by connection ID);
 *                            the read fails at the intent
 *   declared-mid-read     -> L1 and its secure key land while the resolver awaits another entry's blob; its group is
 *                            already served
 *   declared-during-adopt -> the native source's key becomes a declared entry's between the adopt's resolution and
 *                            its write
 *   secret-rotates-mid-read   -> L1's stored key rotates while the resolver awaits another entry's blob; the group
 *                                carrying the new key was external
 *   declared-after-resolution -> the declaration lands in the promise continuation between the resolution's return
 *                                and the tombstone write
 *   rejected-entry            -> L1's auth block was hand-edited into a shape the parser refuses after its group, key
 *                                baked in, was created
 *   label-only-entry          -> L1 was hand-edited down to its label; its stamped group is the label's legacy row
 *   non-array-setting         -> the setting is mid-edit; the pass keeps every old label declared, yet nothing can
 *                                join any group
 *   rejected-carrier-inline-key -> L1's rejected shape still carries its key inline; the unstamped group holding that key
 *                                  is L1's leftover, not the user's
 *   rejected-carrier-flat-key -> L1's rejected shape carries its key at the flat position; the group holding it is
 *                                L1's leftover
 *   rejected-carrier-stored-and-inline -> L1's rejected shape carries one key inline while another is stored; the group
 *                                         holding the stored one is L1's leftover too
 *   rotated-inline-secret-unstamped -> L1's OAuth token URL changed with its inline client secret kept; the unstamped
 *                                      old group holding that secret is L1's leftover
 *   rejected-entry-sibling-group -> the rejected L1's own group, label stamped, sits at H beside an external group
 *                                   with its own key; the external one stays adoptable
 *   malformed-after-resolution -> the setting turns into a non-array in the continuation
 *                                 between the resolution's return and the write
 *   rotated-oauth-personal    -> L1's OAuth token URL changed; its old group, label stamped, joins by label and URL,
 *                                and the user's own Personal group at H stays adoptable
 *   renamed-legacy-personal   -> L1's rotated identity gets a new group; its renamed, stamped old group is a legacy row
 *   two-entries-personal      -> L2 declares H but has no group, and claims nothing by URL alone
 *   unset-setting-native      -> nothing declared (the user scope reads undefined, the engine []); a native group's own
 *                                key is the one adoption that copies
 *   moved-entry-old-group     -> L1 moved to another URL; the group its old shape created, label stamped, lives on at H
 *   retained-key-legacy       -> L1 moved to another URL with a rejected duplicate left at H; its secure key stays
 *                                stamped for H, and the pre-stamp group at H carrying that key is L1's legacy row
 *   rejected-moved-stamped-group -> L1's only carrier is rejected, at another URL; the stamped group its valid shape
 *                                   created at H is the label's legacy row, not external
 *   rejected-duplicate-personal  -> a rejected duplicate of the accepted L1 at H, whose own group joins by ID; the
 *                                   duplicate claims nothing by URL alone, so Personal at H stays adoptable
 *   sibling-without-url       -> the rejected duplicate has no URL; an unlabeled group at H that nothing ties to L1
 *                                is the user's own
 */
const WINDOWS: Record<string, Scenario> = {
	"mid-pass": {
		after: { setting: [A_ENTRY, L1_ENTRY], secrets: { A: keyBlob("http://a.test", A_KEY), L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async ({ engine, env, host, pushedHandle }) => {
			await executeDashboardIntent(
				{ method: "saveServerSetting", payload: saveSecure("A", "http://a.test", A_KEY) },
				env
			);
			await engine.syncNow();
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			const release = host.hold();
			const pass = engine.syncNow();
			while (!host.snapshots.some((snapshot) => snapshot.entryLabel === "L1")) {
				await settle();
			}
			assert.deepStrictEqual(
				engine.getDeclared().map((view) => view.label),
				["A"],
				"the views still predate L1"
			);
			const handle = pushedHandle("L1");
			assert.ok(handle !== undefined, "the state push shows L1's group as an external row");
			return {
				handle,
				close: async () => {
					release();
					await pass;
				},
			};
		},
	},
	"first-pass": {
		after: { setting: [L1_ENTRY], secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async ({ env, host, pushedHandle, handleOf }) => {
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, label: "L1", apiKey: SECRET });
			assert.strictEqual(pushedHandle("L1"), undefined, "the settings fallback shows L1 as declared");
			return { handle: handleOf("L1"), close: async () => {} };
		},
	},
	"secrets-unreadable": {
		after: { setting: [L1_ENTRY], secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: /keychain locked/,
		open: async (fixture) => {
			const { engine, env, host, pushedHandle } = fixture;
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await host.addProviderGroup({ name: "legacy", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			await host.addProviderGroup({ name: "external", vendor: "litellm", baseUrl: H });
			host.taken.add("L1");
			await engine.syncNow();
			assert.strictEqual(pushedHandle("legacy"), undefined, "the pass's views claim the legacy group by connection ID");
			fixture.onSecretRead = (label) => {
				if (label === "L1") {
					throw new Error("keychain locked");
				}
			};
			return { handle: fixture.handleOf("legacy"), close: async () => {} };
		},
	},
	"declared-mid-read": {
		after: {
			setting: [A_ENTRY, L1_ENTRY],
			secrets: { A: keyBlob("http://a.test", A_KEY), L1: keyBlob(H) },
			// The pass's views predate L1, so its stamped group still draws external until the next pass: no row moves.
			push: { added: [] },
		},
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, env, host, pushedHandle } = fixture;
			await executeDashboardIntent(
				{ method: "saveServerSetting", payload: saveSecure("A", "http://a.test", A_KEY) },
				env
			);
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, label: "L1", apiKey: SECRET });
			await engine.syncNow();
			const handle = pushedHandle("L1");
			assert.ok(handle !== undefined, "L1's group reads as external while L1 is not declared");
			fixture.onSecretRead = (label) => {
				if (label === "A") {
					fixture.onSecretRead = undefined;
					fixture.declare([
						{ label: "A", baseUrl: "http://a.test" },
						{ label: "L1", baseUrl: H },
					]);
					fixture.storeSecureKey("L1", SECRET);
				}
			};
			return { handle, close: async () => {} };
		},
	},
	"declared-during-adopt": {
		after: {
			setting: [L1_INLINE],
			secrets: {},
			// No pass has published views, so the settings fallback declares L1 without join keys: the native group
			// stays an external row beside it until the pass runs.
			push: { added: [L1_FALLBACK_ROW] },
		},
		intents: ["adopt"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			await host.addProviderGroup({ name: "native", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			await engine.syncNow();
			const handle = pushedHandle("native");
			assert.ok(handle !== undefined);
			fixture.onSecretRead = (label) => {
				if (label === "Copy") {
					fixture.onSecretRead = undefined;
					fixture.declare([{ label: "L1", baseUrl: H, auth: { apiKey: SECRET } }]);
				}
			};
			return { handle, close: async () => {} };
		},
	},
	"secret-rotates-mid-read": {
		after: { setting: [L1_ENTRY, A_ENTRY], secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			fixture.declare([
				{ label: "L1", baseUrl: H },
				{ label: "A", baseUrl: "http://a.test" },
			]);
			fixture.storeSecureKey("L1", "old-key");
			await host.addProviderGroup({ name: "old", vendor: "litellm", baseUrl: H, apiKey: "old-key" });
			await host.addProviderGroup({ name: "rotated", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			host.taken.add("L1");
			host.taken.add("A");
			await engine.syncNow();
			const handle = pushedHandle("rotated");
			assert.ok(
				handle !== undefined,
				"the group carrying the rotated key reads as external while L1 holds the old key"
			);
			fixture.onSecretRead = (label) => {
				if (label === "A") {
					fixture.onSecretRead = undefined;
					fixture.storeSecureKey("L1", SECRET);
				}
			};
			return { handle, close: async () => {} };
		},
	},
	"rejected-entry": {
		after: { setting: [L1_REJECTED], secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, env, pushedHandle, pushedLegacyRows } = fixture;
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await engine.syncNow();
			fixture.declare([L1_REJECTED]);
			await engine.syncNow();
			assert.strictEqual(pushedHandle("L1"), undefined, "the rejected entry's own group is no external row");
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"], "it is drawn as L1's legacy leftover");
			return { handle: fixture.handleOf("L1"), close: async () => {} };
		},
	},
	"label-only-entry": {
		after: { setting: [{ label: "L1" }], secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, env, pushedHandle, pushedLegacyRows } = fixture;
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await engine.syncNow();
			fixture.declare([{ label: "L1" }]);
			await engine.syncNow();
			assert.strictEqual(pushedHandle("L1"), undefined, "the label's stamped group is no external row");
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"], "it is drawn as L1's legacy leftover");
			return { handle: fixture.handleOf("L1"), close: async () => {} };
		},
	},
	"non-array-setting": {
		after: { setting: "not an array", secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: validation(/not an array/),
		open: async (fixture) => {
			const { engine, env, pushedHandle } = fixture;
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await engine.syncNow();
			fixture.declare("not an array");
			await engine.syncNow();
			const handle = pushedHandle("L1");
			assert.ok(handle !== undefined, "the pass's views omit the entry, so its live group reads as external");
			return { handle, close: async () => {} };
		},
	},
	"rejected-carrier-inline-key": {
		after: {
			setting: [{ label: "L1", baseUrl: H, auth: { apiKey: SECRET, oauth: {} } }],
			secrets: {},
		},
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle, pushedLegacyRows } = fixture;
			await host.addProviderGroup({ name: "native", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			fixture.declare([{ label: "L1", baseUrl: H, auth: { apiKey: SECRET, oauth: {} } }]);
			await engine.syncNow();
			assert.strictEqual(pushedHandle("native"), undefined, "the group holding L1's inline key is no external row");
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"]);
			return { handle: fixture.handleOf("native"), close: async () => {} };
		},
	},
	"rejected-carrier-flat-key": {
		after: { setting: [{ label: "L1", baseUrl: H, apiKey: SECRET, auth: { oauth: {} } }], secrets: {} },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle, pushedLegacyRows } = fixture;
			await host.addProviderGroup({ name: "native", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			fixture.declare([{ label: "L1", baseUrl: H, apiKey: SECRET, auth: { oauth: {} } }]);
			await engine.syncNow();
			assert.strictEqual(pushedHandle("native"), undefined, "the group holding L1's flat key is no external row");
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"]);
			return { handle: fixture.handleOf("native"), close: async () => {} };
		},
	},
	"rejected-carrier-stored-and-inline": {
		after: {
			setting: [{ label: "L1", baseUrl: H, auth: { apiKey: "inline-key", oauth: {} } }],
			secrets: { L1: keyBlob(H) },
		},
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle, pushedLegacyRows } = fixture;
			fixture.declare([L1_ENTRY]);
			fixture.storeSecureKey("L1", SECRET);
			await host.addProviderGroup({ name: "native", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			fixture.declare([{ label: "L1", baseUrl: H, auth: { apiKey: "inline-key", oauth: {} } }]);
			await engine.syncNow();
			assert.strictEqual(pushedHandle("native"), undefined, "the group holding L1's stored key is no external row");
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"]);
			return { handle: fixture.handleOf("native"), close: async () => {} };
		},
	},
	"rotated-inline-secret-unstamped": {
		after: { setting: [L1_OAUTH_ROTATED], secrets: {} },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle, pushedLegacyRows } = fixture;
			fixture.declare([L1_OAUTH_ROTATED]);
			await host.addProviderGroup({
				name: "legacy",
				vendor: "litellm",
				baseUrl: H,
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client-1",
				oauthClientSecret: SECRET,
			});
			host.taken.add("L1");
			await engine.syncNow();
			assert.strictEqual(
				pushedHandle("legacy"),
				undefined,
				"the unstamped group holding L1's inline secret is no external row"
			);
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"]);
			return { handle: fixture.handleOf("legacy"), close: async () => {} };
		},
	},
	"rejected-entry-sibling-group": {
		after: { setting: [L1_REJECTED], secrets: { L1: keyBlob(H) }, hidden: [{ label: HOST, baseUrl: H }] },
		intents: ["adopt", "hide"],
		adopt: { copies: "ext-key" },
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			fixture.declare([L1_ENTRY]);
			fixture.storeSecureKey("L1", SECRET);
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, label: "L1", apiKey: SECRET });
			await host.addProviderGroup({ name: "ext", vendor: "litellm", baseUrl: H, apiKey: "ext-key" });
			fixture.declare([L1_REJECTED]);
			await engine.syncNow();
			const handle = pushedHandle("ext");
			assert.ok(handle !== undefined, "the external group beside the rejected entry's own group stays external");
			return { handle, close: async () => {} };
		},
	},
	"malformed-after-resolution": {
		after: { setting: "not an array", secrets: {} },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: validation(/changed while this action ran|not an array/),
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			await host.addProviderGroup({ name: "native", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			await engine.syncNow();
			const handle = pushedHandle("native");
			assert.ok(handle !== undefined);
			const resolve = engine.resolveDeclaredIdentities.bind(engine);
			engine.resolveDeclaredIdentities = async () => {
				const resolved = await resolve();
				fixture.declare("not an array");
				return resolved;
			};
			return { handle, close: async () => {} };
		},
	},
	"rotated-oauth-personal": {
		after: { setting: [L1_OAUTH_ROTATED], secrets: {}, hidden: [{ label: HOST, baseUrl: H }] },
		intents: ["adopt", "hide"],
		adopt: { copies: "personal-key" },
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			fixture.declare([L1_OAUTH_ROTATED]);
			await host.addProviderGroup({
				name: "L1",
				vendor: "litellm",
				baseUrl: H,
				label: "L1",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client-1",
				oauthClientSecret: SECRET,
			});
			host.taken.add("L1");
			await host.addProviderGroup({ name: "Personal", vendor: "litellm", baseUrl: H, apiKey: "personal-key" });
			await engine.syncNow();
			assert.strictEqual(pushedHandle("L1"), undefined, "L1's old group joins by label and URL");
			const handle = pushedHandle("Personal");
			assert.ok(handle !== undefined, "the user's own group at the same host stays external");
			return { handle, close: async () => {} };
		},
	},
	"renamed-legacy-personal": {
		after: { setting: [L1_OAUTH_ROTATED], secrets: {}, hidden: [{ label: HOST, baseUrl: H }] },
		intents: ["adopt", "hide"],
		adopt: { copies: "personal-key" },
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle, pushedLegacyRows } = fixture;
			fixture.declare([L1_OAUTH_ROTATED]);
			await host.addProviderGroup({
				name: "ZLegacy",
				vendor: "litellm",
				baseUrl: H,
				label: "L1",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client-1",
				oauthClientSecret: SECRET,
			});
			await host.addProviderGroup({ name: "Personal", vendor: "litellm", baseUrl: H, apiKey: "personal-key" });
			await engine.syncNow();
			assert.deepStrictEqual(host.attempted, ["ZLegacy", "Personal", "L1"], "the pass adds L1's rotated group");
			assert.strictEqual(pushedHandle("L1"), undefined, "L1 joins the group its configuration produces, by ID");
			assert.strictEqual(pushedHandle("ZLegacy"), undefined, "the renamed old group is L1's leftover, no external row");
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"], "drawn as L1's legacy leftover, still serving");
			const handle = pushedHandle("Personal");
			assert.ok(handle !== undefined, "the user's own group at the same host stays external");
			return { handle, close: async () => {} };
		},
	},
	"two-entries-personal": {
		after: {
			setting: [L1_INLINE, { label: "L2", baseUrl: H, auth: { apiKey: "l2-key" } }],
			secrets: {},
			hidden: [{ label: HOST, baseUrl: H }],
		},
		intents: ["adopt", "hide"],
		adopt: { copies: "personal-key" },
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			fixture.declare([L1_INLINE, { label: "L2", baseUrl: H, auth: { apiKey: "l2-key" } }]);
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, label: "L1", apiKey: SECRET });
			// L2's add is refused (the name exists natively), so L2 has no group of its own.
			host.taken.add("L1");
			host.taken.add("L2");
			await host.addProviderGroup({ name: "Personal", vendor: "litellm", baseUrl: H, apiKey: "personal-key" });
			await engine.syncNow();
			assert.strictEqual(pushedHandle("L1"), undefined, "L1 claims its own group by ID");
			const handle = pushedHandle("Personal");
			assert.ok(handle !== undefined, "the group-less L2 claims nothing by URL alone");
			return { handle, close: async () => {} };
		},
	},
	"unset-setting-native": {
		after: { setting: [], secrets: {} },
		intents: ["adopt"],
		adopt: { copies: SECRET },
		refusal: DashboardValidationError,
		open: async ({ engine, host, pushedHandle }) => {
			await host.addProviderGroup({ name: "native", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			await engine.syncNow();
			const handle = pushedHandle("native");
			assert.ok(handle !== undefined);
			return { handle, close: async () => {} };
		},
	},
	"moved-entry-old-group": {
		after: { setting: [{ label: "L1", baseUrl: "http://new.test" }], secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, env, pushedHandle, pushedState } = fixture;
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await engine.syncNow();
			fixture.declare([{ label: "L1", baseUrl: "http://new.test" }]);
			await engine.syncNow();
			assert.strictEqual(pushedHandle("L1"), undefined, "the push hides the superseded group");
			assert.deepStrictEqual(pushedState().hiddenGroups, [
				{ label: "L1", baseUrl: H, reason: "superseded", declaredBaseUrl: "http://new.test" },
			]);
			return { handle: fixture.handleOf("L1"), close: async () => {} };
		},
	},
	"retained-key-legacy": {
		after: {
			setting: [{ label: "L1", baseUrl: "http://new.test" }, L1_ENTRY],
			secrets: { L1: keyBlob(H) },
		},
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle, pushedLegacyRows } = fixture;
			fixture.declare([L1_ENTRY]);
			fixture.storeSecureKey("L1", SECRET);
			// L1's group from before labels flowed into configurations: no stamp, the key baked in, labeled by host.
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			host.taken.add("L1");
			fixture.declare([{ label: "L1", baseUrl: "http://new.test" }, L1_ENTRY]);
			await engine.syncNow();
			assert.strictEqual(pushedHandle("L1"), undefined, "the group holding L1's retained key is no external row");
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"], "unstamped, so the provider still serves it: a legacy row");
			return { handle: fixture.handleOf("L1"), close: async () => {} };
		},
	},
	"rejected-moved-stamped-group": {
		after: {
			setting: [{ label: "L1", baseUrl: "http://new.test", auth: { oauth: { tokenUrl: "https://idp.test/token" } } }],
			secrets: {},
		},
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, pushedHandle, pushedLegacyRows, pushedState } = fixture;
			fixture.declare([L1_ENTRY]);
			await engine.syncNow();
			fixture.declare([
				{ label: "L1", baseUrl: "http://new.test", auth: { oauth: { tokenUrl: "https://idp.test/token" } } },
			]);
			await engine.syncNow();
			assert.strictEqual(pushedHandle("L1"), undefined, "the rejected carrier's stamped group is no external row");
			assert.deepStrictEqual(pushedLegacyRows(), ["L1"], "no accepted entry moved it: a legacy row, still serving");
			assert.deepStrictEqual(
				pushedState().servers.map((server) => [server.origin, server.baseUrl]),
				[
					["legacy", H],
					["misconfigured", "http://new.test"],
				],
				"the carrier's own Misconfigured row stands beside it"
			);
			return { handle: fixture.handleOf("L1"), close: async () => {} };
		},
	},
	"rejected-duplicate-personal": {
		after: { setting: [L1_INLINE, L1_ENTRY], secrets: {}, hidden: [{ label: HOST, baseUrl: H }] },
		intents: ["adopt", "hide"],
		adopt: { copies: "personal-key" },
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			fixture.declare([L1_INLINE, L1_ENTRY]);
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, label: "L1", apiKey: SECRET });
			host.taken.add("L1");
			await host.addProviderGroup({ name: "Personal", vendor: "litellm", baseUrl: H, apiKey: "personal-key" });
			await engine.syncNow();
			assert.deepStrictEqual(
				host.snapshots.map((snapshot) => snapshot.status.label),
				["L1", HOST],
				"one group under L1, so the duplicate has nothing to claim by label"
			);
			assert.strictEqual(pushedHandle("L1"), undefined, "the accepted L1 claims its own group");
			const handle = pushedHandle("Personal");
			assert.ok(handle !== undefined, "the user's own group at the same host stays external");
			return { handle, close: async () => {} };
		},
	},
	"sibling-without-url": {
		after: {
			setting: [{ label: "L1", baseUrl: "http://new.test" }, { label: "L1" }],
			secrets: {},
			hidden: [{ label: HOST, baseUrl: H }],
		},
		intents: ["adopt", "hide"],
		adopt: { copies: SECRET },
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			fixture.declare([{ label: "L1", baseUrl: "http://new.test" }, { label: "L1" }]);
			host.taken.add("L1");
			await host.addProviderGroup({ name: "legacy", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			await engine.syncNow();
			const handle = pushedHandle("legacy");
			assert.ok(handle !== undefined, "no stamp and no stored key tie the group to L1");
			return { handle, close: async () => {} };
		},
	},
	"declared-after-resolution": {
		after: {
			setting: [L1_INLINE],
			secrets: {},
			push: { added: [L1_FALLBACK_ROW] },
		},
		intents: ["hide"],
		adopt: "rejects",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			await host.addProviderGroup({ name: "native", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			await engine.syncNow();
			const handle = pushedHandle("native");
			assert.ok(handle !== undefined);
			const resolve = engine.resolveDeclaredIdentities.bind(engine);
			engine.resolveDeclaredIdentities = async () => {
				const resolved = await resolve();
				fixture.declare([{ label: "L1", baseUrl: H, auth: { apiKey: SECRET } }]);
				return resolved;
			};
			return { handle, close: async () => {} };
		},
	},
};

function assertOutcome(
	fixture: Fixture,
	scenario: Scenario,
	before_: { writes: number; hostCalls: number; secretOps: number; state: DashboardState },
	settingsWrites: readonly unknown[][],
	acted: { readonly handle: string; readonly hidden?: readonly { label: string; baseUrl: string }[] }
): void {
	assert.deepStrictEqual(fixture.writes.slice(before_.writes), settingsWrites);
	assert.deepStrictEqual(fixture.currentSetting(), settingsWrites.at(-1) ?? scenario.after.setting);
	assert.deepStrictEqual(fixture.secretsSnapshot(), scenario.after.secrets);
	assert.deepStrictEqual(
		fixture.secretOps.slice(before_.secretOps),
		[],
		"an intent routing nothing to secure storage writes no blob"
	);
	assert.strictEqual(fixture.host.attempted.length, before_.hostCalls, "an intent never calls the host");
	const tombstones = fixture.removals.tombstones();
	assert.deepStrictEqual(
		tombstones.map(({ label, baseUrl }) => ({ label, baseUrl })),
		acted.hidden ?? []
	);
	for (const tombstone of tombstones) {
		assert.ok(
			tombstone.by === "group" && adoptSourceHandle(tombstone.groupId) === acted.handle,
			"a hide tombstones the group by its own client ID, never by a label or URL another group shares"
		);
	}
	const after = fixture.pushedState();
	const copyRows = after.servers.filter((server) => server.origin === "declared" && server.label === "Copy");
	assert.strictEqual(
		copyRows.length,
		settingsWrites.length > 0 && fixture.engine.getDeclared().length === 0 ? 1 : 0,
		"the Copy row appears only through the settings fallback after a landed adoption"
	);
	const hiddenId =
		acted.hidden === undefined
			? undefined
			: [...fixture.host.servers.keys()].find((serverId) => adoptSourceHandle(serverId) === acted.handle);
	assert.ok(acted.hidden === undefined || hiddenId !== undefined, "the hidden handle names a host group");
	// Every row compares whole (handles and scope keys included) minus the fields the move legitimately changes:
	// rows present before and after against their earlier self, rows the move added against the scenario's full
	// records, and the only row allowed to leave is the hidden group's. The Copy row is counted above, not compared.
	const identity = (server: DashboardServer) => JSON.stringify([server.origin, server.label, server.baseUrl]);
	const before = new Map(before_.state.servers.map((server) => [identity(server), server]));
	const changed = new Set(scenario.after.push?.changed ?? []);
	const strip = (server: DashboardServer) =>
		Object.fromEntries(Object.entries(server).filter(([field]) => !changed.has(field)));
	const added: DashboardServer[] = [];
	for (const server of after.servers) {
		if (copyRows.includes(server)) {
			continue;
		}
		const earlier = before.get(identity(server));
		if (earlier === undefined) {
			added.push(server);
		} else {
			assert.deepStrictEqual(strip(server), strip(earlier), `${identity(server)} changed beyond the move`);
			before.delete(identity(server));
		}
	}
	assert.deepStrictEqual(
		[...before.values()],
		before_.state.servers.filter((server) => hiddenId !== undefined && server.adoptHandle === acted.handle),
		"only the hidden group's row leaves the push"
	);
	assert.deepStrictEqual(added.map(strip), (scenario.after.push?.added ?? []).map(strip));
	assert.deepStrictEqual(
		after.models,
		before_.state.models.filter((model) => hiddenId === undefined || model.scopeKey !== modelScopeKey(hiddenId))
	);
	assert.strictEqual(after.servedModelCount, before_.state.servedModelCount - (hiddenId === undefined ? 0 : 1));
	assert.deepStrictEqual(
		after.hiddenGroups,
		hiddenId === undefined
			? before_.state.hiddenGroups
			: [
					...before_.state.hiddenGroups,
					...(acted.hidden ?? []).map((group) => ({ ...group, reason: "removed" as const })),
				]
	);
}

suite("extension/dashboard intents against the live sync truth", () => {
	for (const [name, scenario] of Object.entries(WINDOWS)) {
		if (scenario.intents.includes("adopt")) {
			const outcome =
				typeof scenario.adopt === "object"
					? "copies the external group's own key"
					: "copies nothing from the group carrying the declared secret";
			test(`${name}: adopt ${outcome}`, async () => {
				const fixture = makeFixture();
				const { engine, env } = fixture;
				const opened = await scenario.open(fixture);
				const before = {
					writes: fixture.writes.length,
					hostCalls: fixture.host.attempted.length,
					secretOps: fixture.secretOps.length,
					state: fixture.pushedState(),
				};
				const adopt = () =>
					executeDashboardIntent(
						{
							method: "adoptServer",
							payload: {
								label: "Copy",
								baseUrl: H,
								sourceHandle: opened.handle,
								secrets: { apiKey: "settings", oauthClientSecret: "settings", virtualKeyValue: "settings" },
							},
						},
						env
					);
				try {
					if (typeof scenario.adopt === "object") {
						assert.strictEqual(await adopt(), undefined, "a full adoption carries no caveat");
						assert.ok(Array.isArray(scenario.after.setting));
						assertOutcome(
							fixture,
							scenario,
							before,
							[[...scenario.after.setting, { label: "Copy", baseUrl: H, auth: { apiKey: scenario.adopt.copies } }]],
							{ handle: opened.handle }
						);
					} else {
						await assert.rejects(adopt, scenario.refusal);
						assertOutcome(fixture, scenario, before, [], { handle: opened.handle });
					}
				} finally {
					await opened.close();
					engine.dispose();
				}
			});
		}

		if (scenario.intents.includes("hide")) {
			const hideTitle =
				scenario.after.hidden === undefined
					? "hide refuses to tombstone the group carrying the declared secret"
					: "hide tombstones the external group";
			test(`${name}: ${hideTitle}`, async () => {
				const fixture = makeFixture();
				const { engine, env } = fixture;
				const opened = await scenario.open(fixture);
				const before = {
					writes: fixture.writes.length,
					hostCalls: fixture.host.attempted.length,
					secretOps: fixture.secretOps.length,
					state: fixture.pushedState(),
				};
				const hide = () =>
					executeDashboardIntent(
						{ method: "hideExternalServer", payload: { baseUrl: H, sourceHandle: opened.handle } },
						env
					);
				try {
					if (scenario.after.hidden === undefined) {
						await assert.rejects(hide, scenario.refusal);
						assertOutcome(fixture, scenario, before, [], { handle: opened.handle });
					} else {
						assert.strictEqual(await hide(), undefined);
						assertOutcome(fixture, scenario, before, [], { handle: opened.handle, hidden: scenario.after.hidden });
					}
				} finally {
					await opened.close();
					engine.dispose();
				}
			});
		}
	}
});
