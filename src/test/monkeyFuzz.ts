/**
 * The interaction (monkey) fuzzer's action alphabet, oracle, generator, and
 * executor, shared by docker-monkey.test.ts and the corpus replays.
 *
 * Actions are JSON-serializable and environment-independent: labels are
 * abstract tokens ("s1", "s2") that the executor maps into a fresh
 * monkey-<seed>-<namespace>- namespace on every run, and credentials are
 * symbolic modes the executor resolves against the live stack. A failing
 * walk therefore replays and shrinks exactly like a FuzzEvent list: the
 * serialized actions are the whole reproduction.
 *
 * The oracle is deliberately built from the REAL pure functions the
 * extension runs (parseServersSetting, buildGroupArgs), so its expectations
 * cannot drift from the sync engine's acceptance and resolution rules. Its
 * one structural insight: under VS Code's add-only provider-group command, a
 * label's first successfully synced configuration is immutable for the host
 * lifetime, so the expected syncError for any later state is exactly
 * "current resolved args differ from that first configuration".
 *
 * Known oracle limitations (documented, not accidental):
 * - SecretStorage offers no enumeration API, so the storage-key probe covers
 *   Memento keys only; stored secret blobs are observed indirectly through
 *   the declared views' secret locations.
 * - Model attribution is a lower bound: per-group model copies share raw
 *   IDs, so the probe counts copies per healthy non-removed group instead of
 *   attributing a copy to a specific group (an explicit removal tombstones
 *   the group and hides its models, so removed labels leave the floor), and
 *   pre-existing host models are grandfathered via a baseline snapshot.
 * - The secret-leak scan is a substring scan over the classification-only
 *   log buffer; every minted secret is recognizable by construction
 *   (sk-monkey-<seed>-<n>, monkey-oauth-secret-<n>).
 */

import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DeclaredServerView } from "../extension/servers/serverSync";
import { buildGroupArgs, GROUP_UPDATE_UNAVAILABLE_MESSAGE, parseServersSetting } from "../extension/servers/serverSync";
import { CMD, VENDOR_ID } from "../shared/config/commandIds";
import { CONFIG_SECTION } from "../shared/config/settingSpec";
import { HEADERS_SETTING_KEY, MODEL_PARAMETERS_SETTING_KEY, SERVERS_SETTING_KEY } from "../shared/config/settings";
import {
	GROUP_MIGRATION_COMPLETE_KEY,
	HAS_SHOWN_WELCOME_KEY,
	LAST_CONNECTION_STATUS_KEY,
	LEGACY_CLEANUP_PENDING_KEY,
	MIGRATED_ENTRY_PARAMETER_COPIES_KEY,
	MIGRATED_SERVER_IDS_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	ORPHANED_GROUP_PROVENANCE_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	REMOVED_GROUP_TOMBSTONES_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SERVER_REGISTRY_KEY,
	SERVER_SYNC_FINGERPRINTS_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
	SYNCED_ENTRY_BASE_URLS_KEY,
} from "../shared/config/storageKeys";
import type { SecretFieldId } from "../shared/serverEntry";
import { COMMAND_SIGIL } from "./fakeStack/commands";
import { FAKE_MODELS, PLAYBACK_MODEL } from "./fakeStack/models";
import { FAKE_OAUTH_CLIENT_ID, FAKE_OAUTH_CLIENT_SECRET } from "./fakeStack/oauth";
import { collectStream, extractText, waitForHostModels } from "./hostApiHelpers";
import { expectDefined } from "./testUtils";

// -- Action alphabet ----------------------------------------------------------

/** How a declared entry authenticates; the executor resolves each mode against the live stack. */
type CredentialMode = "inline" | "secure" | "none" | "virtual-key" | "oauth" | "bad-key";

type ChatVerb = "echo" | "text" | "think" | "stream";

/**
 * One monkey step. Every variant is JSON-serializable and self-contained;
 * label fields carry abstract tokens the executor namespaces per run.
 */
export type MonkeyAction =
	| { kind: "declare-server"; label: string; credential: CredentialMode }
	/** Mutate an existing label's baseUrl; the add-only host must refuse the update. */
	| { kind: "redeclare-server"; label: string }
	| { kind: "remove-server"; label: string }
	| { kind: "set-secret"; label: string; field: SecretFieldId; serial: number }
	| { kind: "clear-secret"; label: string; field: SecretFieldId }
	| { kind: "sync-now" }
	| { kind: "dashboard-intent"; intent: unknown; expect: "ok" | "validation-error" }
	| { kind: "dashboard-junk"; payload: unknown }
	| { kind: "chat"; verb: ChatVerb; a: number; b: number; pick: number }
	| { kind: "chat-cancel"; chunkCount: number; cancelAfter: number }
	| { kind: "set-model-parameters"; valid: boolean; serial: number }
	| { kind: "set-headers"; valid: boolean; serial: number };

export interface MonkeyCorpusEntry {
	name: string;
	actions: MonkeyAction[];
}

// -- Deterministic generation -------------------------------------------------

/**
 * Temperatures whose JSON round trip is byte-stable (no float arithmetic),
 * so the %params / last-request spot checks can compare exact values.
 */
const TEMPERATURES = [0.1, 0.25, 0.5, 0.75, 1] as const;

/**
 * Dashboard intents with known outcomes, valid and value-invalid. Only
 * intents that cannot wedge the host are generated: executeCommand is
 * limited to syncModels (manageServers and openSettings open UI surfaces
 * that await user input, and testConnection/showDiagnostics are covered
 * elsewhere), and saveServerSetting/adoptServer stay out because the
 * declare/redeclare/remove actions already drive the servers setting
 * through its own oracle.
 */
