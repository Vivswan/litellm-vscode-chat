/**
 * The dashboard's state bridge: pure builders that reduce the existing stores
 * (the provider's status window, workspace configuration) to the serializable
 * DashboardState, and the validation plus execution of webview intents.
 *
 * Everything here takes its inputs as plain values or thin injected adapters,
 * so the whole module is unit-testable without a webview or a real
 * configuration store. panel.ts owns the vscode wiring.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ServerModelsSnapshot } from "../../provider";
import type { GroupServer, LiteLLMModelInfo } from "../../provider/groupModels";
import { modelSupportsPromptCaching } from "../../provider/groupModels";
import { fingerprint } from "../../shared/fingerprint";
import { isValidHeaderName, isValidHeaderValue } from "../../shared/headers";
import { isUnsafeRecordKey } from "../../shared/json";
import { normalizeModelParameters } from "../../shared/settings";
import { EXTENSION_SETTINGS_FILTER } from "../serverManagement";
import type { DeclaredServerView } from "../serverSync";
import type {
	BooleanSettingId,
	DashboardCommandId,
	DashboardIntentType,
	DashboardModel,
	DashboardServer,
	DashboardSettings,
	DashboardState,
	HeaderScalar,
	NumberSettingId,
	SaveServerPayload,
	ScopedRecordSetting,
	SecretDirective,
	SecretFieldId,
	SettingScope,
	WebviewToExtensionMessage,
} from "./protocol";
import {
	BOOLEAN_SETTING_IDS,
	DASHBOARD_COMMAND_IDS,
	NUMBER_SETTING_IDS,
	NUMBER_SETTINGS,
	SECRET_FIELD_IDS,
} from "./protocol";
import { isUsableHttpUrl, SERVER_FORM_FIELD_LABELS } from "./serverForm";

/** The per-scope values configuration inspection reports; a seam over WorkspaceConfiguration.inspect. */
export interface SettingsInspection {
	readonly defaultValue?: unknown;
	readonly globalValue?: unknown;
	readonly workspaceValue?: unknown;
	readonly workspaceFolderValue?: unknown;
}

/** Read access to the litellm-vscode-chat configuration section; a seam over WorkspaceConfiguration. */
export interface SettingsReader {
	/** The effective value for `key`, as WorkspaceConfiguration.get returns it. */
	get(key: string): unknown;
	/** Per-scope values for `key`, as WorkspaceConfiguration.inspect reports them. */
	inspect(key: string): SettingsInspection | undefined;
}

/**
 * Snapshots joined with the display label their server renders under. Labels
 * are not unique (two provider groups can point at one host, differing only
 * in credentials), so colliding labels get a positional suffix; the opaque
 * server IDs stay out of the state because they embed a credential
 * fingerprint.
 */
function labeledSnapshots(
	snapshots: readonly ServerModelsSnapshot[]
): { snapshot: ServerModelsSnapshot; label: string }[] {
	// The serverId tiebreak keeps the sort total: the status window's Map
	// re-inserts refreshed entries at the end, so without it two groups on one
	// host would swap ordinals whenever their insertion order churned.
	const sorted = [...snapshots].sort(
		(a, b) =>
			a.status.label.localeCompare(b.status.label) ||
			a.status.baseUrl.localeCompare(b.status.baseUrl) ||
			a.status.serverId.localeCompare(b.status.serverId)
	);
	const labelCounts = new Map<string, number>();
	for (const { status } of sorted) {
		labelCounts.set(status.label, (labelCounts.get(status.label) ?? 0) + 1);
	}
	const seen = new Map<string, number>();
	return sorted.map((snapshot) => {
		const { label } = snapshot.status;
		if ((labelCounts.get(label) ?? 0) < 2) {
			return { snapshot, label };
		}
		const ordinal = (seen.get(label) ?? 0) + 1;
		seen.set(label, ordinal);
		return { snapshot, label: `${label} (${ordinal})` };
	});
}

/**
 * The opaque token an external row carries so the adopt intent can name its
 * source group (DashboardServer.adoptHandle): a one-way hash of the server
 * ID, salted with a per-session random value. The salt is load-bearing: the
 * server ID embeds the group's unsalted credential fingerprint and the base
 * URL already sits in the state, so an unsalted hash would let anything able
 * to read webview state confirm guessed low-entropy keys offline by
 * reproducing the handle. Salted, the handle is stable across state pushes
 * within one session (an open adopt form survives background refreshes),
 * which is all adoption needs; nothing depends on it across sessions.
 */
const ADOPT_HANDLE_SALT = randomBytes(16).toString("hex");

function adoptSourceHandle(serverId: string): string {
	return fingerprint(`adopt-source:${ADOPT_HANDLE_SALT}:${serverId}`);
}

function buildServer(snapshot: ServerModelsSnapshot, label: string): DashboardServer {
	const { status } = snapshot;
	return {
		label,
		baseUrl: status.baseUrl,
		state: status.state,
		modelCount: status.modelCount,
		error: status.error,
		lastChecked: status.lastChecked,
		hasApiKey: status.hasApiKey === true,
		hasOAuth: false,
		origin: "external",
		adoptHandle: adoptSourceHandle(status.serverId),
	};
}

/** Trailing slashes are insignificant when matching a declared entry to a live group. */
function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

/**
 * Pair declared entries with live snapshots. Declared entries pair by the
 * group client ID first (the sync engine computes the same
 * credential-fingerprinted identity the provider stamps on its snapshots, so
 * entries sharing a base URL with different credentials join exactly), then by
 * label plus base URL, then by base URL alone for entries the engine has not
 * resolved yet. Shared by the state builder and the adopt intent's source
 * resolution, which must agree on which snapshots are external.
 */
