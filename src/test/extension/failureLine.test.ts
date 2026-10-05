/**
 * The four boundaries that log a caught transport failure at error level, driven through a failure whose text quotes
 * a marker: the channel and the issue-report buffer get the classification line, the recorder's latest-error snapshot
 * keeps the public rendering, and the marker reaches none of them.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { runGenerateCommitMessage } from "../../extension/features/commitGen/generateCommitCommand";
import { wireConsultTool } from "../../extension/features/consultTool/wiring";
import type { API, Repository } from "../../extension/features/gitApi";
import { createMcpServerDefinitionProvider } from "../../extension/features/mcp/provider";
import { McpVersionCounters } from "../../extension/features/mcp/versions";
import type { FailureLineMessage } from "../../provider/catalog/discoveryLog";
import { attachGroup, groupClientId } from "../../provider/catalog/groupModels";
import { groupIdentity } from "../../provider/catalog/statusWindow";
import { OneShotClient } from "../../provider/transport/oneShotClient";
import { Logger } from "../../shared/logger";
import { CHAT_COMPLETIONS_URL, discoveryHandlers, mswServer, TEST_BASE_URL, useMsw } from "../mocks/handlers";
import { assertOmits, DEFAULT_DISCOVERY_PAYLOAD, makeModelInfo } from "../pureHelpers";
import { makeExtensionStorage, makeProvider, testGroupServer, userMessage, withConfig } from "../testUtils";
import { fakeContext, withWiringSpies } from "./features/wiringSpies";

const MARKER = "sk-live-MARKER";
const TOKEN_URL = "http://idp.test/oauth2/token";
const SERVER_ENTRY = { label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } };
const AUTH_MESSAGE_ENGLISH =
	'Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.';

interface CapturedLogger {
	logger: Logger;
	channel: string[];
	buffer: string[];
	recorded: [string, string][];
}

function captureLogger(): CapturedLogger {
	const channel: string[] = [];
	const buffer: string[] = [];
	const recorded: [string, string][] = [];
	const logger = new Logger(
		{ info: (line) => channel.push(line), error: (line) => channel.push(`ERROR: ${line}`) },
		{ appendLog: (line) => buffer.push(line), recordError: (source, error) => recorded.push([source, error.message]) }
	);
	return { logger, channel, buffer, recorded };
}

function chatFailure(status: number): () => Response {
	return () => HttpResponse.json({ error: { message: MARKER } }, { status });
}

/**
 * The host's sequence: the group's serve puts it in the status window, then a request arrives with a model carrying
 * that group's identity. An unattached model skips the serve and fails routing before anything is sent.
 */
async function chatRequest(logger: Logger, modelId: string, attached: boolean): Promise<void> {
	const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, { logger });
	const token = new vscode.CancellationTokenSource().token;
	const group = testGroupServer();
	const info = makeModelInfo({ id: modelId, name: modelId, maxInputTokens: 1000, maxOutputTokens: 1000 });
	if (attached) {
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));
		await provider.provideLanguageModelChatInformation(
			{ silent: true, configuration: group } as { silent: boolean },
			token
		);
	}
	await provider.provideLanguageModelChatResponse(
		attached ? attachGroup(info, groupIdentity(group, groupClientId(group))) : info,
		[userMessage("hi")],
		{} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
		{ report: () => {} },
		token
	);
}