function generateDashboardIntent(
	random: () => number,
	serial: number
): Extract<MonkeyAction, { kind: "dashboard-intent" }> {
	const roll = Math.floor(random() * 11);
	const temperature = expectDefined(TEMPERATURES[serial % TEMPERATURES.length]);
	switch (roll) {
		case 0:
			return {
				kind: "dashboard-intent",
				intent: { type: "setNumberSetting", setting: "discoveryCacheTtl", value: 3600000 },
				expect: "ok",
			};
		case 1:
			return {
				kind: "dashboard-intent",
				intent: { type: "setNumberSetting", setting: "defaultMaxOutputTokens", value: 2048 + (serial % 3) * 2048 },
				expect: "ok",
			};
		case 2:
			// Below the spec minimum: validateNumberSetting refuses, nothing lands.
			return {
				kind: "dashboard-intent",
				intent: { type: "setNumberSetting", setting: "requestTimeout", value: -1 - serial },
				expect: "validation-error",
			};
		case 3:
			return {
				kind: "dashboard-intent",
				intent: { type: "setBooleanSetting", setting: "maskApiKeyInput", value: serial % 2 === 0 },
				expect: "ok",
			};
		case 4:
			return {
				kind: "dashboard-intent",
				intent: { type: "resetSetting", setting: random() < 0.5 ? "discoveryCacheTtl" : "maskApiKeyInput" },
				expect: "ok",
			};
		case 5:
			return {
				kind: "dashboard-intent",
				intent: { type: "setModelParameters", value: { [PLAYBACK_MODEL.alias]: { temperature } } },
				expect: "ok",
			};
		case 6:
			// "constructor" is a reserved record key (isUnsafeRecordKey); unlike
			// "__proto__" it survives an object literal as an own property, so the
			// action stays JSON-faithful.
			return {
				kind: "dashboard-intent",
				intent: { type: "setModelParameters", value: { constructor: { temperature } } },
				expect: "validation-error",
			};
		case 7:
			return {
				kind: "dashboard-intent",
				intent: { type: "setHeaders", value: { [`x-monkey-dash-${serial}`]: `dash-${serial}` } },
				expect: "ok",
			};
		case 8:
			return {
				kind: "dashboard-intent",
				intent: { type: "setHeaders", value: { [`bad header ${serial}`]: "v" } },
				expect: "validation-error",
			};
		case 9:
			return {
				kind: "dashboard-intent",
				intent: { type: "executeCommand", command: "syncModels" },
				expect: "ok",
			};
		default:
			return {
				kind: "dashboard-intent",
				intent: { type: "removeServerSetting", label: `never-declared-${serial}`, requestId: `monkey-${serial}` },
				expect: "validation-error",
			};
	}
}

/**
 * Schema-invalid payloads: every object template carries a wrong-typed or
 * extra field (the strict schemas refuse unknown keys), so nothing here can
 * parse into an intent that acts. The executor still accepts a
 * "validation-error" outcome for junk, because near-valid mutations may
 * legitimately pass the schema and die in value validation instead.
 */
function generateJunkPayload(random: () => number, serial: number): unknown {
	const templates: readonly unknown[] = [
		serial,
		`monkey-junk-${serial}`,
		null,
		true,
		[serial, "junk"],
		[],
		{ type: serial },
		{ type: "setNumberSetting" },
		{ type: "setNumberSetting", setting: "requestTimeout", value: `${serial}` },
		{ type: "ready", extra: serial },
		{ type: "executeCommand", command: "workbench.action.closeWindow" },
		{ type: "no-such-intent", value: serial },
		{ type: { type: "ready" } },
		{ type: "removeServerSetting", label: serial, requestId: `junk-${serial}` },
		{ type: "setHeaders", value: { h: { nested: serial } } },
		{ type: "saveServerSetting", server: { label: `j${serial}` }, secrets: {}, requestId: "" },
	];
	return structuredClone(templates[Math.floor(random() * templates.length)]);
}

const CREDENTIAL_MODES: readonly CredentialMode[] = ["inline", "secure", "none", "virtual-key", "oauth", "bad-key"];

/** Chat verbs weighted toward the cheap ones; parameters stay inside the fake grammar's caps. */
function generateChat(random: () => number): Extract<MonkeyAction, { kind: "chat" }> {
	const pick = Math.floor(random() * 1000);
	const roll = random();
	if (roll < 0.4) {
		return { kind: "chat", verb: "echo", a: Math.floor(random() * 100000), b: Math.floor(random() * 1000), pick };
	}
	if (roll < 0.65) {
		return {
			kind: "chat",
			verb: "text",
			a: 5 + Math.floor(random() * 40),
			b: Math.floor(random() * 100000),
			pick,
		};
	}
	if (roll < 0.85) {
		return { kind: "chat", verb: "think", a: 1 + Math.floor(random() * 5), b: 0, pick };
	}
	return { kind: "chat", verb: "stream", a: 2 + Math.floor(random() * 7), b: 0, pick };
}

/**
 * Generate one walk of `stepCount` actions. The generator keeps its own
 * planned view of which labels exist so mutating actions always target real
 * labels; execution-time state never feeds back into generation, which is
 * what makes a walk replayable from its serialized actions alone.
 */
export function generateWalk(random: () => number, stepCount: number): MonkeyAction[] {
	const actions: MonkeyAction[] = [];
	const live: string[] = [];
	let labelCounter = 0;
	let serial = 0;
	const randomLive = (): string | undefined => live[Math.floor(random() * live.length)];
	for (let step = 0; step < stepCount; step++) {
		serial++;
		const roll = random();
		if (roll < 0.15) {
			// Labels are never recycled BY DESIGN: a removed label's fingerprint is
			// pruned at end of pass, so re-declaring it - even with identical args -
			// would hit the add-only duplicate rejection (GROUP_UPDATE_UNAVAILABLE_MESSAGE)
			// while the oracle expects undefined, desynchronizing oracle from engine.
			const label = `s${++labelCounter}`;
			const credential = expectDefined(CREDENTIAL_MODES[Math.floor(random() * CREDENTIAL_MODES.length)]);
			live.push(label);
			actions.push({ kind: "declare-server", label, credential });
		} else if (roll < 0.22 && live.length > 0) {
			actions.push({ kind: "redeclare-server", label: expectDefined(randomLive()) });
		} else if (roll < 0.29 && live.length > 0) {
			const label = expectDefined(randomLive());
			live.splice(live.indexOf(label), 1);
			actions.push({ kind: "remove-server", label });
		} else if (roll < 0.37 && live.length > 0) {
			const field: SecretFieldId = random() < 0.7 ? "apiKey" : "oauthClientSecret";
			actions.push({ kind: "set-secret", label: expectDefined(randomLive()), field, serial });
		} else if (roll < 0.42 && live.length > 0) {
			const field: SecretFieldId = random() < 0.7 ? "apiKey" : "oauthClientSecret";
			actions.push({ kind: "clear-secret", label: expectDefined(randomLive()), field });
		} else if (roll < 0.47) {
			actions.push({ kind: "sync-now" });
		} else if (roll < 0.62) {
			actions.push(generateDashboardIntent(random, serial));
		} else if (roll < 0.72) {
			actions.push({ kind: "dashboard-junk", payload: generateJunkPayload(random, serial) });
		} else if (roll < 0.87) {
			actions.push(generateChat(random));
		} else if (roll < 0.92) {
			actions.push({ kind: "chat-cancel", chunkCount: 30, cancelAfter: 1 + Math.floor(random() * 5) });
		} else if (roll < 0.96) {
			actions.push({ kind: "set-model-parameters", valid: random() < 0.6, serial });
		} else {
			actions.push({ kind: "set-headers", valid: random() < 0.6, serial });
		}
	}
	return actions;
}