function joinDeclared(
	labeled: readonly { snapshot: ServerModelsSnapshot; label: string }[],
	declared: readonly DeclaredServerView[]
): {
	/** Labeled-snapshot index by declared index, for entries a pass matched. */
	matchedByDeclared: Map<number, number>;
	/** Labeled-snapshot indices no declared entry claimed: the external rows. */
	unmatched: Set<number>;
} {
	const unmatched = new Set<number>(labeled.map((_, index) => index));
	const matchedByDeclared = new Map<number, number>();
	const passes: readonly ((snapshot: ServerModelsSnapshot, view: DeclaredServerView) => boolean)[] = [
		(snapshot, view) => view.expectedClientId !== undefined && snapshot.status.serverId === view.expectedClientId,
		(snapshot, view) =>
			snapshot.status.label === view.label &&
			normalizeBaseUrl(snapshot.status.baseUrl) === normalizeBaseUrl(view.baseUrl),
		(snapshot, view) => normalizeBaseUrl(snapshot.status.baseUrl) === normalizeBaseUrl(view.baseUrl),
	];
	for (const pass of passes) {
		declared.forEach((view, declaredIndex) => {
			if (matchedByDeclared.has(declaredIndex)) {
				return;
			}
			const found = [...unmatched].find((index) => {
				const entry = labeled[index];
				return entry !== undefined && pass(entry.snapshot, view);
			});
			if (found !== undefined) {
				matchedByDeclared.set(declaredIndex, found);
				unmatched.delete(found);
			}
		});
	}
	return { matchedByDeclared, unmatched };
}

/**
 * The servers section merges two sources: entries declared in the servers
 * setting (with their secret locations, for the edit form) and the live
 * provider groups the status window saw (reachability, model counts). A
 * declared entry the status window has not seen yet renders as "unchecked",
 * and a live group with no settings entry renders as external, managed
 * outside the setting.
 *
 * Provider-group snapshots are labeled by URL host (the host never hands the
 * group name to the extension), so the join cannot require a label match; see
 * joinDeclared for the pairing passes. `snapshotLabels` maps each snapshot to
 * the label its models render under: the declared label when joined, so the
 * models table agrees with the server rows.
 */
function buildServers(
	labeled: readonly { snapshot: ServerModelsSnapshot; label: string }[],
	declared: readonly DeclaredServerView[]
): { servers: DashboardServer[]; snapshotLabels: string[] } {
	const snapshotLabels = labeled.map(({ label }) => label);
	const { matchedByDeclared, unmatched } = joinDeclared(labeled, declared);
	const servers: DashboardServer[] = [];
	declared.forEach((view, declaredIndex) => {
		const matchedIndex = matchedByDeclared.get(declaredIndex);
		const status = matchedIndex !== undefined ? labeled[matchedIndex]?.snapshot.status : undefined;
		if (matchedIndex !== undefined) {
			snapshotLabels[matchedIndex] = view.label;
		}
		const syncError = view.syncError;
		servers.push({
			label: view.label,
			baseUrl: view.baseUrl,
			// The sync error always rides the row's error (a live status's own
			// error cannot mask it): the group still serving is the entry's OLD
			// configuration, and the remove-and-resync instruction must show.
			// A reachable group keeps its live state, though - the surfaces
			// render the error text alongside the live facts (diagnostics'
			// serverOutcomeText, the dashboard's per-server error list).
			state: status?.state ?? (syncError !== undefined ? "error" : "unchecked"),
			modelCount: status?.modelCount ?? 0,
			error: syncError ?? status?.error,
			lastChecked: status?.lastChecked,
			hasApiKey: status?.hasApiKey === true || view.secrets.apiKey !== "none",
			hasOAuth: view.oauthTokenUrl !== undefined && view.oauthClientId !== undefined,
			origin: "declared",
			config: {
				oauthTokenUrl: view.oauthTokenUrl,
				oauthClientId: view.oauthClientId,
				oauthScopes: view.oauthScopes,
				virtualKeyHeader: view.virtualKeyHeader,
				secrets: view.secrets,
			},
		});
	});
	for (const index of unmatched) {
		const entry = labeled[index];
		if (entry !== undefined) {
			servers.push(buildServer(entry.snapshot, entry.label));
		}
	}
	servers.sort((a, b) => a.label.localeCompare(b.label) || a.baseUrl.localeCompare(b.baseUrl));
	return { servers, snapshotLabels };
}

function buildModel(info: LiteLLMModelInfo, serverLabel: string): DashboardModel {
	return {
		id: info.id,
		name: info.name,
		family: info.family,
		serverLabel,
		maxInputTokens: info.maxInputTokens,
		maxOutputTokens: info.maxOutputTokens,
		inputCost: info.inputCost,
		outputCost: info.outputCost,
		cacheReadCost: info.cacheCost,
		cacheWriteCost: info.cacheWriteCost,
		longContextInputCost: info.longContextInputCost,
		longContextOutputCost: info.longContextOutputCost,
		longContextCacheReadCost: info.longContextCacheCost,
		longContextCacheWriteCost: info.longContextCacheWriteCost,
		toolCalling: Boolean(info.capabilities?.toolCalling),
		imageInput: Boolean(info.capabilities?.imageInput),
		promptCaching: modelSupportsPromptCaching(info),
		reasoning: info.configurationSchema !== undefined,
	};
}

/**
 * The value shown for a number setting: a configured finite number (or null
 * where null is legal) passes through even when out of range, because the
 * dashboard shows what is configured; anything unusable falls back to the
 * package.json default so the form still renders a real value.
 */
function readNumberSetting(reader: SettingsReader, id: NumberSettingId): number | null {
	const spec = NUMBER_SETTINGS[id];
	const raw = reader.get(id);
	if (spec.nullable && (raw === null || raw === undefined)) {
		return null;
	}
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return raw;
	}
	const fallback = reader.inspect(id)?.defaultValue;
	if (typeof fallback === "number" && Number.isFinite(fallback)) {
		return fallback;
	}
	return spec.nullable ? null : spec.minimum;
}