async function consultation(logger: Logger): Promise<void> {
	await withWiringSpies(async (spies) => {
		await withConfig(
			{
				"consultTool.enabled": true,
				"consultTool.model": { server: "alpha", model: "gpt-test" },
				servers: [SERVER_ENTRY],
			},
			async () => {
				wireConsultTool(fakeContext(), logger, { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
				const tool = spies.registrations.at(-1)?.tool;
				assert.ok(tool !== undefined, "the tool is registered");
				await tool.invoke(
					{
						toolInvocationToken: undefined,
						input: { question: "q" },
					} as vscode.LanguageModelToolInvocationOptions<unknown>,
					new vscode.CancellationTokenSource().token
				);
			}
		);
	});
}

function commitGeneration(logger: Logger): Promise<void> {
	const repo = {
		rootUri: vscode.Uri.file("/repo"),
		inputBox: { value: "" },
		state: { HEAD: undefined, indexChanges: [], workingTreeChanges: [], untrackedChanges: [] },
		diff: () => Promise.resolve("+staged line"),
		log: () => Promise.resolve([]),
	} as unknown as Repository;
	const git = (): Promise<API | undefined> => Promise.resolve({ repositories: [repo] } as unknown as API);
	return withConfig(
		{
			"commitGeneration.enabled": true,
			"commitGeneration.model": { server: "alpha", model: "gpt-test" },
			servers: [SERVER_ENTRY],
		},
		() =>
			runGenerateCommitMessage(
				new OneShotClient({ userAgent: "test-agent" }),
				{
					secrets: makeExtensionStorage().secrets,
					logger,
					outputChannel: { show: () => {}, appendLine: () => {} } as unknown as vscode.OutputChannel,
				},
				undefined,
				git
			)
	);
}

async function mcpResolve(logger: Logger): Promise<void> {
	const storage = makeExtensionStorage();
	const provider = createMcpServerDefinitionProvider(
		{
			secrets: storage.secrets,
			oneShot: new OneShotClient({ userAgent: "test-agent" }),
			versions: new McpVersionCounters(storage.memento),
			advisory: () => {},
			logError: () => {},
			logFailure: (message, data, error) => logger.failure(message, data, error),
		},
		new vscode.EventEmitter<void>().event
	);
	const servers = [
		{
			label: "Main",
			baseUrl: TEST_BASE_URL,
			mcp: true,
			auth: { oauth: { tokenUrl: TOKEN_URL, clientId: "c", clientSecret: "shh" } },
		},
	];
	await withConfig({ servers }, async () => {
		const source = new vscode.CancellationTokenSource();
		try {
			const [definition] = (await provider.provideMcpServerDefinitions(source.token)) ?? [];
			assert.ok(definition, "the entry is published");
			await provider.resolveMcpServerDefinition?.(definition, source.token);
		} finally {
			source.dispose();
		}
	});
}

suite("extension failure lines", () => {
	useMsw();

	// A toast promise stays pending until dismissed in a live host, which would hang the command boundary's await.
	let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
	setup(() => {
		originalShowErrorMessage = vscode.window.showErrorMessage;
		(vscode.window as Record<string, unknown>).showErrorMessage = () => Promise.resolve(undefined);
	});
	teardown(() => {
		(vscode.window as Record<string, unknown>).showErrorMessage = originalShowErrorMessage;
	});

	// One row per boundary; the chat boundary adds the two shapes with one reading absent: a 401 has a kind and no
	// classification string, a routing refusal has a classification string and no kind.
	const cases: {
		name: string;
		message: FailureLineMessage;
		handlers: () => Parameters<typeof mswServer.use>;
		run: (logger: Logger) => Promise<unknown>;
		rejects: boolean;
		line: Record<string, unknown>;
		recorded: string;
	}[] = [
		{
			name: "a chat completion answered 503 with the marker in the body",
			message: "Chat request failed",
			handlers: () => [http.post(CHAT_COMPLETIONS_URL, chatFailure(503))],
			run: (logger) => chatRequest(logger, "m", true),
			rejects: true,
			line: { kind: "http", status: 503, classification: "RequestError(http, status 503)" },
			recorded: "RequestError(http, status 503)",
		},
		{
			name: "a chat completion answered 401 with the marker in the body",
			message: "Chat request failed",
			handlers: () => [http.post(CHAT_COMPLETIONS_URL, chatFailure(401))],
			run: (logger) => chatRequest(logger, "m", true),
			rejects: true,
			line: { kind: "auth", status: 401 },
			recorded: AUTH_MESSAGE_ENGLISH,
		},
		{
			name: "a chat request for a model named by the marker that carries no group identity",
			message: "Chat request failed",
			handlers: () => [],
			run: (logger) => chatRequest(logger, MARKER, false),
			rejects: true,
			line: { kind: "unclassified", classification: "RequestRouting(no group identity)" },
			recorded: "RequestRouting(no group identity)",
		},
		{
			name: "a consultation answered 503 with the marker in the body",
			message: "Consult tool consultation failed",
			handlers: () => [http.post(CHAT_COMPLETIONS_URL, chatFailure(503))],
			run: consultation,
			rejects: true,
			line: { kind: "http", status: 503, classification: "RequestError(http, status 503)" },
			recorded: "RequestError(http, status 503)",
		},
		{
			name: "a commit message generation answered 503 with the marker in the body",
			message: "Commit message generation failed",
			handlers: () => [http.post(CHAT_COMPLETIONS_URL, chatFailure(503))],
			run: commitGeneration,
			rejects: false,
			line: { kind: "http", status: 503, classification: "RequestError(http, status 503)" },
			recorded: "RequestError(http, status 503)",
		},
		{
			name: "an MCP resolve whose token exchange is refused with the marker in the IdP's description",
			message: "MCP resolve failed",
			handlers: () => [
				http.post(TOKEN_URL, () =>
					HttpResponse.json({ error: "invalid_client", error_description: MARKER }, { status: 401 })
				),
			],
			run: mcpResolve,
			rejects: true,
			line: { kind: "auth", status: 401, classification: "RequestError(auth, status 401, oauth token endpoint)" },
			recorded: "RequestError(auth, status 401, oauth token endpoint)",
		},
	];
	for (const { name, message, handlers, run, rejects, line, recorded } of cases) {
		test(`${name} logs its classification and nothing from the failure's text`, async () => {
			mswServer.use(...handlers());
			const captured = captureLogger();

			if (rejects) {
				await assert.rejects(run(captured.logger));
			} else {
				await run(captured.logger);
			}

			for (const logged of [...captured.channel, ...captured.buffer, ...captured.recorded.flat()]) {
				assertOmits(logged, MARKER, `a log surface carried the failure's text: ${logged}`);
			}
			const expected = `${message}: ${JSON.stringify(line, null, 2)}`;
			assert.deepStrictEqual(
				captured.channel.filter((logged) => logged.startsWith("ERROR: ")),
				[`ERROR: ${expected}`]
			);
			assert.deepStrictEqual(
				captured.buffer
					.filter((logged) => logged.includes("ERROR: "))
					.map((logged) => logged.replace(/^\[[^\]]+\] /, "")),
				[`ERROR: ${expected}`]
			);
			assert.deepStrictEqual(captured.recorded, [[message, recorded]]);
		});
	}
});