// -- Oracle state -------------------------------------------------------------

/** The health class a label's FIRST synced configuration establishes, permanently. */
type HealthKind = "proxy" | "fake" | "dark";

interface OracleEntry {
	/** The raw settings entry as currently declared (post any redeclare mutation). */
	entry: Record<string, string>;
	/** JSON of the resolved group args at the label's first sync: the host group's immutable content. */
	hostArgs: string;
	health: HealthKind;
	/**
	 * True once the label's healthy discovery was proven (the declare's model
	 * wait passed), so its later removal must subtract from the model-count
	 * floors. Dark labels and a declare that died mid-wait never set it.
	 */
	provenHealthy: boolean;
}

/** Sentinel for "reset removed the configured value"; distinct from "never touched". */
const UNSET = Symbol("unset");

/**
 * Every Memento key shared/config/storageKeys.ts declares as globalState; the
 * storage probe admits nothing else. SecretStorage key names stay OUT of this
 * list on purpose: one of them turning up in globalState would mean secret
 * material landed in the wrong store, exactly what the probe must catch.
 */
const KNOWN_MEMENTO_KEYS: readonly string[] = [
	SERVER_REGISTRY_KEY,
	HAS_SHOWN_WELCOME_KEY,
	LAST_CONNECTION_STATUS_KEY,
	GROUP_MIGRATION_COMPLETE_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	MIGRATED_ENTRY_PARAMETER_COPIES_KEY,
	MIGRATED_SERVER_IDS_KEY,
	SERVER_SYNC_FINGERPRINTS_KEY,
	SYNCED_ENTRY_BASE_URLS_KEY,
	REMOVED_GROUP_TOMBSTONES_KEY,
	ORPHANED_GROUP_PROVENANCE_KEY,
	LEGACY_CLEANUP_PENDING_KEY,
];

/** Aliases the proxy registers and upstream ids the fake backend registers, for the unknown-model check. */
const KNOWN_STACK_MODEL_IDS: ReadonlySet<string> = new Set(
	FAKE_MODELS.filter((model) => model.blocked !== true).flatMap((model) => [
		model.alias,
		...model.deployments.map((deployment) => deployment.upstreamModel),
	])
);

/** The direct-discovery id a healthy fake-backend group registers (docker-fuzz's direct target). */
const FAKE_ANCHOR_ID = "fake-mini";

/** Live chat targets always served by the anchor's proxy group; independent literals on purpose. */
const PROXY_CHAT_ALIASES: readonly string[] = [PLAYBACK_MODEL.alias, "claude-opus-4-5", "gpt-5.2", "deepseek-r2"];

// -- Executor -----------------------------------------------------------------

export interface MonkeyEnv {
	/** The LiteLLM proxy base URL. */
	baseUrl: string;
	/** The fake OpenAI backend base URL (OAuth mode targets its /authed mirror). */
	fakeUrl: string;
	/** The proxy master key. */
	apiKey: string;
	seed: number;
}

const PROBE_INTERVAL = 5;
const RESPONSIVENESS_TIMEOUT_MS = 15000;
const MODEL_WAIT_MS = 60000;

/**
 * One monkey session per extension host: the oracle state spans walks
 * because provider groups and settings do. runActions namespaces each run's
 * labels freshly (an execution counter on top of the seed), so shrink
 * candidates and corpus replays never collide with earlier runs' add-only
 * groups.
 */
export class MonkeySession {
	private declared = new Map<string, OracleEntry>();
	/** SecretStorage blobs by real label; kept across removals like the real store keeps them. */
	private stored = new Map<string, Partial<Record<SecretFieldId, string>>>();
	/** Add-only across the whole session: healthy group counts only ever grow. */
	private everSyncedHealthy = { proxy: 0, fake: 0 };
	/**
	 * Healthy ever-synced groups whose declared entry was later explicitly
	 * removed: the removal tombstones the group (label plus base URL), so the
	 * provider answers it with zero models until a matching entry reappears.
	 * Labels are never recycled in this fuzzer, so hidden stays hidden and the
	 * live model-count floor is everSyncedHealthy minus this.
	 */
	private hiddenHealthy = { proxy: 0, fake: 0 };
	private expectedSettings = new Map<string, unknown | typeof UNSET>();
	private minted: string[] = [];
	/**
	 * Every recentLogs line seen this session, accumulated after each action:
	 * the extension's buffer is a 50-entry rolling window, so a busy sync
	 * burst could evict a leaked credential before the every-5-steps probe.
	 * Residual limitation, documented rather than papered over: lines evicted
	 * WITHIN one action's burst can still escape, and the separately stored
	 * latest error is not exposed to tests; closing either gap would need a
	 * production seam.
	 */
	private seenLogLines = new Set<string>();
	private baselineModelIds: ReadonlySet<string> = new Set();
	/**
	 * Pre-session copies of the two anchor IDs: the model-count floors are
	 * baseline + newly-synced, so a NEW healthy group failing discovery can
	 * never hide behind pre-existing groups' copies satisfying a bare count.
	 */
	private baselineCopies = { proxy: 0, fake: 0 };
	private executionCounter = 0;
	private probeCounter = 0;
	private anchorLabel: string;

	constructor(private readonly env: MonkeyEnv) {
		this.anchorLabel = `monkey-${env.seed}-anchor`;
	}