function readBooleanSetting(reader: SettingsReader, id: BooleanSettingId): boolean {
	const raw = reader.get(id);
	if (typeof raw === "boolean") {
		return raw;
	}
	const fallback = reader.inspect(id)?.defaultValue;
	return typeof fallback === "boolean" ? fallback : false;
}

/**
 * Header entries with scalar values, as one scope configured them. Unlike the
 * request path's normalization this keeps the configured types (a number
 * stays a number) and invalid header names, because the editor writes the
 * record back verbatim and must show the user what is really there; only
 * unrepresentable values (objects, arrays) and prototype-polluting keys are
 * dropped.
 */
function sanitizeHeaders(raw: unknown): Record<string, HeaderScalar> {
	const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
	if (!parsed.success) {
		return {};
	}
	const headers: Record<string, HeaderScalar> = {};
	for (const [name, value] of Object.entries(parsed.data)) {
		if (isUnsafeRecordKey(name)) {
			continue;
		}
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			headers[name] = value;
		}
	}
	return headers;
}

const ALL_SCOPES: readonly SettingScope[] = ["global", "workspace", "workspaceFolder"];

/**
 * Split an object setting by scope: the record the edit scope holds (which
 * the editors edit and writes replace whole) and, read-only, the records
 * other scopes hold. Built from inspection, never from the merged effective
 * value; see ScopedRecordSetting for why.
 */
function buildScopedRecord<V>(
	inspection: SettingsInspection | undefined,
	sanitize: (raw: unknown) => Record<string, V>
): ScopedRecordSetting<V> {
	const editScope = resolveUpdateScope(inspection);
	const rawByScope: Record<SettingScope, unknown> = {
		global: inspection?.globalValue,
		workspace: inspection?.workspaceValue,
		workspaceFolder: inspection?.workspaceFolderValue,
	};
	const otherScopes = ALL_SCOPES.filter((scope) => scope !== editScope)
		.map((scope) => ({ scope, value: sanitize(rawByScope[scope]) }))
		.filter((entry) => Object.keys(entry.value).length > 0);
	return { editScope, value: sanitize(rawByScope[editScope]), otherScopes };
}

export function readDashboardSettings(reader: SettingsReader): DashboardSettings {
	const numbers = {} as Record<NumberSettingId, number | null>;
	for (const id of NUMBER_SETTING_IDS) {
		numbers[id] = readNumberSetting(reader, id);
	}
	const booleans = {} as Record<BooleanSettingId, boolean>;
	for (const id of BOOLEAN_SETTING_IDS) {
		booleans[id] = readBooleanSetting(reader, id);
	}
	return {
		numbers,
		booleans,
		modelParameters: buildScopedRecord(reader.inspect("modelParameters"), normalizeModelParameters),
		headers: buildScopedRecord(reader.inspect("headers"), sanitizeHeaders),
	};
}

export function buildDashboardState(
	snapshots: readonly ServerModelsSnapshot[],
	reader: SettingsReader,
	declared: readonly DeclaredServerView[] = []
): DashboardState {
	const labeled = labeledSnapshots(snapshots);
	const { servers, snapshotLabels } = buildServers(labeled, declared);
	return {
		servers,
		models: labeled
			.flatMap(({ snapshot, label }, index) =>
				snapshot.models.map((info) => buildModel(info, snapshotLabels[index] ?? label))
			)
			.sort((a, b) => a.serverLabel.localeCompare(b.serverLabel) || a.name.localeCompare(b.name)),
		settings: readDashboardSettings(reader),
	};
}

/**
 * Where a settings write should land: the workspace when it already holds a
 * value, the user scope otherwise. WorkspaceFolder values are deliberately
 * never written to: the dashboard's configuration access is resource-less,
 * and a WorkspaceFolder update without a resource throws in multi-root
 * workspaces. A folder-scope record still shows up read-only in the scoped
 * settings view.
 */
export function resolveUpdateScope(
	inspection: Pick<SettingsInspection, "workspaceValue"> | undefined
): "global" | "workspace" {
	return inspection?.workspaceValue !== undefined ? "workspace" : "global";
}

const asEnum = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]]);

/**
 * A live group's connection material flattened to servers-setting field names,
 * for the adopt action. Values exist extension-side only: this shape is never
 * logged and never enters DashboardState.
 */
export interface AdoptableGroupCredentials {
	readonly apiKey?: string | undefined;
	readonly oauthTokenUrl?: string | undefined;
	readonly oauthClientId?: string | undefined;
	readonly oauthClientSecret?: string | undefined;
	readonly oauthScopes?: string | undefined;
	readonly virtualKeyHeader?: string | undefined;
	readonly virtualKeyValue?: string | undefined;
}

/**
 * Resolve the group an adopt intent names back to its credentials, by the
 * opaque handle its external row carried. Resolution re-derives the external
 * set at intent time and binds the handle to the intent's base URL, so a
 * forged or stale intent cannot copy a DECLARED group's secure credential into
 * a settings entry, and cannot re-point a copied credential at another host.
 * Returns undefined when no still-external group at this URL matches or the
 * matching snapshot carries no group connection (a registry server); the
 * caller adopts the plain entry with a caveat in that case.
 */
