import { http, type JsonBodyType } from "msw";
import * as vscode from "vscode";
import type { FingerprintSaltSession, FingerprintSaltState } from "../extension/fingerprintSalt";
import type { MigrationContext } from "../extension/migrations";
import { LiteLLMChatModelProvider, type LiteLLMChatModelProviderOptions } from "../provider";
import { DiscoveryCache } from "../provider/catalog/discoveryCache";
import type { DiscoveredGroupModels } from "../provider/catalog/groupDiscovery";
import type { GroupServer, LiteLLMModelInfo, PreAttachModelInfo } from "../provider/catalog/groupModels";
import { attachGroup, groupClientId } from "../provider/catalog/groupModels";
import { groupIdentity } from "../provider/catalog/statusWindow";
import type { TransportErrorClassification } from "../shared/errorClassification";
import type { FailureCause } from "../shared/failureCause";
import { Logger, markLogSafe, publicErrorText } from "../shared/logger";
import type { ServerStatus } from "../shared/servers";
import { normalizeBaseUrl } from "../shared/util/baseUrl";
import { fixedHeaderValue, type HeaderValue } from "../shared/util/headers";
import { CHAT_COMPLETIONS_URL, discoveryHandlers, mswServer, sseTextResponse, TEST_BASE_URL } from "./mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, expectDefined, makeLogger, toHeaderMap } from "./pureHelpers";

export function fakeFingerprintSaltSession(state: FingerprintSaltState = "durable"): FingerprintSaltSession {
	return { state: () => state, confirmDurable: async () => state };
}

/**
 * Keys present in `sectionValues` are returned as-is (including explicit null); absent keys fall back to the caller's
 * default value and inspect as untouched.
 */
export async function withConfig<T>(
	sectionValues: Record<string, unknown>,
	fn: () => T | Promise<T>
): Promise<Awaited<T>> {
	const originalGetConfiguration = vscode.workspace.getConfiguration;
	vscode.workspace.getConfiguration = ((section?: string, scope?: vscode.ConfigurationScope | null) => {
		if (section === "litellm-vscode-chat") {
			return {
				get: (key: string, defaultValue?: unknown) =>
					Object.hasOwn(sectionValues, key) ? sectionValues[key] : defaultValue,
				inspect: (key: string) =>
					Object.hasOwn(sectionValues, key) ? { key, globalValue: sectionValues[key] } : { key },
			} as unknown as vscode.WorkspaceConfiguration;
		}
		return originalGetConfiguration(section, scope);
	}) as unknown as typeof vscode.workspace.getConfiguration;
	try {
		return await fn();
	} finally {
		vscode.workspace.getConfiguration = originalGetConfiguration;
	}
}

/**
 * The group server makeProvider's injected configuration resolves to, mirroring what parseGroupConfiguration produces.
 */
export function testGroupServer(apiKey: HeaderValue | "" = fixedHeaderValue("test-key")): GroupServer {
	return { baseUrl: normalizeBaseUrl(TEST_BASE_URL), apiKey, label: "Default" };
}

/**
 * Create a provider that serves models the way the host does.
 *
 *   With `baseUrl`     -> configuration-less discovery calls are rewritten into the host's per-group call for that
 *                         server, and the provider gets a discovery cache that never serves stored results, so every
 *                         discovery call observes the handlers installed at that moment
 *   Without `baseUrl`  -> the provider is bare: configuration-less calls exercise the group-agnostic contract (no
 *                         models), and group suites pass their own configuration explicitly
 */
export function makeProvider(
	baseUrl?: string,
	apiKey = "test-key",
	outputChannel?: vscode.LogOutputChannel,
	overrides: Partial<LiteLLMChatModelProviderOptions> = {}
): LiteLLMChatModelProvider {
	const logger = outputChannel ? new Logger(outputChannel) : undefined;
	const uncachedDiscovery =
		baseUrl === undefined || overrides.discoveryCache !== undefined
			? {}
			: {
					discoveryCache: new (class extends DiscoveryCache<DiscoveredGroupModels> {
						override lookup(): undefined {
							return undefined;
						}
					})(),
				};
	const provider = new LiteLLMChatModelProvider({
		userAgent: fixedHeaderValue("GitHubCopilotChat/test VSCode/test"),
		logger,
		...uncachedDiscovery,
		...overrides,
	});
	if (baseUrl !== undefined) {
		const original = provider.provideLanguageModelChatInformation.bind(provider);
		provider.provideLanguageModelChatInformation = (options, token) => {
			const opts = options as { silent: boolean; configuration?: unknown };
			const withConfiguration =
				opts.configuration !== undefined
					? options
					: ({ ...opts, configuration: { baseUrl, apiKey, label: "Default" } } as typeof options);
			return original(withConfiguration, token);
		};
	}
	return provider;
}

export function createConfiguredProvider(): LiteLLMChatModelProvider {
	return makeProvider(TEST_BASE_URL);
}