	private config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(CONFIG_SECTION);
	}

	private readServersSetting(): Record<string, string>[] {
		const raw = this.config().inspect(SERVERS_SETTING_KEY)?.globalValue;
		return Array.isArray(raw) ? (raw as Record<string, string>[]).map((entry) => ({ ...entry })) : [];
	}

	private async writeServersSetting(entries: readonly Record<string, string>[]): Promise<void> {
		await this.config().update(SERVERS_SETTING_KEY, entries, vscode.ConfigurationTarget.Global);
	}

	/** A forced sync pass plus the host-refresh round trip, exactly what Sync Models Now runs. */
	private async syncNow(): Promise<void> {
		await vscode.commands.executeCommand(CMD.syncModels);
	}

	private async getDeclaredViews(): Promise<readonly DeclaredServerView[]> {
		return (await vscode.commands.executeCommand("litellm._test.getDeclaredServers")) as readonly DeclaredServerView[];
	}

	private setStoredSecret(label: string, field: SecretFieldId, value: string | undefined): Thenable<unknown> {
		return vscode.commands.executeCommand("litellm._test.setServerSecret", label, field, value);
	}

	private async dashboardMessage(raw: unknown): Promise<string> {
		return (await vscode.commands.executeCommand("litellm._test.dashboardMessage", raw)) as string;
	}

	/** The real resolution rule: parse the entry as the engine would, resolve secrets inline-first. */
	private resolvedArgs(entry: Record<string, string>, label: string): string {
		const parsed = expectDefined(
			parseServersSetting([entry]).entries[0],
			`oracle entry for ${label} must stay parseable`
		);
		return JSON.stringify(buildGroupArgs(parsed, this.stored.get(label) ?? {}));
	}

	private expectedSyncError(label: string): string | undefined {
		const oracle = expectDefined(this.declared.get(label), `oracle entry for ${label}`);
		return this.resolvedArgs(oracle.entry, label) === oracle.hostArgs ? undefined : GROUP_UPDATE_UNAVAILABLE_MESSAGE;
	}

	private expectedSecretLocation(label: string, field: SecretFieldId): "settings" | "secure" | "none" {
		const oracle = expectDefined(this.declared.get(label), `oracle entry for ${label}`);
		if ((oracle.entry[field] ?? "").trim().length > 0) {
			return "settings";
		}
		return this.stored.get(label)?.[field] !== undefined ? "secure" : "none";
	}

	private async chatModel(id: string): Promise<vscode.LanguageModelChat> {
		const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
		return expectDefined(
			models.find((model) => model.id === id),
			`live model ${id}`
		);
	}

	private async chat(modelId: string, text: string): Promise<string> {
		const model = await this.chatModel(modelId);
		const response = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User(text)],
			{},
			new vscode.CancellationTokenSource().token
		);
		return extractText(await collectStream(response));
	}

	private countModels(models: readonly vscode.LanguageModelChat[], id: string): number {
		return models.filter((model) => model.id === id).length;
	}

	/**
	 * Declare an entry, force a sync, and settle the oracle: a healthy
	 * configuration must raise its id's copy count (the only host-visible
	 * proof THIS group's discovery succeeded); a dark one syncs its group and
	 * serves nothing.
	 */
	private async declare(label: string, credential: CredentialMode): Promise<void> {
		const serial = ++this.probeCounter;
		const entry: Record<string, string> = { label, baseUrl: this.env.baseUrl };
		let health: HealthKind = "proxy";
		switch (credential) {
			case "inline":
				entry.apiKey = this.env.apiKey;
				break;
			case "secure": {
				// The blob lands BEFORE the entry, so the first sync pass resolves it.
				await this.setStoredSecret(label, "apiKey", this.env.apiKey);
				const blob = this.stored.get(label) ?? {};
				blob.apiKey = this.env.apiKey;
				this.stored.set(label, blob);
				break;
			}
			case "virtual-key":
				entry.virtualKeyHeader = "x-litellm-api-key";
				entry.virtualKeyValue = this.env.apiKey;
				break;
			case "oauth":
				entry.baseUrl = `${this.env.fakeUrl}/authed`;
				entry.oauthTokenUrl = `${this.env.fakeUrl}/oauth/token`;
				entry.oauthClientId = FAKE_OAUTH_CLIENT_ID;
				entry.oauthClientSecret = FAKE_OAUTH_CLIENT_SECRET;
				health = "fake";
				break;
			case "bad-key": {
				const mintedKey = `sk-monkey-${this.env.seed}-${serial}`;
				this.minted.push(mintedKey);
				entry.apiKey = mintedKey;
				health = "dark";
				break;
			}
			case "none":
				health = "dark";
				break;
		}
		await this.writeServersSetting([...this.readServersSetting(), entry]);
		await this.syncNow();
		const oracle: OracleEntry = { entry, hostArgs: this.resolvedArgs(entry, label), health, provenHealthy: false };
		this.declared.set(label, oracle);
		if (health === "proxy") {
			// Increment only after the wait: a timed-out wait must fail THIS
			// declare without poisoning every later model-count floor (and, via
			// cascading probe failures, the shrunk trace).
			const wanted = this.baselineCopies.proxy + this.everSyncedHealthy.proxy - this.hiddenHealthy.proxy + 1;
			await waitForHostModels(
				MODEL_WAIT_MS,
				(models) => this.countModels(models, PLAYBACK_MODEL.alias) >= wanted,
				`${wanted} cop(ies) of ${PLAYBACK_MODEL.alias} (baseline + live healthy proxy groups)`
			);
			this.everSyncedHealthy.proxy += 1;
			oracle.provenHealthy = true;
		} else if (health === "fake") {
			const wanted = this.baselineCopies.fake + this.everSyncedHealthy.fake - this.hiddenHealthy.fake + 1;
			await waitForHostModels(
				MODEL_WAIT_MS,
				(models) => this.countModels(models, FAKE_ANCHOR_ID) >= wanted,
				`${wanted} cop(ies) of ${FAKE_ANCHOR_ID} (baseline + live healthy fake-backend groups)`
			);
			this.everSyncedHealthy.fake += 1;
			oracle.provenHealthy = true;
		}
		const view = await this.declaredView(label);
		assert.strictEqual(view.syncError, this.expectedSyncError(label), `declare(${credential}) sync outcome diverged`);
	}

	private async declaredView(label: string): Promise<DeclaredServerView> {
		return expectDefined(
			(await this.getDeclaredViews()).find((view) => view.label === label),
			`declared view for ${label}`
		);
	}

	/**
	 * Settle the oracle for one label's explicit removal: the sync engine
	 * tombstones the group (its models leave the host list until a matching
	 * entry reappears, which never happens here - labels are not recycled), so
	 * a proven-healthy label's copies come out of the model-count floors.
	 * Returns the anchor id whose count the caller must then OBSERVE dropping
	 * (see observeHiddenDrop), so the subtraction is never taken on faith.
	 */
	private hideRemovedLabel(label: string): string | undefined {
		const oracle = this.declared.get(label);
		if (oracle === undefined) {
			return undefined;
		}
		this.declared.delete(label);
		if (!oracle.provenHealthy) {
			return undefined;
		}
		if (oracle.health === "proxy") {
			this.hiddenHealthy.proxy += 1;
			return PLAYBACK_MODEL.alias;
		}
		if (oracle.health === "fake") {
			this.hiddenHealthy.fake += 1;
			return FAKE_ANCHOR_ID;
		}
		return undefined;
	}

	/**
	 * Observe a removal's hiding actually land: wait until the anchor's copy
	 * count drops below its pre-removal sample. Raw model IDs carry no group
	 * identity, so this cannot attribute the drop to the exact removed group -
	 * a wrongly-suppressed sibling's drop would satisfy it (the residual
	 * attribution limitation the header documents) - but it does keep the
	 * floor subtraction honest: the count provably went down, and the >= floor
	 * probe keeps every other group accounted.
	 */
	private async observeHiddenDrop(anchorId: string, beforeCount: number): Promise<void> {
		await waitForHostModels(
			MODEL_WAIT_MS,
			(models) => this.countModels(models, anchorId) <= beforeCount - 1,
			`the removed group's tombstone to take a copy of ${anchorId} out of the host list (< ${beforeCount})`
		);
	}

	/** Capture the pre-session host models, so pre-existing provider groups never read as monkey escapes. */
	async setup(): Promise<void> {
		// A models.ts rename must fail HERE, loudly, not as a mysterious
		// missing-model timeout mid-walk.
		for (const alias of PROXY_CHAT_ALIASES) {
			assert.ok(KNOWN_STACK_MODEL_IDS.has(alias), `chat target ${alias} is not in the fake stack's model catalog`);
		}
		assert.ok(KNOWN_STACK_MODEL_IDS.has(FAKE_ANCHOR_ID), `${FAKE_ANCHOR_ID} is not in the fake stack's model catalog`);
		// Pre-existing provider GROUPS are tolerated via the baseline snapshot;
		// a pre-existing servers SETTING is not part of any walk's oracle, so
		// the session starts from a declaratively empty slate (the caller
		// restores the original value at suite teardown).
		await this.writeServersSetting([]);
		const baseline = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
		this.baselineModelIds = new Set(baseline.map((model) => model.id));
		this.baselineCopies = {
			proxy: this.countModels(baseline, PLAYBACK_MODEL.alias),
			fake: this.countModels(baseline, FAKE_ANCHOR_ID),
		};
		await this.declare(this.anchorLabel, "inline");
	}

	/** The servers-setting entries the oracle expects, in declaration order. */
	private expectedEntries(): Record<string, string>[] {
		return [...this.declared.values()].map((oracle) => oracle.entry);
	}

	private async runAction(action: MonkeyAction, namespace: string): Promise<void> {
		const label = (token: string) => `monkey-${this.env.seed}-${namespace}-${token}`;
		switch (action.kind) {
			case "declare-server":
				await this.declare(label(action.label), action.credential);
				return;
			case "redeclare-server": {
				const real = label(action.label);
				const oracle = this.declared.get(real);
				if (oracle === undefined) {
					return; // Shrinking removed the declare; nothing to mutate.
				}
				const mutated = { ...oracle.entry, baseUrl: `${oracle.entry.baseUrl}/changed` };
				await this.writeServersSetting(
					this.readServersSetting().map((entry) => (entry.label === real ? mutated : entry))
				);
				oracle.entry = mutated;
				await this.syncNow();
				const view = await this.declaredView(real);
				assert.strictEqual(
					view.syncError,
					GROUP_UPDATE_UNAVAILABLE_MESSAGE,
					"a redeclared label must surface the add-only error"
				);
				return;
			}
			case "remove-server": {
				const real = label(action.label);
				const oracle = this.declared.get(real);
				if (oracle === undefined) {
					return;
				}
				// Sampled BEFORE the removal pass so the post-removal drop is
				// observable against it; only healthy labels have models to lose.
				const anchorId =
					oracle.provenHealthy && oracle.health !== "dark"
						? oracle.health === "proxy"
							? PLAYBACK_MODEL.alias
							: FAKE_ANCHOR_ID
						: undefined;
				const before =
					anchorId !== undefined
						? this.countModels(await vscode.lm.selectChatModels({ vendor: VENDOR_ID }), anchorId)
						: 0;
				await this.writeServersSetting(this.readServersSetting().filter((entry) => entry.label !== real));
				this.hideRemovedLabel(real);
				await this.syncNow();
				const views = await this.getDeclaredViews();
				assert.ok(
					views.every((view) => view.label !== real),
					"a removed entry must leave the declared views"
				);
				// The host group itself persists (no removal API), but the explicit
				// removal tombstones it, so the provider answers it with zero
				// models: hideRemovedLabel took its copies out of the model-count
				// floors, and the drop is observed here rather than assumed.
				// Labels are never recycled, so nothing in a walk can clear the
				// tombstone and re-raise the floor.
				if (anchorId !== undefined) {
					await this.observeHiddenDrop(anchorId, before);
				}
				return;
			}
			case "set-secret": {
				const real = label(action.label);
				if (!this.declared.has(real)) {
					return;
				}
				const value =
					action.field === "oauthClientSecret"
						? `monkey-oauth-secret-${action.serial}`
						: `sk-monkey-${this.env.seed}-${action.serial}`;
				this.minted.push(value);
				await this.setStoredSecret(real, action.field, value);
				const blob = this.stored.get(real) ?? {};
				blob[action.field] = value;
				this.stored.set(real, blob);
				await this.syncNow();
				const view = await this.declaredView(real);
				assert.strictEqual(view.secrets[action.field], this.expectedSecretLocation(real, action.field));
				assert.strictEqual(view.syncError, this.expectedSyncError(real), "set-secret sync outcome diverged");
				return;
			}
			case "clear-secret": {
				const real = label(action.label);
				if (!this.declared.has(real)) {
					return;
				}
				await this.setStoredSecret(real, action.field, undefined);
				const blob = this.stored.get(real);
				if (blob !== undefined) {
					delete blob[action.field];
				}
				await this.syncNow();
				const view = await this.declaredView(real);
				assert.strictEqual(view.secrets[action.field], this.expectedSecretLocation(real, action.field));
				assert.strictEqual(view.syncError, this.expectedSyncError(real), "clear-secret sync outcome diverged");
				return;
			}
			case "sync-now":
				await this.syncNow();
				return;
			case "dashboard-intent": {
				const outcome = await this.dashboardMessage(action.intent);
				assert.strictEqual(outcome, action.expect, `dashboard intent ${JSON.stringify(action.intent)}`);
				if (outcome === "ok") {
					this.recordIntentEffect(action.intent);
				}
				return;
			}
			case "dashboard-junk": {
				const outcome = await this.dashboardMessage(action.payload);
				assert.ok(
					outcome === "ignored-malformed" || outcome === "validation-error",
					`junk must never act: got ${outcome} for ${JSON.stringify(action.payload)}`
				);
				return;
			}
			case "chat":
				await this.runChat(action);
				return;
			case "chat-cancel":
				await this.runChatCancel(action);
				return;
			case "set-model-parameters":
				await this.runSetModelParameters(action);
				return;
			case "set-headers":
				await this.runSetHeaders(action);
				return;
		}
	}

	/** Mirror a schema-valid, value-valid dashboard intent's write into the settings oracle. */
	private recordIntentEffect(intent: unknown): void {
		const record = intent as { type: string; setting?: string; value?: unknown };
		switch (record.type) {
			case "setNumberSetting":
			case "setBooleanSetting":
				this.expectedSettings.set(expectDefined(record.setting), record.value);
				return;
			case "resetSetting":
				this.expectedSettings.set(expectDefined(record.setting), UNSET);
				return;
			case "setModelParameters":
				this.expectedSettings.set(MODEL_PARAMETERS_SETTING_KEY, record.value);
				return;
			case "setHeaders":
				this.expectedSettings.set(HEADERS_SETTING_KEY, record.value);
				return;
			default:
				return;
		}
	}

	/**
	 * The chat action's model target. The fake anchor joins the pool only
	 * while a healthy, non-removed fake-backend group exists (chatting it
	 * otherwise would fail on a missing or tombstone-hidden model, by
	 * construction, not by bug). Known caveat: a shrink candidate that drops
	 * an oauth declare or a remove therefore resolves later picks differently
	 * than the original walk did - acceptable, because shrinking only needs
	 * SOME failing trace, and identical runs (the determinism contract) still
	 * resolve every pick identically.
	 */
	private chatTarget(pick: number): string {
		const candidates = [...PROXY_CHAT_ALIASES];
		if (this.everSyncedHealthy.fake - this.hiddenHealthy.fake > 0) {
			candidates.push(FAKE_ANCHOR_ID);
		}
		return expectDefined(candidates[pick % candidates.length]);
	}

	private async runChat(action: Extract<MonkeyAction, { kind: "chat" }>): Promise<void> {
		const target = this.chatTarget(action.pick);
		switch (action.verb) {
			case "echo": {
				const text = `monkey ${action.a}-${action.b}`;
				assert.strictEqual(
					await this.chat(target, `${COMMAND_SIGIL}echo:${text}`),
					text,
					`echo on ${target} must round-trip verbatim`
				);
				return;
			}
			case "text": {
				const reply = await this.chat(target, `${COMMAND_SIGIL}text:${action.a}:${action.b}`);
				assert.strictEqual(
					reply.trim().split(/\s+/).length,
					action.a,
					`${COMMAND_SIGIL}text on ${target} must produce exactly n words`
				);
				return;
			}
			case "think":
				assert.strictEqual(
					await this.chat(target, `${COMMAND_SIGIL}think:${action.a}`),
					`Finished thinking in ${action.a} steps.`,
					`think on ${target} has a fixed closing text`
				);
				return;
			case "stream": {
				const expected = Array.from({ length: action.a }, (_, i) => `chunk${i + 1} `).join("");
				assert.strictEqual(
					await this.chat(target, `${COMMAND_SIGIL}stream:${action.a}:10`),
					expected,
					`stream on ${target} must deliver every numbered chunk`
				);
				return;
			}
		}
	}

	/** docker-fuzz's cancellation contract: stop early, deliver almost nothing after the cancel, die promptly. */
	private async runChatCancel(action: Extract<MonkeyAction, { kind: "chat-cancel" }>): Promise<void> {
		const model = await this.chatModel(PLAYBACK_MODEL.alias);
		const source = new vscode.CancellationTokenSource();
		const request = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User(`${COMMAND_SIGIL}stream:${action.chunkCount}:100`)],
			{},
			source.token
		);
		const parts: unknown[] = [];
		const started = Date.now();
		let partsWhenCancelled = 0;
		try {
			for await (const part of request.stream) {
				parts.push(part);
				if (parts.length === action.cancelAfter) {
					partsWhenCancelled = parts.length;
					source.cancel();
				}
			}
		} catch (error) {
			assert.ok(
				error instanceof vscode.CancellationError || /cancel/i.test(String(error)),
				`expected a cancellation error, got ${String(error)}`
			);
		}
		const elapsed = Date.now() - started;
		assert.ok(
			parts.length < action.chunkCount / 2,
			`stream must stop early: got ${parts.length} of ${action.chunkCount}`
		);
		assert.ok(
			parts.length - partsWhenCancelled <= 3,
			`stream kept emitting after cancel: ${parts.length - partsWhenCancelled} extra parts`
		);
		assert.ok(elapsed < 20000, `stream must terminate promptly after cancel, took ${elapsed}ms`);
	}

	private async fetchLastRequest(): Promise<Record<string, unknown>> {
		const response = await fetch(`${this.env.fakeUrl}/_test/last-request`);
		assert.ok(response.ok, `GET /_test/last-request failed: ${response.status}`);
		return (await response.json()) as Record<string, unknown>;
	}

	/**
	 * Direct settings write, then a wire-level spot check via %params and the
	 * fake backend's last-request capture. Valid parameters must pass through
	 * unchanged; the invalid classes the extension owns ("_"-prefixed keys,
	 * provider-owned fields) must be dropped silently while the chat keeps
	 * working. Arbitrary junk values are NOT generated: pass-through is the
	 * contract, so an unknown value would reach LiteLLM and fail the request
	 * by design, not by bug.
	 */
	private async runSetModelParameters(action: Extract<MonkeyAction, { kind: "set-model-parameters" }>): Promise<void> {
		const temperature = expectDefined(TEMPERATURES[action.serial % TEMPERATURES.length]);
		const value = action.valid
			? { [PLAYBACK_MODEL.alias]: { temperature, seed: 1000 + action.serial } }
			: { [PLAYBACK_MODEL.alias]: { _monkey: action.serial, model: "monkey-hax-model" } };
		await this.config().update(MODEL_PARAMETERS_SETTING_KEY, value, vscode.ConfigurationTarget.Global);
		this.expectedSettings.set(MODEL_PARAMETERS_SETTING_KEY, value);

		const reply = await this.chat(PLAYBACK_MODEL.alias, `${COMMAND_SIGIL}params`);
		const wire = await this.fetchLastRequest();
		if (action.valid) {
			assert.strictEqual(wire.temperature, temperature, "a configured temperature must reach the wire unchanged");
			assert.strictEqual(wire.seed, 1000 + action.serial, "a configured seed must reach the wire unchanged");
			assert.ok(reply.includes("temperature"), `%params must report the temperature; got: ${reply.slice(0, 200)}`);
			assert.ok(reply.includes(String(temperature)), `%params must carry the exact value; got: ${reply.slice(0, 200)}`);
		} else {
			assert.ok(!("_monkey" in wire), "underscore-prefixed parameters must never reach the wire");
			assert.notStrictEqual(wire.model, "monkey-hax-model", "the provider-owned model field must not be overridable");
			assert.ok(!reply.includes("monkey-hax-model"), "%params must not report a hijacked model");
		}
	}

	/**
	 * Direct settings write for custom headers. A valid header rides every
	 * request (unobservable through the chat body, so the oracle is the chat
	 * still succeeding); an invalid name is silently dropped at request time,
	 * so the same chat MUST still succeed - a thrown request would mean the
	 * invalid setting broke the transport.
	 */
	private async runSetHeaders(action: Extract<MonkeyAction, { kind: "set-headers" }>): Promise<void> {
		const value = action.valid
			? { [`x-monkey-${action.serial}`]: `monkey-${action.serial}` }
			: { [`bad header ${action.serial}`]: "dropped", [`x-monkey-ok-${action.serial}`]: "kept" };
		await this.config().update(HEADERS_SETTING_KEY, value, vscode.ConfigurationTarget.Global);
		this.expectedSettings.set(HEADERS_SETTING_KEY, value);
		const text = `headers-${action.serial}`;
		assert.strictEqual(
			await this.chat(PLAYBACK_MODEL.alias, `${COMMAND_SIGIL}echo:${text}`),
			text,
			"chat must keep working under the new headers setting"
		);
	}

	// -- The probe bundle -------------------------------------------------------

	private async probeResponsiveness(): Promise<void> {
		const marker = `probe-${++this.probeCounter}`;
		const reply = await Promise.race([
			this.chat(PLAYBACK_MODEL.alias, `${COMMAND_SIGIL}echo:${marker}`),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`responsiveness probe timed out after ${RESPONSIVENESS_TIMEOUT_MS}ms`)),
					RESPONSIVENESS_TIMEOUT_MS
				)
			),
		]);
		assert.strictEqual(reply, marker, "the known-good model must echo the probe");
	}

	private async probeModelList(): Promise<void> {
		const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
		// Live floors: every healthy ever-synced group keeps its models UNLESS
		// its entry was explicitly removed - the removal tombstone hides the
		// group until a matching entry reappears, and walk labels never recur.
		const proxyFloor = this.baselineCopies.proxy + this.everSyncedHealthy.proxy - this.hiddenHealthy.proxy;
		const fakeFloor = this.baselineCopies.fake + this.everSyncedHealthy.fake - this.hiddenHealthy.fake;
		assert.ok(
			this.countModels(models, PLAYBACK_MODEL.alias) >= proxyFloor,
			`every healthy non-removed proxy group keeps its models: wanted >= ${proxyFloor} copies of ${PLAYBACK_MODEL.alias}`
		);
		assert.ok(
			this.countModels(models, FAKE_ANCHOR_ID) >= fakeFloor,
			`every healthy non-removed fake group keeps its models: wanted >= ${fakeFloor} copies of ${FAKE_ANCHOR_ID}`
		);
		for (const model of models) {
			assert.ok(
				KNOWN_STACK_MODEL_IDS.has(model.id) || this.baselineModelIds.has(model.id),
				`unknown litellm model ${model.id}: never declared this session and not in the pre-session baseline`
			);
		}
	}

	private async probeViewConsistency(): Promise<void> {
		const views = await this.getDeclaredViews();
		assert.deepStrictEqual(
			[...views.map((view) => view.label)].sort(),
			[...this.declared.keys()].sort(),
			"declared view labels diverged from the oracle"
		);
		for (const view of views) {
			assert.strictEqual(view.syncError, this.expectedSyncError(view.label), `syncError diverged for ${view.label}`);
			for (const field of ["apiKey", "oauthClientSecret", "virtualKeyValue"] as const) {
				assert.strictEqual(
					view.secrets[field],
					this.expectedSecretLocation(view.label, field),
					`secret location diverged for ${view.label}.${field}`
				);
			}
		}
	}

	private async probeSettingsAgreement(): Promise<void> {
		const parsed = parseServersSetting(this.config().inspect(SERVERS_SETTING_KEY)?.globalValue);
		const expected = parseServersSetting(this.expectedEntries());
		const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
		assert.deepStrictEqual(
			[...parsed.entries].sort(byLabel),
			[...expected.entries].sort(byLabel),
			"the accepted servers setting diverged from the oracle"
		);
		for (const [key, wanted] of this.expectedSettings) {
			const actual = this.config().inspect(key)?.globalValue;
			if (wanted === UNSET) {
				assert.strictEqual(actual, undefined, `reset ${key} must leave no global value`);
			} else {
				assert.deepStrictEqual(actual, wanted, `setting ${key} diverged from the oracle`);
			}
		}
	}

	/** Fold the current rolling log window into the session accumulator (see seenLogLines). */
	private async recordRecentLogs(): Promise<void> {
		const logs = (await vscode.commands.executeCommand("litellm._test.getRecentLogs")) as string[];
		for (const line of logs) {
			this.seenLogLines.add(line);
		}
	}

	private async probeSecretHygiene(): Promise<void> {
		await this.recordRecentLogs();
		// Minted values plus the realistic literals the stack actually uses:
		// the proxy master key and the fake identity provider's client secret.
		const secrets = [...this.minted, this.env.apiKey, FAKE_OAUTH_CLIENT_SECRET];
		for (const line of this.seenLogLines) {
			for (const secret of secrets) {
				assert.ok(!line.includes(secret), "a secret leaked into the classification-only log buffer");
			}
		}
	}

	private async probeStorageKeys(): Promise<void> {
		const keys = (await vscode.commands.executeCommand("litellm._test.getStorageKeys")) as string[];
		for (const key of keys) {
			assert.ok(
				KNOWN_MEMENTO_KEYS.includes(key),
				`globalState key ${key} is not declared in shared/config/storageKeys.ts`
			);
		}
	}

	private async runProbes(): Promise<void> {
		await this.probeResponsiveness();
		await this.probeModelList();
		await this.probeViewConsistency();
		await this.probeSettingsAgreement();
		await this.probeSecretHygiene();
		await this.probeStorageKeys();
	}

	/**
	 * Run one action list under a fresh label namespace: probes every
	 * PROBE_INTERVAL steps plus once at the end, and a cleanup (even on
	 * failure) that removes this run's declared entries so the next run's
	 * view-consistency probe starts from the oracle's steady state. The
	 * add-only side effects (host groups, ever-synced counts, minted secrets)
	 * stay, by design; the cleanup's removals tombstone this run's groups, so
	 * their healthy copies move to the hidden side of the floors.
	 */
	async runActions(walkTag: string, actions: readonly MonkeyAction[]): Promise<void> {
		// Fresh namespace per run, never recycled: reusing a removed label would
		// hit the add-only duplicate rejection with a pruned fingerprint (see
		// generateWalk's label allocation) and desynchronize oracle from engine.
		const namespace = `${walkTag}-r${++this.executionCounter}`;
		try {
			for (const [index, action] of actions.entries()) {
				await this.runAction(action, namespace);
				// Every action folds the rolling log window into the session
				// accumulator: the leak scan's inter-probe eviction window closes
				// here (see seenLogLines).
				await this.recordRecentLogs();
				if ((index + 1) % PROBE_INTERVAL === 0) {
					await this.runProbes();
				}
			}
			await this.runProbes();
		} finally {
			// A cleanup failure must not mask the walk's own verdict; the next
			// run's probes would catch durable damage anyway.
			try {
				await this.cleanupNamespace(namespace);
			} catch (cleanupError) {
				console.log(`monkey cleanup for ${namespace} failed: ${String(cleanupError)}`);
			}
		}
	}

	private async cleanupNamespace(namespace: string): Promise<void> {
		const prefix = `monkey-${this.env.seed}-${namespace}-`;
		// Pre-removal samples per anchor, so each hiding can be observed below.
		const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
		const before: Readonly<Record<string, number>> = {
			[PLAYBACK_MODEL.alias]: this.countModels(models, PLAYBACK_MODEL.alias),
			[FAKE_ANCHOR_ID]: this.countModels(models, FAKE_ANCHOR_ID),
		};
		const remaining = this.readServersSetting().filter((entry) => !(entry.label ?? "").startsWith(prefix));
		await this.writeServersSetting(remaining);
		const drops = new Map<string, number>();
		for (const label of [...this.declared.keys()]) {
			if (label.startsWith(prefix)) {
				// Cleanup is an explicit removal like the remove-server action:
				// the sync pass below tombstones each removed label's group, so
				// its healthy copies leave the model-count floors too.
				const anchorId = this.hideRemovedLabel(label);
				if (anchorId !== undefined) {
					drops.set(anchorId, (drops.get(anchorId) ?? 0) + 1);
				}
			}
		}
		await this.syncNow();
		// Observed like remove-server's drop: the next run's probes start from
		// floors this cleanup lowered, so the lowering must have provably
		// happened before this run hands over.
		for (const [anchorId, dropped] of drops) {
			await this.observeHiddenDrop(anchorId, (before[anchorId] ?? 0) - dropped + 1);
		}
	}
}