export function resolveAdoptableCredentials(
	snapshots: readonly ServerModelsSnapshot[],
	declared: readonly DeclaredServerView[],
	baseUrl: string,
	sourceHandle: string,
	getGroupServer: (serverId: string) => GroupServer | undefined
): AdoptableGroupCredentials | undefined {
	const labeled = labeledSnapshots(snapshots);
	const { unmatched } = joinDeclared(labeled, declared);
	const source = [...unmatched]
		.map((index) => labeled[index]?.snapshot)
		.find(
			(snapshot) =>
				snapshot !== undefined &&
				adoptSourceHandle(snapshot.status.serverId) === sourceHandle &&
				normalizeBaseUrl(snapshot.status.baseUrl) === normalizeBaseUrl(baseUrl)
		);
	if (source === undefined) {
		return undefined;
	}
	const server = getGroupServer(source.status.serverId);
	if (server === undefined) {
		return undefined;
	}
	return {
		...(server.apiKey.length > 0 ? { apiKey: server.apiKey } : {}),
		...(server.oauth !== undefined
			? {
					oauthTokenUrl: server.oauth.tokenUrl,
					oauthClientId: server.oauth.clientId,
					...(server.oauth.clientSecret.length > 0 ? { oauthClientSecret: server.oauth.clientSecret } : {}),
					...(server.oauth.scopes !== undefined ? { oauthScopes: server.oauth.scopes } : {}),
				}
			: {}),
		...(server.virtualKey !== undefined
			? { virtualKeyHeader: server.virtualKey.header, virtualKeyValue: server.virtualKey.value }
			: {}),
	};
}

const headerScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const secretDirectiveSchema: z.ZodType<SecretDirective> = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("keep") }),
	z.strictObject({ action: z.literal("clear") }),
	z.strictObject({
		action: z.literal("set"),
		location: z.union([z.literal("settings"), z.literal("secure")]),
		value: z.string(),
	}),
]);

/**
 * The saveServerSetting payload's shape. Strict, so unknown fields never ride
 * along into the setting; the value constraints (usable URLs, header charset,
 * paired OAuth fields, reserved labels) live in validateSaveServerSetting,
 * whose rules the webview form shares through serverForm.ts.
 */
const saveServerSchema = z.strictObject({
	label: z.string(),
	baseUrl: z.string(),
	oauthTokenUrl: z.string().optional(),
	oauthClientId: z.string().optional(),
	oauthScopes: z.string().optional(),
	virtualKeyHeader: z.string().optional(),
});

const secretDirectivesSchema = z.strictObject({
	apiKey: secretDirectiveSchema,
	oauthClientSecret: secretDirectiveSchema,
	virtualKeyValue: secretDirectiveSchema,
});

const secretLocationChoiceSchema = z.union([z.literal("settings"), z.literal("secure")]);

/** Where each of an adoption's copied secrets should land; never the values themselves. */
const adoptSecretsSchema = z.strictObject({
	apiKey: secretLocationChoiceSchema,
	oauthClientSecret: secretLocationChoiceSchema,
	virtualKeyValue: secretLocationChoiceSchema,
});

/**
 * The schema every message from the webview must pass before anything acts on
 * it: the webview is outside the trust boundary, so its messages are data,
 * not types. Strict objects keep unknown fields from riding along.
 */
export const webviewMessageSchema: z.ZodType<WebviewToExtensionMessage> = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("ready") }),
	z.strictObject({
		type: z.literal("setNumberSetting"),
		setting: asEnum(NUMBER_SETTING_IDS),
		value: z.union([z.number().finite(), z.null()]),
	}),
	z.strictObject({
		type: z.literal("setBooleanSetting"),
		setting: asEnum(BOOLEAN_SETTING_IDS),
		value: z.boolean(),
	}),
	z.strictObject({
		type: z.literal("setModelParameters"),
		value: z.record(z.string(), z.record(z.string(), z.unknown())),
	}),
	z.strictObject({
		type: z.literal("setHeaders"),
		value: z.record(z.string(), headerScalarSchema),
	}),
	z.strictObject({
		type: z.literal("saveServerSetting"),
		server: saveServerSchema,
		secrets: secretDirectivesSchema,
		replaceLabel: z.string().optional(),
		requestId: z.string().min(1).max(128),
	}),
	z.strictObject({ type: z.literal("removeServerSetting"), label: z.string(), requestId: z.string().min(1).max(128) }),
	z.strictObject({
		type: z.literal("adoptServer"),
		label: z.string(),
		baseUrl: z.string(),
		sourceHandle: z.string().min(1).max(128),
		secrets: adoptSecretsSchema,
		requestId: z.string().min(1).max(128),
	}),
	z.strictObject({ type: z.literal("executeCommand"), command: asEnum(DASHBOARD_COMMAND_IDS) }),
]);

/** A schema-valid intent that asks the extension to do something (everything but the ready handshake). */
export type DashboardIntent = Extract<WebviewToExtensionMessage, { type: DashboardIntentType }>;

/**
 * A constraint violation detected by this module's own validation. Its
 * message may travel to the webview verbatim so the user sees which rule
 * failed, but never to the log: some messages quote an entered key (a header
 * name, a modelParameters prefix), the entered text can be anything the user
 * pasted, and the log buffer feeds public issue reports. The panel boundary
 * logs a classification only.
 */
export class DashboardValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DashboardValidationError";
	}
}

/**
 * An intent that partially applied: the durable write landed but a follow-up
 * effect the user asked for did not, so the intent must report failure with an
 * accurate way forward. Like DashboardValidationError, the message is written
 * to be safe for the webview (actionable, never a value) and the panel
 * boundary logs a classification only.
 */
export class DashboardOperationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DashboardOperationError";
	}
}

