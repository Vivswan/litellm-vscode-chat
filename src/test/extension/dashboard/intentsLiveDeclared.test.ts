/**
 * The adopt and hide intents resolve a row handle against the setting as it stands, not against the views the last
 * sync pass published. Each row drives the production intent environment (createIntentEnvironment) over the real
 * engine and a fake host, in a window where a weaker resolution would hand out a declared entry's secret.
 */
import * as assert from "node:assert";
import type { RequestPayload } from "../../../dashboard/endpoints";
import { adoptSourceHandle } from "../../../extension/dashboard/adoptHandle";
import type { IntentEnvironment } from "../../../extension/dashboard/intents";
import { DashboardValidationError, executeDashboardIntent } from "../../../extension/dashboard/intents";
import { createIntentEnvironment, declaredViewsFromSetting } from "../../../extension/dashboard/panel";
import type { DeclaredServerView, SecretStore } from "../../../extension/servers/serverSync";
import { acceptedEntry, ServerSyncEngine } from "../../../extension/servers/serverSync";
import { readServerSecretsRecord, secretDestination } from "../../../extension/servers/serverSync/secrets";
import type { SettingsAccess } from "../../../extension/settingsAccess";
import type { GroupServer } from "../../../provider/catalog/groupModels";
import { groupClientId, parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../../provider/catalog/statusWindow";
import { serverSecretsKey } from "../../../shared/config/storageKeys";
import { makeServerStatus } from "../../testUtils";
import { makeSecretStore, makeSyncEnv } from "../servers/serverSyncHelpers";
import { buildState, makeReader } from "./stateHelpers";

const H = "http://h.test";
const SECRET = "s3cret";

/** A host whose add hands the group to the provider at once and then, while held, blocks like a slow serve. */
function makeHost() {
	const snapshots: ServerModelsSnapshot[] = [];
	const servers = new Map<string, GroupServer>();
	/** Names the host refuses as an add-only host refuses an existing name. */
	const taken = new Set<string>();
	/** Every add the engine attempted, refused ones included. */
	const attempted: string[] = [];
	let gate: Promise<void> | undefined;
	return {
		snapshots,
		servers,
		taken,
		attempted,
		addProviderGroup: async (args: Readonly<Record<string, string>>) => {
			attempted.push(args.name ?? "");
			if (taken.has(args.name ?? "")) {
				throw new Error(`Language model group with name ${args.name} already exists for vendor litellm`);
			}
			const server = parseGroupConfiguration(args);
			assert.ok(server !== undefined);
			const serverId = groupClientId(server);
			servers.set(serverId, server);
			snapshots.push({
				status: makeServerStatus({ serverId, label: args.name ?? "", baseUrl: args.baseUrl ?? "" }),
				models: [],
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
	/** Every tombstone the hide intent wrote. */
	hidden: { label: string; baseUrl: string }[];
	/** Runs before every SecretStorage read of the given label's blob (the engine's and the intents'). */
	onSecretRead: ((label: string) => void) | undefined;
	/** Replace the servers setting outright, any value, as a hand edit or another window would. */
	declare(value: unknown): void;
	/** Land a secure API key for a declared label without awaiting, stamped for the entry as the setting holds it. */
	storeSecureKey(label: string, value: string): void;
	/** The handle the webview row under `label` carries, or undefined when the push shows no external row there. */
	pushedHandle(label: string): string | undefined;
	currentSetting(): unknown;
	/** Every stored API key by label, as SecretStorage holds them now. */
	secretsSnapshot(): Record<string, unknown>;
	/** Every SecretStorage store or delete, as "store <label>" or "delete <label>". */
	secretOps: string[];
}

/** The production intent environment over fakes for the stores, the host, and the removal ledger. */
function makeFixture(): Fixture {
	const host = makeHost();
	let setting: unknown = [];
	const writes: unknown[][] = [];
	const settingsAccess: SettingsAccess = {
		readGlobal: () => setting,
		readEffective: () => setting,
		inspect: () => undefined,
		writeGlobal: async (_key, value) => {
			writes.push([...(value as readonly unknown[])]);
			setting = structuredClone(value);
		},
		updateAuto: async () => {},
		removeConfigured: async () => {},
		snapshotReader: () => ({ get: () => undefined, inspect: () => undefined }),
	};
	const blobs = makeSecretStore();
	const fixture: Fixture = {
		host,
		writes,
		hidden: [],
		secretOps: [],
		currentSetting: () => setting,
		secretsSnapshot: () =>
			Object.fromEntries(
				[...blobs.values.entries()].map(([key, blob]) => [key.slice(serverSecretsKey("").length), JSON.parse(blob)])
			),
		onSecretRead: undefined,
		declare: (value) => {
			setting = structuredClone(value);
		},
		storeSecureKey: (label, value) => {
			const entry = acceptedEntry(setting, label)?.entry;
			assert.ok(entry !== undefined);
			blobs.values.set(
				serverSecretsKey(label),
				JSON.stringify({ apiKey: value, _owner: { apiKey: secretDestination(entry, "apiKey") } })
			);
		},
		pushedHandle: (label) => {
			const views = fixture.engine.getDeclared();
			const declared: readonly DeclaredServerView[] =
				views.length > 0 ? views : declaredViewsFromSetting(setting).views;
			return buildState(host.snapshots, makeReader({}), declared).servers.find((row) => row.label === label)
				?.adoptHandle;
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
			readServersSetting: () => setting,
			readSecrets: (label) => readServerSecretsRecord(secrets, label),
			addProviderGroup: host.addProviderGroup,
		},
		400
	);
	fixture.env = createIntentEnvironment({
		provider: { getServerSnapshots: () => host.snapshots, getGroupServer: (serverId) => host.servers.get(serverId) },
		syncEngine: fixture.engine,
		removals: {
			addTombstone: async (identity) => {
				fixture.hidden.push({ label: identity.label, baseUrl: identity.baseUrl });
			},
			removeTombstone: async () => false,
			isTombstoned: () => false,
		},
		settingsAccess,
		secrets,
		logger: { log: () => {} },
		ua: "test",
		featureProbes: {},
		refreshCatalogNow: () => {},
		refreshUsageNow: () => {},
	});
	return fixture;
}

function saveSecure(label: string, baseUrl: string): RequestPayload<"saveServerSetting"> {
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
			apiKey: { action: "set", location: "secure", value: SECRET },
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
	/** What adopt does with the handle: the plain entry with the caveat, or the refusal with nothing written. */
	adopt: "plain-entry" | "rejects";
	/** What hide throws, and adopt when it rejects: the stale-row validation error, or the failed secrets read. */
	refusal: RegExp | typeof DashboardValidationError | ((error: unknown) => boolean);
	/** The declared setting and the stored API keys once the intent has run, the window's mid-intent changes included. */
	after: { readonly setting: unknown; readonly secrets: Readonly<Record<string, unknown>> };
}

const A_ENTRY = { label: "A", baseUrl: "http://a.test" };
const L1_ENTRY = { label: "L1", baseUrl: H };
const L1_INLINE = { label: "L1", baseUrl: H, auth: { apiKey: SECRET } };
/** An OAuth block without its client id: the parser refuses the entry whole. */
const L1_REJECTED = { label: "L1", baseUrl: H, auth: { oauth: { tokenUrl: "https://idp.test/token" } } };
/** The blob a secure API key stored for an entry at `baseUrl` leaves, owner stamp included. */
const keyBlob = (baseUrl: string) => ({ apiKey: SECRET, _owner: { apiKey: secretDestination({ baseUrl }, "apiKey") } });
/** A refusal the webview renders as validation text, not as the generic failure: the class and the message both. */
const validation =
	(message: RegExp) =>
	(error: unknown): boolean =>
		error instanceof DashboardValidationError && message.test(error.message);

/**
 * Windows in which a live group carries L1's secret and a resolution short of one consistent, fully read
 * setting+secrets pair would hand it out.
 *
 *   mid-pass              -> L1's add has not returned; the views predate L1 and the state push shows its group as an external row
 *   first-pass            -> last session's pass created the group; no pass completed this session, so the push falls back to the setting
 *   secrets-unreadable    -> L1 is blocked and a legacy unlabeled group carries its secret (joined by connection ID); the read fails at the intent
 *   declared-mid-read     -> L1 and its secure key land while the resolver awaits another entry's blob; its group is already served
 *   declared-during-adopt -> the native source's key becomes a declared entry's between the adopt's resolution and its write
 *   secret-rotates-mid-read   -> L1's stored key rotates while the resolver awaits another entry's blob; the group carrying the new key was external
 *   declared-after-resolution -> the declaration lands in the promise continuation between the resolution's return and the tombstone write
 *   rejected-entry            -> L1's auth block was hand-edited into a shape the parser refuses after its group, key baked in, was created
 *   label-only-entry          -> L1 was hand-edited down to its label; the pass keeps the label declared, yet nothing can join its group
 *   non-array-setting         -> the setting is mid-edit; the pass keeps every old label declared, yet nothing can join any group
 *   rejected-entry-shared-url -> the rejected L1's key lives in an unlabeled legacy group at H,
 *                                beside another group at H the URL join would claim first
 *   malformed-after-resolution -> the setting turns into a non-array in the continuation
 *                                 between the resolution's return and the write
 */
const WINDOWS: Record<string, Scenario> = {
	"mid-pass": {
		after: { setting: [A_ENTRY, L1_ENTRY], secrets: { A: keyBlob("http://a.test"), L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "plain-entry",
		refusal: DashboardValidationError,
		open: async ({ engine, env, host, pushedHandle }) => {
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("A", "http://a.test") }, env);
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
		adopt: "plain-entry",
		refusal: DashboardValidationError,
		open: async ({ env, host, pushedHandle }) => {
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, label: "L1", apiKey: SECRET });
			assert.strictEqual(pushedHandle("L1"), undefined, "the settings fallback shows L1 as declared");
			const serverId = host.snapshots[0]?.status.serverId;
			assert.ok(serverId !== undefined);
			return { handle: adoptSourceHandle(serverId), close: async () => {} };
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
			const serverId = host.snapshots[0]?.status.serverId;
			assert.ok(serverId !== undefined);
			fixture.onSecretRead = (label) => {
				if (label === "L1") {
					throw new Error("keychain locked");
				}
			};
			return { handle: adoptSourceHandle(serverId), close: async () => {} };
		},
	},
	"declared-mid-read": {
		after: { setting: [A_ENTRY, L1_ENTRY], secrets: { A: keyBlob("http://a.test"), L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "plain-entry",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, env, host, pushedHandle } = fixture;
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("A", "http://a.test") }, env);
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
		after: { setting: [L1_INLINE], secrets: {} },
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
		adopt: "plain-entry",
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
		adopt: "plain-entry",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, env, pushedHandle } = fixture;
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await engine.syncNow();
			fixture.declare([L1_REJECTED]);
			await engine.syncNow();
			const handle = pushedHandle("L1");
			assert.ok(handle !== undefined, "the pass's views omit the rejected entry, so its live group reads as external");
			return { handle, close: async () => {} };
		},
	},
	"label-only-entry": {
		after: { setting: [{ label: "L1" }], secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "rejects",
		refusal: validation(/without a base URL/),
		open: async (fixture) => {
			const { engine, env, pushedHandle } = fixture;
			await executeDashboardIntent({ method: "saveServerSetting", payload: saveSecure("L1", H) }, env);
			await engine.syncNow();
			fixture.declare([{ label: "L1" }]);
			await engine.syncNow();
			const handle = pushedHandle("L1");
			assert.ok(handle !== undefined, "the pass's views omit the entry, so its live group reads as external");
			return { handle, close: async () => {} };
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
	"rejected-entry-shared-url": {
		after: { setting: [L1_REJECTED], secrets: { L1: keyBlob(H) } },
		intents: ["adopt", "hide"],
		adopt: "plain-entry",
		refusal: DashboardValidationError,
		open: async (fixture) => {
			const { engine, host, pushedHandle } = fixture;
			fixture.declare([L1_ENTRY]);
			fixture.storeSecureKey("L1", SECRET);
			fixture.declare([L1_REJECTED]);
			await host.addProviderGroup({ name: "a-ext", vendor: "litellm", baseUrl: H });
			await host.addProviderGroup({ name: "legacy", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			await engine.syncNow();
			const handle = pushedHandle("legacy");
			assert.ok(handle !== undefined, "the legacy group carrying L1's key reads as external beside another group at H");
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
	"declared-after-resolution": {
		after: { setting: [L1_INLINE], secrets: {} },
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

/** The whole outcome of one intent: the settings writes it made, the setting and secure contents it left, the tombstones, the host calls. */
function assertOutcome(
	fixture: Fixture,
	scenario: Scenario,
	before: { writes: number; hostCalls: number; secretOps: number },
	settingsWrites: readonly unknown[][]
): void {
	assert.deepStrictEqual(fixture.writes.slice(before.writes), settingsWrites);
	assert.deepStrictEqual(fixture.currentSetting(), settingsWrites.at(-1) ?? scenario.after.setting);
	assert.deepStrictEqual(fixture.secretsSnapshot(), scenario.after.secrets);
	assert.deepStrictEqual(
		fixture.secretOps.slice(before.secretOps),
		[],
		"an intent routing nothing to secure storage writes no blob"
	);
	assert.deepStrictEqual(fixture.hidden, []);
	assert.strictEqual(fixture.host.attempted.length, before.hostCalls, "an intent never calls the host");
}

suite("extension/dashboard intents against the live sync truth", () => {
	for (const [name, scenario] of Object.entries(WINDOWS)) {
		if (scenario.intents.includes("adopt")) {
			test(`${name}: adopt copies nothing from the group carrying the declared secret`, async () => {
				const fixture = makeFixture();
				const { engine, env } = fixture;
				const opened = await scenario.open(fixture);
				const before = {
					writes: fixture.writes.length,
					hostCalls: fixture.host.attempted.length,
					secretOps: fixture.secretOps.length,
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
					if (scenario.adopt === "plain-entry") {
						const notice = await adopt();
						assert.ok(typeof notice === "string" && /could not be read/.test(notice), `caveat expected, got ${notice}`);
						assert.ok(Array.isArray(scenario.after.setting));
						assertOutcome(fixture, scenario, before, [[...scenario.after.setting, { label: "Copy", baseUrl: H }]]);
					} else {
						await assert.rejects(adopt, scenario.refusal);
						assertOutcome(fixture, scenario, before, []);
					}
				} finally {
					await opened.close();
					engine.dispose();
				}
			});
		}

		if (scenario.intents.includes("hide")) {
			test(`${name}: hide refuses to tombstone the group carrying the declared secret`, async () => {
				const fixture = makeFixture();
				const { engine, env } = fixture;
				const opened = await scenario.open(fixture);
				const before = {
					writes: fixture.writes.length,
					hostCalls: fixture.host.attempted.length,
					secretOps: fixture.secretOps.length,
				};
				try {
					await assert.rejects(
						() =>
							executeDashboardIntent(
								{ method: "hideExternalServer", payload: { baseUrl: H, sourceHandle: opened.handle } },
								env
							),
						scenario.refusal
					);
					assertOutcome(fixture, scenario, before, []);
				} finally {
					await opened.close();
					engine.dispose();
				}
			});
		}
	}
});
