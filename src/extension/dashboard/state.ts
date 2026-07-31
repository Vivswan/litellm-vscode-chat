/**
 * The dashboard's state bridge: pure builders that reduce the existing stores
 * (the provider's status window, workspace configuration) to the serializable
 * DashboardState, plus the settings readers those builders share.
 *
 * Everything here takes its inputs as plain values or thin injected adapters,
 * so the whole module is unit-testable without a webview or a real
 * configuration store. panel.ts owns the vscode wiring; intent validation and
 * execution live in intents.ts.
 */

import { z } from "zod";
import type { ServerModelsSnapshot } from "../../provider";
import type { PreAttachModelInfo } from "../../provider/catalog/groupModels";
import { modelSupportsPromptCaching } from "../../provider/catalog/groupModels";
import { normalizeBaseUrl } from "../../shared/baseUrl";
import { isHeaderScalar } from "../../shared/headers";
import { isUnsafeRecordKey, recordFromKeys } from "../../shared/json";
import { pickNonSecretOptionalFields } from "../../shared/serverEntry";
import type { ServerStatus } from "../../shared/servers";
import { HEADERS_SETTING_KEY, MODEL_PARAMETERS_SETTING_KEY, normalizeModelParameters } from "../../shared/settings";
import type { DeclaredServerView } from "../serverSync";
import { adoptSourceHandle } from "./adoptHandle";
import type {
	BooleanSettingId,
	DashboardModel,
	DashboardServer,
	DashboardSettings,
	DashboardState,
	HeaderScalar,
	NumberSettingId,
	ScopedRecordSetting,
	SettingScope,
} from "./protocol";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS, NUMBER_SETTINGS } from "./protocol";

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
interface LabeledSnapshot {
	readonly snapshot: ServerModelsSnapshot;
	readonly label: string;
}