/** The effects an intent can have; injected so intents are testable without vscode. */
export interface IntentEnvironment {
	/** Write one litellm-vscode-chat.* setting (the key is relative to the section). */
	updateSetting(key: string, value: unknown): Promise<void>;
	executeCommand(command: string, ...args: readonly unknown[]): Thenable<unknown>;
	/** The servers array a write would replace (the user-scope value; the setting is machine-scoped). */
	readServersSetting(): unknown;
	writeServersSetting(value: readonly unknown[]): Promise<void>;
	/** Write one secure-side secret field for a label; undefined deletes it. The value must never be logged. */
	storeServerSecret(label: string, field: SecretFieldId, value: string | undefined): Promise<void>;
	/** A label's secure-side blob; read for pairing validation and write rollback, never logged. */
	readServerSecrets(label: string): Promise<Partial<Readonly<Record<SecretFieldId, string>>>>;
	/** Copy a label's secure-side secrets to a new name (the additive half of a rename). */
	copyServerSecrets(fromLabel: string, toLabel: string): Promise<void>;
	/** Delete a label's whole secure-side blob (the cleanup half of a rename). */
	deleteServerSecrets(label: string): Promise<void>;
	/** Ask the sync engine for a pass; secure-only changes fire no configuration event. */
	requestServerSync(): void;
	/**
	 * The live credentials of the external group an adopt intent names by its
	 * opaque row handle, from the provider's in-memory status window. Resolves
	 * only groups that are still external and still at `baseUrl` (see
	 * resolveAdoptableCredentials). The returned values go straight into the
	 * setting or SecretStorage and are never logged.
	 */
	resolveAdoptionCredentials(baseUrl: string, sourceHandle: string): AdoptableGroupCredentials | undefined;
	/** Classification-only logging (the buffer feeds public issue reports); never a payload value. */
	log(message: string, data?: unknown): void;
}

const COMMANDS_BY_ID: Record<DashboardCommandId, { command: string; args: readonly unknown[] }> = {
	manageServers: { command: "litellm.manageServers", args: [] },
	syncModels: { command: "litellm.syncModels", args: [] },
	testConnection: { command: "litellm.testConnection", args: [] },
	showDiagnostics: { command: "litellm.showDiagnostics", args: [] },
	openSettings: { command: "workbench.action.openSettings", args: [EXTENSION_SETTINGS_FILTER] },
};

/**
 * Value constraints the message schema cannot express. Returns the reason a
 * number is not writable, or undefined when it is.
 */
export function validateNumberSetting(setting: NumberSettingId, value: number | null): string | undefined {
	const spec = NUMBER_SETTINGS[setting];
	if (value === null) {
		return spec.nullable ? undefined : `${setting} requires a number`;
	}
	if (value < spec.minimum) {
		return `${setting} must be at least ${spec.minimum}`;
	}
	return undefined;
}

/**
 * Header-record parity with the request path (shared/settings silently drops
 * offenders at request time): names must be RFC 9110 tokens and values must
 * not carry line breaks, so an accepted write is a header that is actually
 * sent. Also refuses prototype-polluting keys, mirroring the editors'
 * validation for messages that bypassed them.
 */
export function validateHeadersRecord(value: Readonly<Record<string, HeaderScalar>>): string | undefined {
	for (const [name, headerValue] of Object.entries(value)) {
		if (isUnsafeRecordKey(name)) {
			return `"${name}" is a reserved name and cannot be used as a header name`;
		}
		if (!isValidHeaderName(name)) {
			return `"${name}" is not a valid HTTP header name`;
		}
		const text = String(headerValue);
		if (text.includes("\r") || text.includes("\n")) {
			return `The value of header "${name}" contains line breaks`;
		}
	}
	return undefined;
}

/** Refuse prototype-polluting keys anywhere in a modelParameters record. */
export function validateModelParametersRecord(
	value: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): string | undefined {
	for (const [prefix, params] of Object.entries(value)) {
		if (isUnsafeRecordKey(prefix)) {
			return `"${prefix}" is a reserved name and cannot be used as a model prefix`;
		}
		for (const key of Object.keys(params)) {
			if (isUnsafeRecordKey(key)) {
				return `"${key}" is a reserved name and cannot be used as a parameter name`;
			}
		}
	}
	return undefined;
}

/**
 * The value constraints on a saveServerSetting intent, mirroring the webview
 * form's field-level rules (serverForm.ts) for messages that bypassed it.
 * Cross-field pairing (OAuth's token URL and client ID, the virtual key's
 * header and value) is enforced in applySaveServerSetting, where the resolved
 * secrets context exists. Returns the reason the intent is not applicable, or
 * undefined when it is. Reasons name fields, never values: payloads carry
 * secrets, and the message is echoed to the webview.
 */
export function validateSaveServerSetting(
	server: SaveServerPayload,
	secrets: Readonly<Record<SecretFieldId, SecretDirective>>
): string | undefined {
	const label = server.label.trim();
	if (label.length === 0) {
		return "label: enter a label";
	}
	if (isUnsafeRecordKey(label)) {
		return "label: reserved name";
	}
	const baseUrl = server.baseUrl.trim();
	if (baseUrl.length === 0) {
		return "baseUrl: enter the server URL";
	}
	if (!isUsableHttpUrl(baseUrl)) {
		return "baseUrl: not a usable http(s) URL";
	}
	// Empty-string optionals count as absent: the merge omits them from the
	// written entry, so only fields with content need to be usable.
	const tokenUrl = server.oauthTokenUrl?.trim();
	if (tokenUrl !== undefined && tokenUrl.length > 0 && !isUsableHttpUrl(tokenUrl)) {
		return "oauthTokenUrl: not a usable http(s) URL";
	}
	const header = server.virtualKeyHeader?.trim();
	if (header !== undefined && header.length > 0 && !isValidHeaderName(header)) {
		return "virtualKeyHeader: not a valid HTTP header name";
	}
	for (const field of SECRET_FIELD_IDS) {
		const directive = secrets[field];
		if (directive.action === "set" && directive.value.length === 0) {
			return `${field}: an empty value cannot be set; use clear`;
		}
	}
	const virtualKeyDirective = secrets.virtualKeyValue;
	if (virtualKeyDirective.action === "set" && !isValidHeaderValue(virtualKeyDirective.value)) {
		return "virtualKeyValue: the value cannot be sent as an HTTP header";
	}
	return undefined;
}

/**
 * The servers-setting array as a mutable copy, entries preserved verbatim:
 * junk siblings (non-objects, entries without labels) must survive a rewrite
 * untouched so a save never deletes what the user typed by hand. Non-arrays
 * read as empty so a save can still land.
 */
