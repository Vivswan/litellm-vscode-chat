/**
 * The dashboard's state bridge: pure builders that reduce the existing stores
 * (the provider's status window, workspace configuration) to the serializable
 * DashboardState, and the validation plus execution of webview intents.
 *
 * Everything here takes its inputs as plain values or thin injected adapters,
 * so the whole module is unit-testable without a webview or a real
 * configuration store. panel.ts owns the vscode wiring.
 */

import { z } from "zod";
import type { ServerModelsSnapshot } from "../../provider";
import type { LiteLLMModelInfo } from "../../provider/groupModels";
import { modelSupportsPromptCaching } from "../../provider/groupModels";
import { isValidHeaderName } from "../../shared/headers";
import { isUnsafeRecordKey } from "../../shared/json";
import { normalizeModelParameters } from "../../shared/settings";
import { EXTENSION_SETTINGS_FILTER } from "../serverManagement";
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
	ScopedRecordSetting,
	SettingScope,
	WebviewToExtensionMessage,
} from "./protocol";
import { BOOLEAN_SETTING_IDS, DASHBOARD_COMMAND_IDS, NUMBER_SETTING_IDS, NUMBER_SETTINGS } from "./protocol";

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
	const sorted = [...snapshots].sort(
		(a, b) => a.status.label.localeCompare(b.status.label) || a.status.baseUrl.localeCompare(b.status.baseUrl)
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
	return {
		label,
		baseUrl: status.baseUrl,
		state: status.state,
		modelCount: status.modelCount,
		error: status.error,
		lastChecked: status.lastChecked,
		hasApiKey: status.hasApiKey === true,
	};
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
	reader: SettingsReader
): DashboardState {
	const labeled = labeledSnapshots(snapshots);
	return {
		servers: labeled.map(({ snapshot, label }) => buildServer(snapshot, label)),
		models: labeled
			.flatMap(({ snapshot, label }) => snapshot.models.map((info) => buildModel(info, label)))
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

const headerScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

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
	z.strictObject({ type: z.literal("executeCommand"), command: asEnum(DASHBOARD_COMMAND_IDS) }),
]);

/** A schema-valid intent that asks the extension to do something (everything but the ready handshake). */
export type DashboardIntent = Extract<WebviewToExtensionMessage, { type: DashboardIntentType }>;

/** The two effects an intent can have; injected so intents are testable without vscode. */
export interface IntentEnvironment {
	/** Write one litellm-vscode-chat.* setting (the key is relative to the section). */
	updateSetting(key: string, value: unknown): Promise<void>;
	executeCommand(command: string, ...args: readonly unknown[]): Thenable<unknown>;
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
 * Execute one validated intent against the injected environment. Throws on
 * constraint violations without logging; the panel controller is the boundary
 * that logs and reports the failure back to the webview.
 */
export async function executeDashboardIntent(intent: DashboardIntent, env: IntentEnvironment): Promise<void> {
	switch (intent.type) {
		case "setNumberSetting": {
			const problem = validateNumberSetting(intent.setting, intent.value);
			if (problem !== undefined) {
				throw new Error(problem);
			}
			await env.updateSetting(intent.setting, intent.value);
			return;
		}
		case "setBooleanSetting":
			await env.updateSetting(intent.setting, intent.value);
			return;
		case "setModelParameters": {
			const problem = validateModelParametersRecord(intent.value);
			if (problem !== undefined) {
				throw new Error(problem);
			}
			await env.updateSetting("modelParameters", intent.value);
			return;
		}
		case "setHeaders": {
			const problem = validateHeadersRecord(intent.value);
			if (problem !== undefined) {
				throw new Error(problem);
			}
			await env.updateSetting("headers", intent.value);
			return;
		}
		case "executeCommand": {
			const { command, args } = COMMANDS_BY_ID[intent.command];
			await env.executeCommand(command, ...args);
			return;
		}
	}
}