export function userMessage(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart(text)],
		name: undefined,
	};
}

/** VS Code sends role 3 for system messages via a proposed API; the stable enum has no System member. */
export function systemMessage(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: 3 as vscode.LanguageModelChatMessageRole,
		content: [new vscode.LanguageModelTextPart(text)],
		name: undefined,
	};
}

export interface CapturedRequest {
	body: Record<string, unknown>;
	headers: Record<string, string>;
	/** The model object the request went out with: the discovered one under useDiscoveredModel, else the attached copy. */
	model: LiteLLMModelInfo;
}

export interface CaptureRequestOverrides {
	messages?: vscode.LanguageModelChatRequestMessage[];
	discoveryPayload?: JsonBodyType;
	/**
	 * Send the chat request with the model object discovery returned (matched by id), mirroring the host contract of
	 * handing the provider's own info objects back. Required for behavior that rides on the model object, such as
	 * prompt-caching support.
	 */
	useDiscoveredModel?: boolean;
	/** The group the host serves and the request routes through, as its flat host configuration; defaults to testGroupServer(). */
	group?: Pick<GroupServer, "baseUrl" | "apiKey" | "label">;
}

/**
 * Serve one provider group followed by a chat request against msw handlers, the way the host drives the provider: the
 * group's refresh with its configuration, then a request with a model carrying that group's identity. Discovery
 * endpoints return `discoveryPayload` (default: a valid "test-model" listing), and POST /v1/chat/completions captures
 * the request body and headers before answering with a minimal SSE stream. The calling suite must have installed the
 * msw lifecycle via useMsw().
 */
export async function captureRequest(
	provider: LiteLLMChatModelProvider,
	model: LiteLLMModelInfo,
	opts: unknown,
	overrides: CaptureRequestOverrides = {}
): Promise<CapturedRequest> {
	let captured: Omit<CapturedRequest, "model"> | undefined;
	const discoveryPayload = overrides.discoveryPayload ?? DEFAULT_DISCOVERY_PAYLOAD;
	mswServer.use(
		...discoveryHandlers(discoveryPayload),
		http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
			captured = {
				body: (await request.json()) as Record<string, unknown>,
				headers: toHeaderMap(request.headers),
			};
			return sseTextResponse("ok");
		})
	);
	const group = overrides.group ?? testGroupServer();
	const token = new vscode.CancellationTokenSource().token;
	const infos = await provider.provideLanguageModelChatInformation(
		{ silent: true, configuration: group } as { silent: boolean },
		token
	);
	const discovered = overrides.useDiscoveredModel
		? expectDefined(
				infos.find((info) => info.id === model.id),
				`discovery returned no model with id "${model.id}"`
			)
		: undefined;
	const sent =
		discovered ??
		(model.litellm?.group !== undefined
			? model
			: attachGroup(model as PreAttachModelInfo, groupIdentity(group, groupClientId(group))));
	await provider.provideLanguageModelChatResponse(
		sent,
		overrides.messages ?? [userMessage("test")],
		opts as vscode.ProvideLanguageModelChatResponseOptions,
		{ report: () => {} },
		token
	);
	return { ...expectDefined(captured, "no chat request reached the mock server"), model: sent };
}

export async function captureRequestBody(
	provider: LiteLLMChatModelProvider,
	model: LiteLLMModelInfo,
	opts: unknown,
	overrides: CaptureRequestOverrides = {}
): Promise<Record<string, unknown>> {
	return (await captureRequest(provider, model, opts, overrides)).body;
}

type ServerStatusOverrides = Partial<
	Pick<
		ServerStatus,
		"serverId" | "label" | "entryLabel" | "baseUrl" | "lastChecked" | "hasApiKey" | "hasOAuth" | "hasVirtualKey"
	>
> &
	(
		| {
				state?: "ok";
				servedModelCount?: number;
				hiddenByRemoval?: boolean;
				modelInfoUnsupported?: "timeout" | "status";
		  }
		| {
				state: "error";
				/** The log rendering's source when no logSafeError is given; never the display text. */
				error?: string;
				cause?: FailureCause;
				logSafeError?: string;
				classification?: TransportErrorClassification;
				expected?: boolean;
				servedModelCount?: number;
				declaredModelCount?: number;
		  }
	);