function rawServerEntries(raw: unknown): unknown[] {
	return Array.isArray(raw) ? [...raw] : [];
}

function isEntryRecord(entry: unknown): entry is Record<string, unknown> {
	return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

/**
 * Whether a raw entry carries this label. Compared trimmed on both sides:
 * parseServersSetting trims labels, so a hand-written `" Prod "` entry
 * displays as "Prod" and its edits and removals must find it again.
 */
function entryHasLabel(entry: unknown, label: string): entry is Record<string, unknown> {
	return isEntryRecord(entry) && typeof entry.label === "string" && entry.label.trim() === label.trim();
}

function findEntryIndex(entries: readonly unknown[], label: string): number {
	return entries.findIndex((entry) => entryHasLabel(entry, label));
}

/**
 * Apply one saveServerSetting intent in a failure-safe order: validate
 * everything up front, then run the additive secret operations (set-secure
 * writes; a rename copies the blob to the new label) and the settings write as
 * one guarded unit, and only after the write lands run the destructive cleanup
 * (clears, dropping the stale secure copy behind an inline write, deleting the
 * old rename blob).
 *
 * If anything in the guarded unit throws, the entry in the setting is
 * unchanged and must keep resolving what it resolved before, so the secure
 * side is rolled back: a rename restores the new label's whole pre-copy blob
 * (which also revives an orphan blob the copy overwrote), otherwise each
 * overwritten field gets its previous value back. When any restore itself
 * fails, the durable state changed after all (a fresh secret survived the
 * rollback), so the intent fails as an operation-kind error instead of
 * rethrowing the original as if nothing landed.
 *
 * Cleanup failures after a landed write depend on what the failure leaves
 * behind. A cleared secret that survives its deletion is still effective (the
 * saved entry carries no inline value to outrank it), so after one retry the
 * intent fails with an actionable message; retrying the save converges, the
 * clear directive re-runs the delete. The stale secure copy behind a fresh
 * inline value and the old rename blob are dormant, so those failures log a
 * classification and the intent still succeeds.
 */
async function applySaveServerSetting(
	intent: Extract<DashboardIntent, { type: "saveServerSetting" }>,
	env: IntentEnvironment
): Promise<void> {
	const label = intent.server.label.trim();
	// Trimmed like entry matching trims, so the secret-store operations below
	// hit the same label the entry lookup resolves.
	const targetLabel = (intent.replaceLabel ?? label).trim();
	const entries = rawServerEntries(env.readServersSetting());
	const existingIndex = findEntryIndex(entries, targetLabel);
	if (intent.replaceLabel !== undefined && existingIndex < 0) {
		throw new DashboardValidationError(
			"The entry being edited no longer exists in the servers setting; close the form and retry"
		);
	}
	const renaming = targetLabel !== label;
	if (renaming && findEntryIndex(entries, label) >= 0) {
		throw new DashboardValidationError("label: an entry with this label already exists");
	}
	const existing = existingIndex >= 0 ? (entries[existingIndex] as Record<string, unknown>) : undefined;

	// The final entry's non-secret fields, needed for the pairing checks below.
	const newEntry: Record<string, string> = { label, baseUrl: intent.server.baseUrl.trim() };
	const optional = ["oauthTokenUrl", "oauthClientId", "oauthScopes", "virtualKeyHeader"] as const;
	for (const field of optional) {
		const value = intent.server[field]?.trim();
		if (value !== undefined && value.length > 0) {
			newEntry[field] = value;
		}
	}

	// What the sync engine will read for this entry's label after the save: a
	// rename copies the old label's whole blob over the new label's, but only
	// when the old blob is non-empty, so an orphan blob already sitting under
	// the new label otherwise keeps serving and must satisfy pairing too.
	const storedOld = await env.readServerSecrets(targetLabel);
	const storedNew = renaming ? await env.readServerSecrets(label) : storedOld;
	const storedEffective = renaming && Object.keys(storedOld).length > 0 ? storedOld : storedNew;

	/** Whether a secret field will hold a value once the directives are applied. */
	const willResolve = (field: SecretFieldId): boolean => {
		const directive = intent.secrets[field];
		if (directive.action === "set") {
			return true;
		}
		if (directive.action === "clear") {
			return false;
		}
		const inline = existing?.[field];
		if (typeof inline === "string" && inline.length > 0) {
			return true;
		}
		return storedEffective[field] !== undefined;
	};

	// OAuth is one unit, mirroring serverForm's exact rules: the request path
	// drops partial configurations silently, so anything OAuth-shaped (a token
	// URL, a client ID, scopes, or a client secret that would resolve) requires
	// the token URL and client ID pair.
	const oauthExtras = willResolve("oauthClientSecret") || newEntry.oauthScopes !== undefined;
	if ((newEntry.oauthClientId !== undefined || oauthExtras) && newEntry.oauthTokenUrl === undefined) {
		throw new DashboardValidationError("oauthTokenUrl: OAuth needs the token URL and client ID");
	}
	if ((newEntry.oauthTokenUrl !== undefined || oauthExtras) && newEntry.oauthClientId === undefined) {
		throw new DashboardValidationError("oauthClientId: OAuth needs the token URL and client ID");
	}

	// The virtual key pair is both-or-neither, like the form enforces.
	const virtualKeyResolves = willResolve("virtualKeyValue");
	if (newEntry.virtualKeyHeader !== undefined && !virtualKeyResolves) {
		throw new DashboardValidationError("virtualKeyValue: enter the key sent in this header");
	}
	if (newEntry.virtualKeyHeader === undefined && virtualKeyResolves) {
		throw new DashboardValidationError("virtualKeyHeader: name the header that carries the key");
	}

	// Phases 1 and 2 as one guarded unit: the additive secret operations (a
	// rename's blob copy, set-secure writes), then the settings write
	// everything hinges on. Secure values the additive steps overwrite are
	// remembered (pre-write state) for the rollback.
	const copied = renaming && Object.keys(storedOld).length > 0;
	const overwritten = new Map<SecretFieldId, string | undefined>();
	try {
		if (renaming) {
			await env.copyServerSecrets(targetLabel, label);
		}
		const inline: Record<string, string> = {};
		for (const field of SECRET_FIELD_IDS) {
			const directive = intent.secrets[field];
			switch (directive.action) {
				case "keep": {
					const kept = existing?.[field];
					if (typeof kept === "string" && kept.length > 0) {
						inline[field] = kept;
					}
					break;
				}
				case "clear":
					break;
				case "set":
					if (directive.location === "secure") {
						overwritten.set(field, storedNew[field]);
						await env.storeServerSecret(label, field, directive.value);
					} else {
						inline[field] = directive.value;
					}
					break;
			}
		}
		Object.assign(newEntry, inline);
		const next = [...entries];
		if (existingIndex >= 0) {
			next[existingIndex] = newEntry;
		} else {
			next.push(newEntry);
		}
		await env.writeServersSetting(next);
	} catch (error) {
		// The setting still resolves what it resolved before, so the secure side
		// must too. A rename's copy replaced the new label's whole blob, so that
		// blob is restored wholesale to its pre-copy state (deleting fields it
		// never held), which also undoes any set-secure write on top of the
		// copy; otherwise only the overwritten fields are touched.
		const restores: [SecretFieldId, string | undefined][] = copied
			? SECRET_FIELD_IDS.map((field) => [field, storedNew[field]])
			: [...overwritten];
		let restoreFailed = false;
		for (const [field, previous] of restores) {
			try {
				await env.storeServerSecret(label, field, previous);
			} catch {
				restoreFailed = true;
				env.log("Restoring a secure value after a failed save also failed", { field });
			}
		}
		if (restoreFailed) {
			// The durable state DID change: a freshly stored secret survived the
			// rollback and now resolves for the unchanged entry, so this must not
			// surface as "nothing landed" (which would reopen the form as if the
			// draft were still the truth). The original error's name is logged as
			// a classification before it is replaced. A sync is requested too: the
			// failed settings write fires no configuration event, and the changed
			// secure value must reach the provider group (the clean-rollback
			// rethrow below stays sync-free, nothing durable changed there).
			env.log("A failed save left a secure value unrestored", {
				error: error instanceof Error ? error.name : typeof error,
			});
			env.requestServerSync();
			throw new DashboardOperationError(
				"The save failed, and restoring a stored secret to its previous value also failed. Check the secret with LiteLLM: Set Server Secret."
			);
		}
		throw error;
	}

	// Phase 3, destructive cleanup, safe now that the write landed. What a
	// failure leaves behind decides the outcome: a cleared secret that survives
	// its deletion is still effective (the saved entry carries nothing inline
	// to outrank it), so the delete retries once and a second failure fails the
	// intent below; the stale secure copy behind a fresh inline value (a
	// lingering one would silently take over if the inline value were later
	// removed by hand) and the old rename blob are dormant, so their failures
	// are log-only.
	let clearFailed = false;
	for (const field of SECRET_FIELD_IDS) {
		const directive = intent.secrets[field];
		if (directive.action === "clear") {
			try {
				await env.storeServerSecret(label, field, undefined);
			} catch {
				try {
					await env.storeServerSecret(label, field, undefined);
				} catch {
					clearFailed = true;
					env.log("Removing a cleared secret failed; the stored value is still in effect", { field });
				}
			}
		} else if (directive.action === "set" && directive.location === "settings") {
			try {
				await env.storeServerSecret(label, field, undefined);
			} catch {
				env.log("Post-save secret cleanup failed; a dormant secure copy remains", { field });
			}
		}
	}
	if (renaming) {
		try {
			await env.deleteServerSecrets(targetLabel);
		} catch {
			env.log("Post-rename secret cleanup failed; the old label's blob remains");
		}
	}
	env.requestServerSync();
	if (clearFailed) {
		throw new DashboardOperationError(
			"The server entry was saved, but removing the stored secret failed. Edit the server and retry, or use LiteLLM: Set Server Secret to remove it."
		);
	}
}

/**
 * Apply one adoptServer intent: write the external group's configuration as a
 * new declared entry, with each resolved secret stored where the user chose.
 * The webview only ever names the group (by the opaque handle its row carried)
 * and the storage locations; the values come from the provider's in-memory
 * lookup here, extension-side, and only for a group that is still external. A
 * missing lookup (the group refreshed away, became declared, or the row was a
 * registry server) still writes the plain entry and reports the caveat through
 * the returned notice, because the user asked for the entry either way.
 *
 * Failure ordering mirrors applySaveServerSetting's guarded unit: additive
 * secure writes first, then the settings write; if the write fails, secure
 * values overwritten under this label are restored so the (absent) entry
 * resolves nothing new.
 */
async function applyAdoptServer(
	intent: Extract<DashboardIntent, { type: "adoptServer" }>,
	env: IntentEnvironment
): Promise<string | undefined> {
	const label = intent.label.trim();
	if (label.length === 0) {
		throw new DashboardValidationError("label: enter a label");
	}
	if (isUnsafeRecordKey(label)) {
		throw new DashboardValidationError("label: reserved name");
	}
	const baseUrl = intent.baseUrl.trim();
	if (baseUrl.length === 0 || !isUsableHttpUrl(baseUrl)) {
		throw new DashboardValidationError("baseUrl: not a usable http(s) URL");
	}
	const entries = rawServerEntries(env.readServersSetting());
	if (findEntryIndex(entries, label) >= 0) {
		throw new DashboardValidationError("label: an entry with this label already exists");
	}

	const credentials = env.resolveAdoptionCredentials(baseUrl, intent.sourceHandle);
	const newEntry: Record<string, string> = { label, baseUrl };
	const nonSecret = ["oauthTokenUrl", "oauthClientId", "oauthScopes", "virtualKeyHeader"] as const;
	for (const field of nonSecret) {
		const value = credentials?.[field];
		if (value !== undefined) {
			newEntry[field] = value;
		}
	}

	const storedBefore = await env.readServerSecrets(label);
	const overwritten = new Map<SecretFieldId, string | undefined>();
	try {
		for (const field of SECRET_FIELD_IDS) {
			const value = credentials?.[field];
			if (value === undefined) {
				continue;
			}
			if (intent.secrets[field] === "secure") {
				overwritten.set(field, storedBefore[field]);
				await env.storeServerSecret(label, field, value);
			} else {
				newEntry[field] = value;
			}
		}
		await env.writeServersSetting([...entries, newEntry]);
	} catch (error) {
		let restoreFailed = false;
		for (const [field, previous] of overwritten) {
			try {
				await env.storeServerSecret(label, field, previous);
			} catch {
				restoreFailed = true;
				env.log("Restoring a secure value after a failed adoption also failed", { field });
			}
		}
		if (restoreFailed) {
			// A copied secret survived the rollback under this label; see the
			// save path's matching case for why this must not read as "nothing
			// landed".
			env.log("A failed adoption left a secure value unrestored", {
				error: error instanceof Error ? error.name : typeof error,
			});
			env.requestServerSync();
			throw new DashboardOperationError(
				// Not "Set Server Secret": that command lists declared entries
				// only, and this label's entry never landed. Re-adding the label
				// makes the entry editable, and the edit form's remove checkbox
				// is what clears the leftover blob field.
				"The adoption failed, and removing a copied secret again also failed. Re-add a server under this label with the dashboard form, then edit the entry to remove the leftover secret."
			);
		}
		throw error;
	}
	// The label is new to the setting, but a secure blob can survive under it
	// (removals keep blobs so re-adding a label picks its secrets back up).
	// For adoption that inheritance is wrong - the entry must resolve exactly
	// what was copied from the group - so stale fields the adoption did not
	// itself write secure-side are removed now that the write landed, and the
	// removal is verified by re-reading: a stale secret that survives would
	// silently take effect wherever the entry carries no inline copy, so a
	// failure has to reach the user through the success notice, not just the
	// log.
	const staleFields = SECRET_FIELD_IDS.filter((field) => storedBefore[field] !== undefined && !overwritten.has(field));
	let staleRemaining: SecretFieldId[] = [];
	if (staleFields.length > 0) {
		for (const field of staleFields) {
			try {
				await env.storeServerSecret(label, field, undefined);
			} catch {
				// Counted by the verification below.
			}
		}
		try {
			const after = await env.readServerSecrets(label);
			staleRemaining = staleFields.filter((field) => after[field] !== undefined);
		} catch {
			// Unverifiable counts as failed: the caveat must err toward warning.
			staleRemaining = staleFields;
		}
		if (staleRemaining.length > 0) {
			env.log("Post-adoption cleanup of stale stored secrets failed", { fields: staleRemaining });
		}
	}
	env.requestServerSync();
	const caveats: string[] = [];
	if (credentials === undefined) {
		caveats.push("The live group's credentials could not be read, so none were copied; edit the server to set them.");
	}
	if (staleRemaining.length > 0) {
		const names = staleRemaining.map((field) => SERVER_FORM_FIELD_LABELS[field]).join(", ");
		caveats.push(
			`A previously stored secret under this label (${names}) could not be cleared and may take effect; clear or replace it by editing the server or with LiteLLM: Set Server Secret.`
		);
	}
	return caveats.length > 0 ? caveats.join(" ") : undefined;
}

/**
 * Execute one validated intent against the injected environment. Resolves to
 * an optional user-facing caveat for the success notice (only adoptServer
 * produces one today). Throws on constraint violations without logging; the
 * panel controller is the boundary that logs and reports the failure back to
 * the webview.
 */
export async function executeDashboardIntent(
	intent: DashboardIntent,
	env: IntentEnvironment
): Promise<string | undefined> {
	switch (intent.type) {
		case "setNumberSetting": {
			const problem = validateNumberSetting(intent.setting, intent.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting(intent.setting, intent.value);
			return undefined;
		}
		case "setBooleanSetting":
			await env.updateSetting(intent.setting, intent.value);
			return undefined;
		case "setModelParameters": {
			const problem = validateModelParametersRecord(intent.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting("modelParameters", intent.value);
			return undefined;
		}
		case "setHeaders": {
			const problem = validateHeadersRecord(intent.value);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await env.updateSetting("headers", intent.value);
			return undefined;
		}
		case "saveServerSetting": {
			const problem = validateSaveServerSetting(intent.server, intent.secrets);
			if (problem !== undefined) {
				throw new DashboardValidationError(problem);
			}
			await applySaveServerSetting(intent, env);
			return undefined;
		}
		case "removeServerSetting": {
			const entries = rawServerEntries(env.readServersSetting());
			const next = entries.filter((entry) => !entryHasLabel(entry, intent.label));
			if (next.length === entries.length) {
				throw new DashboardValidationError(
					"No servers setting entry has this label; the server is managed outside the setting"
				);
			}
			// The label's secure-side secrets are kept on purpose: re-adding the
			// label picks them up again, and the provider group itself survives
			// anyway (VS Code offers no programmatic group removal).
			await env.writeServersSetting(next);
			env.requestServerSync();
			return undefined;
		}
		case "adoptServer":
			return applyAdoptServer(intent, env);
		case "executeCommand": {
			const { command, args } = COMMANDS_BY_ID[intent.command];
			await env.executeCommand(command, ...args);
			return undefined;
		}
	}
}