export function labeledSnapshots(snapshots: readonly ServerModelsSnapshot[]): LabeledSnapshot[] {
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

function buildServer(snapshot: ServerModelsSnapshot, label: string): DashboardServer {
	const { status } = snapshot;
	const base = {
		label,
		baseUrl: status.baseUrl,
		lastChecked: status.lastChecked,
		hasApiKey: status.hasApiKey === true,
		hasOAuth: false,
		origin: "external",
		adoptHandle: adoptSourceHandle(status.serverId),
	} as const;
	return status.state === "ok"
		? { ...base, state: "ok", modelCount: status.modelCount }
		: { ...base, state: "error", modelCount: 0, error: status.error };
}

/**
 * Pair declared entries with live snapshots. Declared entries pair by the
 * group client ID first (the sync engine computes the same
 * credential-fingerprinted identity the provider stamps on its snapshots, so
 * entries sharing a base URL with different credentials join exactly), then
 * by the label-agnostic connection ID - non-exclusively, because groups
 * created before entry labels flowed into their configurations report under
 * one shared identity, and every declared entry mirroring that connection is
 * honestly described by its snapshot (shared real status beats "not
 * checked") - then by label plus base URL, then by base URL alone for
 * entries the engine has not resolved yet. Shared by the state builder and
 * the adopt intent's source resolution, which must agree on which snapshots
 * are external.
 */
export function joinDeclared(
	labeled: readonly LabeledSnapshot[],
	declared: readonly DeclaredServerView[]
): {
	/** The labeled snapshot each declared entry matched, by declared index. */
	matchedByDeclared: Map<number, LabeledSnapshot>;
	/** Labeled snapshots no declared entry claimed: the external rows. */
	unmatched: Set<LabeledSnapshot>;
} {
	const unmatched = new Set<LabeledSnapshot>(labeled);
	const matchedByDeclared = new Map<number, LabeledSnapshot>();
	const passes: readonly {
		match: (snapshot: ServerModelsSnapshot, view: DeclaredServerView) => boolean;
		/** A shared pass lets several entries claim one snapshot; only equal join keys can collide (see the doc above). */
		shared?: boolean;
	}[] = [
		{
			match: (snapshot, view) =>
				view.expectedClientId !== undefined && snapshot.status.serverId === view.expectedClientId,
		},
		{
			match: (snapshot, view) =>
				view.expectedConnectionId !== undefined && snapshot.status.serverId === view.expectedConnectionId,
			shared: true,
		},
		{
			match: (snapshot, view) =>
				snapshot.status.label === view.label &&
				normalizeBaseUrl(snapshot.status.baseUrl) === normalizeBaseUrl(view.baseUrl),
		},
		{ match: (snapshot, view) => normalizeBaseUrl(snapshot.status.baseUrl) === normalizeBaseUrl(view.baseUrl) },
	];
	for (const pass of passes) {
		// Snapshots this pass already handed out, still claimable when shared.
		const claimed = new Set<LabeledSnapshot>();
		declared.forEach((view, declaredIndex) => {
			if (matchedByDeclared.has(declaredIndex)) {
				return;
			}
			const pool = pass.shared === true ? [...unmatched, ...claimed] : [...unmatched];
			const found = pool.find((entry) => pass.match(entry.snapshot, view));
			if (found !== undefined) {
				matchedByDeclared.set(declaredIndex, found);
				claimed.add(found);
				unmatched.delete(found);
			}
		});
	}
	return { matchedByDeclared, unmatched };
}

/**
 * The state slice of a declared row. The sync error always rides the row's
 * error (a live status's own error cannot mask it): the group still serving
 * is the entry's OLD configuration, and the remove-and-resync instruction
 * must show. A reachable group keeps its live state, though - the surfaces
 * render the error text alongside the live facts (diagnostics'
 * serverOutcomeText, the dashboard's per-server error list).
 */
function declaredOutcome(
	status: ServerStatus | undefined,
	syncError: string | undefined
):
	| { state: "ok"; modelCount: number; error?: string | undefined }
	| { state: "error"; modelCount: number; error: string }
	| { state: "unchecked"; modelCount: number } {
	if (status?.state === "ok") {
		return { state: "ok", modelCount: status.modelCount, error: syncError };
	}
	if (status?.state === "error") {
		return { state: "error", modelCount: 0, error: syncError ?? status.error };
	}
	return syncError !== undefined
		? { state: "error", modelCount: 0, error: syncError }
		: { state: "unchecked", modelCount: 0 };
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
	labeled: readonly LabeledSnapshot[],
	declared: readonly DeclaredServerView[]
): { servers: DashboardServer[]; snapshotLabels: string[] } {
	const { matchedByDeclared, unmatched } = joinDeclared(labeled, declared);
	const displayLabels = new Map<LabeledSnapshot, string>(labeled.map((entry) => [entry, entry.label]));
	// A snapshot shared by several declared entries renders its models once,
	// under the first claimant's label (declared order, deterministic).
	const relabeled = new Set<LabeledSnapshot>();
	const servers: DashboardServer[] = [];
	declared.forEach((view, declaredIndex) => {
		const matched = matchedByDeclared.get(declaredIndex);
		if (matched !== undefined && !relabeled.has(matched)) {
			relabeled.add(matched);
			displayLabels.set(matched, view.label);
		}
		servers.push({
			label: view.label,
			baseUrl: view.baseUrl,
			lastChecked: matched?.snapshot.status.lastChecked,
			hasApiKey: matched?.snapshot.status.hasApiKey === true || view.secrets.apiKey !== "none",
			hasOAuth: view.oauthTokenUrl !== undefined && view.oauthClientId !== undefined,
			origin: "declared",
			config: {
				...pickNonSecretOptionalFields(view),
				secrets: view.secrets,
				...(view.modelParameters !== undefined ? { modelParameters: view.modelParameters } : {}),
			},
			...declaredOutcome(matched?.snapshot.status, view.syncError),
		});
	});
	for (const entry of unmatched) {
		servers.push(buildServer(entry.snapshot, entry.label));
	}
	servers.sort((a, b) => a.label.localeCompare(b.label) || a.baseUrl.localeCompare(b.baseUrl));
	return { servers, snapshotLabels: labeled.map((entry) => displayLabels.get(entry) ?? entry.label) };
}

function buildModel(info: PreAttachModelInfo, serverLabel: string): DashboardModel {
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
	return readNumberDefault(reader, id);
}

function readBooleanSetting(reader: SettingsReader, id: BooleanSettingId): boolean {
	const raw = reader.get(id);
	if (typeof raw === "boolean") {
		return raw;
	}
	return readBooleanDefault(reader, id);
}

/**
 * The package.json default of a number setting, the display fallback when the
 * configured value is unusable (readNumberSetting): the form still renders a
 * real value. Falls back further to the spec's own floor when even the
 * inspected default is unusable.
 */
function readNumberDefault(reader: SettingsReader, id: NumberSettingId): number | null {
	const spec = NUMBER_SETTINGS[id];
	const fallback = reader.inspect(id)?.defaultValue;
	if (typeof fallback === "number" && Number.isFinite(fallback)) {
		return fallback;
	}
	return spec.nullable ? null : spec.minimum;
}

function readBooleanDefault(reader: SettingsReader, id: BooleanSettingId): boolean {
	const fallback = reader.inspect(id)?.defaultValue;
	return typeof fallback === "boolean" ? fallback : false;
}

/**
 * The highest-precedence scope that explicitly configures a key, or null when
 * only the default applies. Precedence follows VS Code's own merge order
 * (workspaceFolder over workspace over global). This is what "modified" means
 * in the dashboard form, and the scope a reset removes first: repeated resets
 * walk down the scopes until nothing is configured, like resetting the setting
 * in each of the native Settings editor's scope tabs in turn.
 */
export function resolveConfiguredScope(inspection: SettingsInspection | undefined): SettingScope | null {
	if (inspection?.workspaceFolderValue !== undefined) {
		return "workspaceFolder";
	}
	if (inspection?.workspaceValue !== undefined) {
		return "workspace";
	}
	if (inspection?.globalValue !== undefined) {
		return "global";
	}
	return null;
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
		if (isHeaderScalar(value)) {
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
	return {
		numbers: recordFromKeys(NUMBER_SETTING_IDS, (id) => readNumberSetting(reader, id)),
		booleans: recordFromKeys(BOOLEAN_SETTING_IDS, (id) => readBooleanSetting(reader, id)),
		configuredScopes: {
			numbers: recordFromKeys(NUMBER_SETTING_IDS, (id) => resolveConfiguredScope(reader.inspect(id))),
			booleans: recordFromKeys(BOOLEAN_SETTING_IDS, (id) => resolveConfiguredScope(reader.inspect(id))),
		},
		modelParameters: buildScopedRecord(reader.inspect(MODEL_PARAMETERS_SETTING_KEY), normalizeModelParameters),
		headers: buildScopedRecord(reader.inspect(HEADERS_SETTING_KEY), sanitizeHeaders),
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