export function makeServerStatus(overrides: ServerStatusOverrides = {}): ServerStatus {
	const common = {
		serverId: overrides.serverId ?? "srv1",
		label: overrides.label ?? "Prod",
		...(overrides.entryLabel !== undefined ? { entryLabel: overrides.entryLabel } : {}),
		baseUrl: overrides.baseUrl ?? "http://prod.test",
		lastChecked: overrides.lastChecked ?? "2026-07-26T00:00:00.000Z",
		...(overrides.hasApiKey !== undefined ? { hasApiKey: overrides.hasApiKey } : {}),
		...(overrides.hasOAuth !== undefined ? { hasOAuth: overrides.hasOAuth } : {}),
		...(overrides.hasVirtualKey !== undefined ? { hasVirtualKey: overrides.hasVirtualKey } : {}),
	};
	return overrides.state === "error"
		? {
				...common,
				state: "error",
				// A classification given alone is a transport cause; nothing given is an unclassified failure.
				cause:
					overrides.cause ??
					(overrides.classification !== undefined
						? { kind: "transport", classification: overrides.classification }
						: { kind: "unclassified" }),
				// An error still serves its declared models unless the test says otherwise.
				servedModelCount: overrides.servedModelCount ?? overrides.declaredModelCount ?? 0,
				// Tests hand plain strings; the helper is the one place that brands them.
				logSafeError:
					overrides.logSafeError !== undefined
						? markLogSafe(overrides.logSafeError)
						: publicErrorText(overrides.error ?? "unclassified failure"),
				...(overrides.expected !== undefined ? { expected: overrides.expected } : {}),
				...(overrides.declaredModelCount !== undefined ? { declaredModelCount: overrides.declaredModelCount } : {}),
			}
		: {
				...common,
				state: "ok",
				servedModelCount: overrides.servedModelCount ?? 4,
				...(overrides.hiddenByRemoval !== undefined ? { hiddenByRemoval: overrides.hiddenByRemoval } : {}),
				...(overrides.modelInfoUnsupported !== undefined
					? { modelInfoUnsupported: overrides.modelInfoUnsupported }
					: {}),
			};
}

export interface FakeExtensionStorage {
	memento: vscode.Memento;
	secrets: vscode.SecretStorage;
	mementoStore: Map<string, unknown>;
	secretStore: Map<string, string>;
}

/** Map-backed Memento and SecretStorage fakes covering what the storage-backed stores consume. */
export function makeExtensionStorage(initialMemento?: Record<string, unknown>): FakeExtensionStorage {
	const mementoStore = new Map<string, unknown>(Object.entries(initialMemento ?? {}));
	const memento = {
		get: (key: string, defaultValue?: unknown) => (mementoStore.has(key) ? mementoStore.get(key) : defaultValue),
		update: async (key: string, value: unknown) => {
			mementoStore.set(key, value);
		},
	} as unknown as vscode.Memento;

	const secretStore = new Map<string, string>();
	const secrets = {
		get: async (key: string) => secretStore.get(key),
		store: async (key: string, value: string) => {
			secretStore.set(key, value);
		},
		delete: async (key: string) => {
			secretStore.delete(key);
		},
		onDidChange: (_listener: unknown) => ({ dispose() {} }),
	} as unknown as vscode.SecretStorage;

	return { memento, secrets, mementoStore, secretStore };
}

export function makeMigrationContext(
	storage: FakeExtensionStorage = makeExtensionStorage(),
	overrides: Partial<MigrationContext> = {}
): MigrationContext {
	return {
		globalState: storage.memento,
		secrets: storage.secrets,
		logger: makeLogger().logger,
		fingerprintSalt: fakeFingerprintSaltSession(),
		...overrides,
	};
}

type StorageOperation = "mementoUpdate" | "secretGet" | "secretStore" | "secretDelete";

/**
 * Secret operations fail before mutating; `mementoUpdate` mutates first and then fails, mirroring VS Code's Memento,
 * which caches an update optimistically before the async write settles. The backing maps are shared with `storage`.
 */
export function failingStorage(
	storage: FakeExtensionStorage,
	{ failOn }: { failOn: Partial<Record<StorageOperation, (key: string) => Error | undefined>> }
): FakeExtensionStorage & { ops: string[] } {
	const ops: string[] = [];
	const throwIfArmed = (operation: StorageOperation, key: string): void => {
		const error = failOn[operation]?.(key);
		if (error !== undefined) {
			throw error;
		}
	};
	const memento = {
		get: (key: string, defaultValue?: unknown) => storage.memento.get(key, defaultValue),
		update: async (key: string, value: unknown) => {
			ops.push("update");
			await storage.memento.update(key, value);
			throwIfArmed("mementoUpdate", key);
		},
	} as unknown as vscode.Memento;
	const secrets = {
		get: async (key: string) => {
			throwIfArmed("secretGet", key);
			return storage.secrets.get(key);
		},
		store: async (key: string, value: string) => {
			ops.push("store");
			throwIfArmed("secretStore", key);
			await storage.secrets.store(key, value);
		},
		delete: async (key: string) => {
			ops.push("delete");
			throwIfArmed("secretDelete", key);
			await storage.secrets.delete(key);
		},
		onDidChange: (_listener: unknown) => ({ dispose() {} }),
	} as unknown as vscode.SecretStorage;
	return { memento, secrets, mementoStore: storage.mementoStore, secretStore: storage.secretStore, ops };
}