// -- Shrinking and reporting --------------------------------------------------

export const MAX_SHRINK_RUNS = 12;

/**
 * Span-removal shrinking, ported from docker-fuzz's shrinkFailure: try
 * removing spans, halving the span size down to single actions, bounded by
 * MAX_SHRINK_RUNS re-executions. Monkey runs are stateful, so a candidate
 * executes under its own fresh namespace; an infrastructure flake during a
 * candidate counts as a reproduction, which the bound also contains.
 */
export async function shrinkMonkeyFailure(
	session: MonkeySession,
	walkTag: string,
	actions: readonly MonkeyAction[]
): Promise<MonkeyAction[]> {
	let current = [...actions];
	let budget = MAX_SHRINK_RUNS;
	let step = Math.max(1, Math.floor(current.length / 2));
	while (budget > 0) {
		let shrunk = false;
		for (let start = 0; start < current.length && budget > 0; start += step) {
			const candidate = [...current.slice(0, start), ...current.slice(start + step)];
			if (candidate.length === 0) {
				continue;
			}
			budget--;
			try {
				await session.runActions(`${walkTag}-shrink${budget}`, candidate);
			} catch {
				current = candidate;
				shrunk = true;
				break;
			}
		}
		if (shrunk) {
			step = Math.min(step, Math.max(1, Math.floor(current.length / 2)));
		} else if (step > 1) {
			step = Math.max(1, Math.floor(step / 2));
		} else {
			break;
		}
	}
	return current;
}

/** The failure report, mirroring the stream fuzzer's shape: a minimal pinnable corpus entry. */
export function monkeyFailureReport(label: string, error: unknown, minimal: readonly MonkeyAction[]): Error {
	const entry: MonkeyCorpusEntry = { name: "<issue-ref>", actions: [...minimal] };
	const serialized = JSON.stringify(entry, null, 1);
	const detail =
		serialized.length > 12000 ? `${serialized.slice(0, 12000)}\n... (truncated; full repro via the seed)` : serialized;
	return new Error(`${label}: ${String(error)}\nMinimal failing corpus entry (add to monkeyCorpus.ts):\n${detail}`, {
		cause: error,
	});
}
