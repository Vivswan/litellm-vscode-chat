/**
 * The planner's rules (routes, refusal reasons, secret directives) live in the bun suites; this one pins what only the
 * host adapter decides: registration, the live-switch re-check, the prompt, the log, and the result envelope.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DashboardState } from "../../../../dashboard/viewModels";
import type { DashboardSubmission } from "../../../../extension/dashboard/panel";
import type { SecretPrompt } from "../../../../extension/features/agentTools/planner";
import type { AgentToolsDeps } from "../../../../extension/features/agentTools/wiring";
import { wireAgentTools } from "../../../../extension/features/agentTools/wiring";
import type { SecretStore } from "../../../../extension/servers/serverSync/secrets";
import { IssueReporter } from "../../../../extension/ui/issueReporter";
import type { AgentToolId } from "../../../../shared/config/commandIds";
import { AGENT_TOOL_IDS, AGENT_TOOLS } from "../../../../shared/config/commandIds";
import type { AgentWriteToolId } from "../../../../shared/config/settingSpec";
import {
	AGENT_TOOL_TOGGLE_KEYS,
	AGENT_TOOLS_SECRET_VALUES_KEY,
	CONFIG_SECTION,
	SERVERS_SETTING_KEY,
} from "../../../../shared/config/settingSpec";
import { serverSecretsKey } from "../../../../shared/config/storageKeys";
import { localizedError, MirroredError } from "../../../../shared/mirroredError";
import { KnownSecrets } from "../../../../shared/util/knownSecrets";
import {
	agentToolsState,
	COPILOT_BASE_URL,
	CRED_DISPLAY_URL,
} from "../../../bun/extension/features/agentTools/fixture";
import { assertOmits, makeLogger } from "../../../pureHelpers";
import { withConfig } from "../../../testUtils";
import type { WiringSpies } from "../wiringSpies";
import { fakeContext, withWiringSpies } from "../wiringSpies";

const name = (id: AgentToolId): string => AGENT_TOOLS[id].name;
const READ_IDS = AGENT_TOOL_IDS.filter((id) => AGENT_TOOLS[id].toggle === undefined);
const WRITE_IDS = AGENT_TOOL_IDS.filter((id) => AGENT_TOOLS[id].toggle !== undefined);
const WRITE_TOGGLES = Object.keys(AGENT_TOOL_TOGGLE_KEYS) as AgentWriteToolId[];

const FEATURE_ON = { "agentTools.enabled": true };

/** The classification a thrown value that is no Error leaves with. */
const NON_ERROR = "AgentTools(setSetting: non-error-throw)";

/** The given write toggles on; every other agentTools key stays at its (off) default. */
function toggles(...ids: readonly AgentWriteToolId[]): Record<string, boolean> {
	return Object.fromEntries(ids.map((id) => [AGENT_TOOL_TOGGLE_KEYS[id], true]));
}

/** The feature and every write toggle on; the secret-values switch stays off unless a test says otherwise. */
const ALL_WRITES = { ...FEATURE_ON, ...toggles(...WRITE_TOGGLES) };

/** The frame the wiring hands the controller; the fake asserts the envelope so every write test checks it. */
interface FramedRequest {
	readonly kind: "request";
	readonly id: string;
	readonly method: string;
	readonly payload: unknown;
}

function asFramed(raw: unknown): FramedRequest {
	const record = raw as Record<string, unknown>;
	assert.strictEqual(record.kind, "request", "the wiring frames every submission as a request");
	assert.strictEqual(typeof record.id, "string", "a request carries a correlation id");
	assert.strictEqual(typeof record.method, "string", "a request names its method");
	return record as unknown as FramedRequest;
}

interface Harness {
	readonly context: vscode.ExtensionContext;
	readonly submitted: FramedRequest[];
	readonly prompts: {
		readonly prompt: SecretPrompt;
		readonly label: string;
		readonly token: vscode.CancellationToken;
	}[];
	/** The logger's channel lines; error lines carry the "ERROR: " prefix makeLogger adds. */
	readonly lines: string[];
}

interface HarnessOptions {
	readonly respond?: (request: FramedRequest) => DashboardSubmission;
	/** A value the dashboard fake throws from submit instead of answering (a function is called per submit); undefined throws nothing. */
	readonly submitThrows?: unknown;
	/** When true the logger's error sink throws, standing for a broken output channel. */
	readonly loggerThrows?: boolean;
	/** An error the settings reader's inspect throws, so card preparation fails. */
	readonly inspectThrows?: Error;
	/** Runs when the settings reader's inspect is called during card preparation (a store landing mid-way). */
	readonly onInspect?: () => void;
	/** What the user types into the masked box; undefined is a cancel. */
	readonly answerSecret?: () => string | undefined;
	readonly settings?: Record<string, unknown>;
	/** The secret values the shared set holds; none by default. */
	readonly knownSecrets?: readonly string[];
	/** The host's SecretStorage; an empty, quiet store by default (a rejecting one stands for an unreadable store). */
	readonly secretStore?: SecretStore;
	/** The dashboard state the tools read; the bun fixture every agent-tools suite plans against by default. */
	readonly state?: DashboardState;
}

/**
 * Wire the feature under `config` against fakes; the state is the bun fixture every agent-tools suite plans
 * against.
 */
async function wireUnderTest(config: Record<string, unknown>, options: HarnessOptions = {}): Promise<Harness> {
	const context = fakeContext();
	const submitted: FramedRequest[] = [];
	const prompts: Harness["prompts"] = [];
	const { logger: plainLogger, lines } = makeLogger();
	const logger = options.loggerThrows
		? new Proxy(plainLogger, {
				get: (target, property, receiver) =>
					property === "error"
						? () => {
								throw new Error("Sink failed probe-secret-Q7");
							}
						: Reflect.get(target, property, receiver),
			})
		: plainLogger;
	const settings = options.settings ?? {};
	const known = new KnownSecrets();
	known.set(options.knownSecrets ?? []);
	const deps: AgentToolsDeps = {
		dashboard: {
			readState: () => options.state ?? agentToolsState(),
			submit: async (raw) => {
				const framed = asFramed(raw);
				submitted.push(framed);
				if (options.submitThrows !== undefined) {
					throw typeof options.submitThrows === "function"
						? (options.submitThrows as () => unknown)()
						: options.submitThrows;
				}
				return (options.respond ?? (() => ({ outcome: "ok" })))(framed);
			},
		},
		settings: {
			readEffective: (key) => settings[key],
			inspect: (key) => {
				if (options.inspectThrows !== undefined) {
					throw options.inspectThrows;
				}
				options.onInspect?.();
				return Object.hasOwn(settings, key) ? { globalValue: settings[key] } : undefined;
			},
		},
		knownSecrets: known,
		secretStore: options.secretStore ?? {
			get: async () => undefined,
			store: async () => undefined,
			delete: async () => undefined,
		},
		getConnectionStatus: () => ({ state: "not-configured" }),
		issueReporter: new IssueReporter(),
		extVersion: "0.0.0-test",
		vscodeVersion: "1.0.0-test",
		promptSecret: async (prompt, label, token) => {
			prompts.push({ prompt, label, token });
			return options.answerSecret?.();
		},
	};
	await withConfig(config, () => {
		wireAgentTools(context, logger, deps);
	});
	return { context, submitted, prompts, lines };
}

function liveNames(spies: WiringSpies): string[] {
	return spies.registrations.filter((record) => !record.disposed).map((record) => record.name);
}

function liveTool(spies: WiringSpies, id: AgentToolId): vscode.LanguageModelTool<unknown> {
	const record = spies.registrations.find((candidate) => !candidate.disposed && candidate.name === name(id));
	assert.ok(record !== undefined, `${name(id)} is registered`);
	return record.tool;
}

/**
 * Invoke the recorded tool the way the host does: the live settings at call time decide, so callers wrap in withConfig.
 */
function invokeLive(
	spies: WiringSpies,
	id: AgentToolId,
	input: unknown,
	token: vscode.CancellationToken = new vscode.CancellationTokenSource().token
): Promise<vscode.LanguageModelToolResult> {
	const options = { toolInvocationToken: undefined, input } as vscode.LanguageModelToolInvocationOptions<unknown>;
	return Promise.resolve(liveTool(spies, id).invoke(options, token)).then((result) => {
		assert.ok(result != null, "the tool answered with a result");
		return result;
	});
}

async function prepareLive(
	spies: WiringSpies,
	id: AgentToolId,
	input: unknown
): Promise<vscode.PreparedToolInvocation> {
	const tool = liveTool(spies, id);
	assert.ok(tool.prepareInvocation !== undefined, `${name(id)} customizes its invocation`);
	const prepared = await tool.prepareInvocation({ input }, new vscode.CancellationTokenSource().token);
	assert.ok(prepared != null, "the card is prepared");
	return prepared;
}

function resultJson(result: vscode.LanguageModelToolResult): unknown {
	assert.strictEqual(result.content.length, 1, "the tool answers with exactly one part");
	const part = result.content[0];
	assert.ok(part instanceof vscode.LanguageModelTextPart, "the one part is plain text");
	return JSON.parse(part.value);
}

function cardText(prepared: vscode.PreparedToolInvocation): string {
	const message = prepared.confirmationMessages?.message;
	assert.ok(message !== undefined, "a write shows a confirmation card");
	return message instanceof vscode.MarkdownString ? message.value : message;
}

async function assertRefused(
	promise: Promise<unknown>,
	id: AgentToolId,
	classification: string,
	says: (message: string) => void
): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof MirroredError, "refusals are mirrored errors");
		assert.strictEqual(error.logClassification, `AgentTools(${id}: ${classification})`);
		says(error.message);
		return true;
	});
}

const NEW_SERVER = { label: "New", baseUrl: "http://new.test" };

suite("extension/features/agentTools wiring", () => {
	test("the registered set is exactly the feature switch and, per write, its own toggle", async () => {
		// What drifts without this: a write registered without its toggle, a read gated on a toggle, or a toggle that
		// registers while the feature switch is off.
		const cases: {
			readonly title: string;
			readonly config: Record<string, unknown>;
			readonly expected: AgentToolId[];
		}[] = [
			{ title: "feature off, every toggle on", config: toggles(...WRITE_TOGGLES), expected: [] },
			{ title: "feature off explicitly", config: { ...ALL_WRITES, "agentTools.enabled": false }, expected: [] },
			{ title: "feature on, no toggles", config: FEATURE_ON, expected: [...READ_IDS] },
			{
				title: "feature on + setSetting",
				config: { ...FEATURE_ON, ...toggles("setSetting") },
				expected: [...READ_IDS, "setSetting"],
			},
			{
				title: "feature on + saveServer + removeServer",
				config: { ...FEATURE_ON, ...toggles("saveServer", "removeServer") },
				expected: [...READ_IDS, "saveServer", "removeServer"],
			},
			{ title: "everything on", config: ALL_WRITES, expected: [...AGENT_TOOL_IDS] },
		];
		for (const { title, config, expected } of cases) {
			await withWiringSpies(async (spies) => {
				await wireUnderTest(config);
				assert.deepStrictEqual(liveNames(spies), expected.map(name), title);
				// The agent tools gate on plain settings, so the manifest's when clauses need no context key and the
				// wiring publishes none.
				assert.strictEqual(spies.contextStates.size, 0, `${title}: no context key`);
			});
		}
	});

	test("a configuration change disposes exactly what went off and registers exactly what came on", async () => {
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest({ ...FEATURE_ON, ...toggles("setSetting") });
			const steps: { readonly config: Record<string, unknown>; readonly live: AgentToolId[] }[] = [
				{ config: FEATURE_ON, live: [...READ_IDS] },
				{ config: { ...FEATURE_ON, ...toggles("editModelRecords") }, live: [...READ_IDS, "editModelRecords"] },
				{ config: toggles("editModelRecords"), live: [] },
				{ config: ALL_WRITES, live: [...AGENT_TOOL_IDS] },
			];
			for (const [index, { config, live }] of steps.entries()) {
				await withConfig(config, () => {
					spies.fireConfigChange();
				});
				assert.deepStrictEqual(liveNames(spies), live.map(name), `step ${index + 1}`);
			}
			// 5 at wiring, +1 for editModelRecords, +9 after the feature came back: a wiring that re-registered the
			// untouched reads on every change would count higher.
			assert.strictEqual(spies.registrations.length, 15, "untouched registrations are left alone");
			for (const subscription of harness.context.subscriptions) {
				subscription.dispose();
			}
			assert.deepStrictEqual(liveNames(spies), [], "deactivation releases every name");
		});
	});

	test("a switch flipped under a registered tool is refused by the invoke itself", async () => {
		// The configuration event races an in-flight agent turn: the registration still stands, so the tool must answer
		// the live settings.
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES);
			await withConfig({ ...ALL_WRITES, [AGENT_TOOL_TOGGLE_KEYS.setSetting]: false }, () =>
				assertRefused(
					invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }),
					"setSetting",
					"tool switched off",
					(message) => assert.match(message, /"litellm-vscode-chat\.agentTools\.setSetting\.enabled"/)
				)
			);
			await withConfig({ ...ALL_WRITES, "agentTools.enabled": false }, () =>
				assertRefused(invokeLive(spies, "configuration", {}), "configuration", "disabled", (message) =>
					assert.match(message, /agentTools\.enabled/)
				)
			);
			assert.deepStrictEqual(harness.submitted, [], "nothing reached the dashboard");
		});
	});

	test("a refused set_setting submits nothing and logs its classification once", async () => {
		const cases: {
			readonly input: unknown;
			readonly classification: string;
			readonly says: (message: string) => void;
		}[] = [
			{
				input: { setting: "servers", value: [] },
				classification: "setting-owned-by-tool",
				says: (message) => assert.match(message, /not changed through litellm_set_setting; use the saveServer tool/),
			},
			{
				input: { setting: AGENT_TOOLS_SECRET_VALUES_KEY, value: true },
				classification: "agent-tools-switch",
				says: (message) => assert.match(message, /can only be changed by the user/),
			},
			{
				input: { setting: "no.such", value: 1 },
				classification: "unknown-setting",
				says: (message) => assert.match(message, /"no\.such" is not a litellm-vscode-chat setting/),
			},
			{
				input: { nope: 1 },
				classification: "malformed input",
				says: (message) => {
					assert.match(message, /malformed/);
					// Both the missing path and the unknown key, so the model can fix the call.
					assert.match(message, /setting/);
					assert.match(message, /nope/);
				},
			},
		];
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES);
			for (const [index, { input, classification, says }] of cases.entries()) {
				await withConfig(ALL_WRITES, () =>
					assertRefused(invokeLive(spies, "setSetting", input), "setSetting", classification, says)
				);
				assert.deepStrictEqual(harness.submitted, [], `${classification}: nothing reached the dashboard`);
				const failures = harness.lines.filter((line) => line.startsWith("ERROR: Agent tool setSetting failed"));
				assert.strictEqual(failures.length, index + 1, `${classification}: one failure line per refusal`);
			}
		});
	});

	test("a landed set_setting submits one framed request to the setting's own intent and reports it", async () => {
		const cases: { readonly input: unknown; readonly method: string; readonly payload: unknown }[] = [
			{
				input: { setting: "chat.timeout", value: 60000 },
				method: "setNumberSetting",
				payload: { setting: "chat.timeout", value: 60000 },
			},
			{ input: { setting: "chat.timeout", value: null }, method: "resetSetting", payload: { setting: "chat.timeout" } },
			{
				input: { setting: "chat.promptCaching", value: false },
				method: "setBooleanSetting",
				payload: { setting: "chat.promptCaching", value: false },
			},
		];
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES);
			for (const [index, { input, method, payload }] of cases.entries()) {
				const result = await withConfig(ALL_WRITES, () => invokeLive(spies, "setSetting", input));
				assert.deepStrictEqual(resultJson(result), { method, ok: true }, method);
				const frame = harness.submitted[index];
				assert.ok(frame !== undefined, `${method}: one submission`);
				assert.deepStrictEqual(frame, { kind: "request", id: frame.id, method, payload });
			}
			assert.strictEqual(harness.submitted.length, cases.length, "exactly one submission per call");
			const ids = new Set(harness.submitted.map((frame) => frame.id));
			assert.strictEqual(ids.size, cases.length, "correlation ids never repeat");
			assert.deepStrictEqual(harness.prompts, [], "a setting change prompts for nothing");
		});
	});

	test("prepareInvocation: reads run unconfirmed, writes show the change from current state, never a secret", async () => {
		await withWiringSpies(async (spies) => {
			await wireUnderTest(
				{ ...ALL_WRITES, [AGENT_TOOLS_SECRET_VALUES_KEY]: true },
				{
					settings: { "chat.timeout": 300000 },
				}
			);
			await withConfig({ ...ALL_WRITES, [AGENT_TOOLS_SECRET_VALUES_KEY]: true }, async () => {
				for (const id of READ_IDS) {
					const prepared = await prepareLive(spies, id, {});
					assert.ok(prepared.invocationMessage !== undefined, `${name(id)} shows progress`);
					// A read-only tool: a confirmation would interrupt every agent turn for nothing.
					assert.strictEqual(prepared.confirmationMessages, undefined, `${name(id)} asks no confirmation`);
				}

				const setting = await prepareLive(spies, "setSetting", { setting: "chat.timeout", value: 60000 });
				assert.match(String(setting.confirmationMessages?.title), /chat\.timeout/);
				const settingCard = cardText(setting);
				assert.match(settingCard, /litellm-vscode-chat\.chat\.timeout {2}\(configured in: global\)/);
				assert.match(settingCard, /before: 300000/);
				assert.match(settingCard, /after: {2}60000/);

				const inline = await prepareLive(spies, "saveServer", {
					...NEW_SERVER,
					secrets: { apiKey: { action: "set", location: "secure", value: "sk-inline" } },
				});
				const inlineCard = cardText(inline);
				assert.match(inlineCard, /new servers entry "New"/);
				assert.match(inlineCard, /apiKey: set \(secure\)/);
				assertOmits(inlineCard, "sk-inline", "the card names the secret's location, never its value");

				const prompted = await prepareLive(spies, "saveServer", {
					...NEW_SERVER,
					secrets: { apiKey: { action: "set", location: "secure" } },
				});
				assert.match(cardText(prompted), /apiKey: you will be asked to type it \(stored in secure\)/);
			});
			// A plan that would refuse gets no card: the refusal is the invoke's to hand back.
			await withConfig(ALL_WRITES, async () => {
				const refused = await prepareLive(spies, "saveServer", {
					...NEW_SERVER,
					secrets: { apiKey: { action: "set", location: "secure", value: "sk-inline" } },
				});
				assert.strictEqual(refused.confirmationMessages, undefined);
				assert.ok(refused.invocationMessage !== undefined);
			});
		});
	});

	test("a valueless set directive prompts once; the typed value lands, a cancel lands nothing and logs nothing", async () => {
		const input = { ...NEW_SERVER, secrets: { apiKey: { action: "set", location: "secure" } } };
		const expectedPrompt = { prompt: { field: "apiKey", location: "secure" }, label: "New" };
		const asked = (harness: Harness) => harness.prompts.map(({ prompt, label }) => ({ prompt, label }));

		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES, { answerSecret: () => "sk-typed" });
			const result = await withConfig(ALL_WRITES, () => invokeLive(spies, "saveServer", input));
			assert.deepStrictEqual(asked(harness), [expectedPrompt]);
			assert.deepStrictEqual(resultJson(result), { method: "saveServerSetting", ok: true });
			const frame = harness.submitted[0];
			assert.ok(frame !== undefined && harness.submitted.length === 1, "one save submitted");
			assert.strictEqual(frame.method, "saveServerSetting");
			const payload = frame.payload as { server: { label: string; baseUrl: string }; secrets: unknown };
			assert.strictEqual(payload.server.label, "New");
			// The typed value is spliced into the directive; the fields the agent did not name are cleared, because the
			// entry is new.
			assert.deepStrictEqual(payload.secrets, {
				apiKey: { action: "set", location: "secure", value: "sk-typed" },
				oauthClientSecret: { action: "clear" },
				virtualKeyValue: { action: "clear" },
			});
			for (const line of harness.lines) {
				assertOmits(line, "sk-typed", "the typed value never reaches the log");
			}
		});

		// A dismissed box and an empty answer both cancel: an empty string must never be stored as the key.
		for (const answer of [undefined, ""]) {
			await withWiringSpies(async (spies) => {
				const harness = await wireUnderTest(ALL_WRITES, { answerSecret: () => answer });
				await assert.rejects(
					withConfig(ALL_WRITES, () => invokeLive(spies, "saveServer", input)),
					(error: unknown) => error instanceof vscode.CancellationError,
					`answer ${JSON.stringify(answer)} cancels`
				);
				assert.deepStrictEqual(asked(harness), [expectedPrompt]);
				assert.deepStrictEqual(harness.submitted, [], "a cancel lands nothing");
				assert.deepStrictEqual(
					harness.lines.filter((line) => line.startsWith("ERROR:")),
					[],
					"cancellation is never logged"
				);
			});
		}
	});

	test("a secret value in tool input needs the secretValues switch; with it on, it travels", async () => {
		const input = { ...NEW_SERVER, secrets: { apiKey: { action: "set", location: "secure", value: "sk-inline" } } };
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES);
			await withConfig(ALL_WRITES, () =>
				assertRefused(invokeLive(spies, "saveServer", input), "saveServer", "secret-value-refused", (message) =>
					assert.match(message, /agentTools\.secretValues\.enabled/)
				)
			);
			assert.strictEqual(harness.prompts.length, 0, "a refused value is not re-asked for");
			assert.strictEqual(harness.submitted.length, 0, "nothing reached the dashboard");
			for (const line of harness.lines) {
				assertOmits(line, "sk-inline", "the refusal names the field, never the value");
			}

			const on = { ...ALL_WRITES, [AGENT_TOOLS_SECRET_VALUES_KEY]: true };
			const result = await withConfig(on, () => invokeLive(spies, "saveServer", input));
			assert.deepStrictEqual(resultJson(result), { method: "saveServerSetting", ok: true });
			assert.strictEqual(harness.prompts.length, 0, "a carried value is not prompted for");
			assert.strictEqual(harness.submitted.length, 1, "one save submitted");
			const payload = harness.submitted[0]?.payload as { secrets: { apiKey: unknown } };
			assert.deepStrictEqual(payload.secrets.apiKey, { action: "set", location: "secure", value: "sk-inline" });
		});
	});

	test("a dashboard failure rides the result for the agent; the log gets method and outcome only", async () => {
		const message = "the entered key xyz is bad";
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES, {
				respond: (request) => ({
					outcome: "validation-error",
					reply: { kind: "fail", id: request.id, method: "setNumberSetting", message, failureKind: "validation" },
				}),
			});
			const result = await withConfig(ALL_WRITES, () =>
				invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 60000 })
			);
			assert.deepStrictEqual(resultJson(result), {
				method: "setNumberSetting",
				ok: false,
				failureKind: "validation",
				message,
			});
			const prefix = "Agent tool request refused by the dashboard: ";
			const refusals = harness.lines.filter((line) => line.startsWith(prefix));
			assert.strictEqual(refusals.length, 1, "one classification line per refused request");
			assert.deepStrictEqual(JSON.parse((refusals[0] as string).slice(prefix.length)), {
				tool: "setSetting",
				method: "setNumberSetting",
				outcome: "validation-error",
			});
			for (const line of harness.lines) {
				assertOmits(line, "xyz", "the dashboard's message may quote an entered key; it stays out of the log");
			}
			assert.deepStrictEqual(
				harness.lines.filter((line) => line.startsWith("ERROR:")),
				[],
				"a refused request is the agent's problem, not an extension error"
			);
		});
	});

	test("a cancelled agent turn stops before its next submit: before the first request and between two", async () => {
		// The token is the host's: a cancel that arrives already-set must never reach the dashboard, and one that lands
		// mid-plan must stop the plan before its next request.
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES);
			const cancelled = new vscode.CancellationTokenSource();
			cancelled.cancel();
			await assert.rejects(
				withConfig(ALL_WRITES, () =>
					invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 60000 }, cancelled.token)
				),
				(error: unknown) => error instanceof vscode.CancellationError
			);
			assert.deepStrictEqual(harness.submitted, [], "an already-cancelled turn submits nothing");
			assert.deepStrictEqual(harness.lines, [], "cancellation is never logged");
		});

		await withWiringSpies(async (spies) => {
			const source = new vscode.CancellationTokenSource();
			const harness = await wireUnderTest(ALL_WRITES, {
				respond: () => {
					// The cancel lands while the first request is in flight.
					source.cancel();
					return { outcome: "ok" };
				},
			});
			// The model inspection is the plan that travels as TWO requests (the capabilities read, then the parameters
			// read).
			await assert.rejects(
				withConfig(ALL_WRITES, () =>
					invokeLive(spies, "inspectModel", { server: "Prod", model: "gpt-test" }, source.token)
				),
				(error: unknown) => error instanceof vscode.CancellationError
			);
			assert.deepStrictEqual(
				harness.submitted.map((frame) => frame.method),
				["readModelCapabilities"],
				"the second read never leaves"
			);
			assert.deepStrictEqual(harness.lines, [], "cancellation is never logged");
		});
	});

	// The one exit for text the model reads: a thrown refusal that names a URL label, a card title built from one,
	// and a result carrying a dashboard failure body that quotes a configured key all leave credential-free.
	test("every model-facing text leaves through the exit boundary: refusal, title, and result alike", async () => {
		const urlLabel = "http://u:refusal-password@host.test";
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, {
				knownSecrets: ["plain-key-Q7"],
				respond: () => ({
					outcome: "validation-error",
					reply: {
						kind: "fail",
						id: "x",
						method: "setNumberSetting",
						message: "Denied plain-key-Q7",
						failureKind: "operation",
					},
				}),
			});
			await withConfig(ALL_WRITES, async () => {
				await assertRefused(
					invokeLive(spies, "inspectModel", { server: urlLabel, model: "missing" }),
					"inspectModel",
					"model-not-found",
					(message) =>
						assert.strictEqual(
							message,
							'Server "http://host.test" serves no model "missing". Read the configuration tool\'s "models" section.'
						)
				);
				const prepared = await prepareLive(spies, "saveServer", { label: urlLabel, baseUrl: "http://new.test" });
				assert.deepStrictEqual(
					{
						invocationMessage: prepared.invocationMessage,
						title: prepared.confirmationMessages?.title,
						card: cardText(prepared),
					},
					{
						invocationMessage: "LiteLLM: saveServer",
						title: "Save the LiteLLM server http://host.test?",
						card: [
							"```",
							'new servers entry "http://host.test"',
							'baseUrl: (absent) -> "http://new.test"',
							"budget: (absent) -> null",
							"declaredModels: (absent) -> []",
							"expectedFailures: (absent) -> []",
							"headers: (absent) -> {}",
							"includeModes: (absent) -> []",
							'label: (absent) -> "http://host.test" (carries text the card does not show, such as URL credentials)',
							"mcp: (absent) -> null",
							"modelCapabilities: (absent) -> {}",
							"apiKey: cleared",
							"oauthClientSecret: cleared",
							"virtualKeyValue: cleared",
							"```",
						].join("\n"),
					}
				);
				const result = resultJson(await invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }));
				assert.deepStrictEqual(result, {
					method: "setNumberSetting",
					ok: false,
					failureKind: "operation",
					message: "Denied [redacted]",
				});
			});
		});
	});

	// The exits a round of probes found open: the progress line of a read, the refusal thrown before a tool runs, a
	// malformed-input refusal quoting an unrecognized URL key, and a record KEY equal to a known value.
	test("the progress line, the early refusals, a schema refusal, and a record key leave through the exit too", async () => {
		const fixture = agentToolsState();
		const state: DashboardState = {
			...fixture,
			settings: {
				...fixture.settings,
				modelParameters: { ...fixture.settings.modelParameters, value: { "plain-key-Q7": { temperature: 0 } } },
			},
		};
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, { knownSecrets: ["configuration", "enables", "plain-key-Q7"], state });
			await withConfig(ALL_WRITES, async () => {
				assert.strictEqual(
					(await prepareLive(spies, "configuration", {})).invocationMessage,
					"Reading LiteLLM [redacted]..."
				);
				await assertRefused(
					invokeLive(spies, "setSetting", {
						setting: "chat.timeout",
						value: 1,
						"http://u:parse-password@host": true,
					}),
					"setSetting",
					"malformed input",
					(message) =>
						assert.strictEqual(
							message,
							`The ${name("setSetting")} tool input is malformed: (input): Unrecognized key: "http://host"`
						)
				);
				const result = resultJson(await invokeLive(spies, "configuration", { sections: ["settings"] }));
				assert.deepStrictEqual(result, {
					settings: JSON.parse(
						JSON.stringify({
							...state.settings,
							modelParameters: { ...state.settings.modelParameters, value: { "[redacted]": { temperature: 0 } } },
						})
					),
				});
			});
			await withConfig({ ...ALL_WRITES, [AGENT_TOOL_TOGGLE_KEYS.setSetting]: false }, () =>
				assertRefused(
					invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }),
					"setSetting",
					"tool switched off",
					(message) =>
						assert.strictEqual(
							message,
							`The ${name("setSetting")} tool is switched off; the user [redacted] it with "${CONFIG_SECTION}.agentTools.setSetting.enabled".`
						)
				)
			);
		});
	});

	// A value THROWN instead of returned is an exit too: a dashboard that rejects with a string or a shape no renderer
	// can read, a settings reader that throws while the card is prepared. Each leaves as a freshly built Error whose
	// text passed the exit. A credential that enters the store DURING the call (a save landing it) is withheld by the
	// fresh read, the exit's third source.
	test("thrown values and a credential stored during the call leave through the exit too", async () => {
		const frozen = Object.freeze(new Error("Denied plain-key-Q7"));
		const cyclic: Record<string, unknown> = {};
		cyclic["plain-key-Q7"] = cyclic;
		const getterStack = new Error("Denied plain-key-Q7");
		Object.defineProperty(getterStack, "stack", { get: () => "Error: Denied plain-key-Q7", set: () => undefined });
		// A hostile Proxy: `instanceof` itself throws the secret, before any field is read.
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf: () => {
					throw new Error("Denied plain-key-Q7");
				},
			}
		);
		// A mirrored error whose mirror getter throws the secret while its classification stays readable.
		const mirrored = localizedError("Denied plain-key-Q7", "fixed mirror", "AgentTools(setSetting: probe)");
		Object.defineProperty(mirrored, "englishMessage", {
			get: () => {
				throw new Error("Mirror getter plain-key-Q7");
			},
		});
		const thrown: readonly {
			readonly title: string;
			readonly value: unknown;
			readonly message: string;
			readonly classification: string | undefined;
		}[] = [
			{ title: "a string", value: "Denied plain-key-Q7", message: "Denied [redacted]", classification: NON_ERROR },
			{ title: "a frozen Error", value: frozen, message: "Denied [redacted]", classification: undefined },
			{
				title: "an Error whose stack is a getter",
				value: getterStack,
				message: "Denied [redacted]",
				classification: undefined,
			},
			{
				title: "a cyclic object keyed by the secret",
				value: cyclic,
				message: "[object Object]",
				classification: NON_ERROR,
			},
			{
				title: "an object whose toJSON throws the secret",
				value: {
					toJSON: () => {
						throw new Error("Denied plain-key-Q7");
					},
				},
				message: "[object Object]",
				classification: NON_ERROR,
			},
			{ title: "a BigInt", value: 10n, message: "10", classification: NON_ERROR },
			{
				title: "a Proxy whose prototype trap throws the secret",
				value: hostile,
				message: "{}",
				classification: NON_ERROR,
			},
			{
				title: "a mirrored error whose mirror getter throws the secret",
				value: mirrored,
				message: "Denied [redacted]",
				classification: "AgentTools(setSetting: probe)",
			},
		];
		for (const { title, value, message, classification } of thrown) {
			await withWiringSpies(async (spies) => {
				const harness = await wireUnderTest(ALL_WRITES, { knownSecrets: ["plain-key-Q7"], submitThrows: value });
				await withConfig(ALL_WRITES, async () => {
					await assert.rejects(invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }), (error) => {
						assert.ok(error instanceof Error, `${title}: leaves as an Error`);
						assert.strictEqual(error.message, message, title);
						assert.ok(!String(error.stack).includes("plain-key-Q7"), `${title}: the stack is the exit's own`);
						if (classification === undefined) {
							assert.ok(!(error instanceof MirroredError), `${title}: a plain Error stays plain`);
						} else {
							assert.ok(error instanceof MirroredError, `${title}: classified`);
							assert.strictEqual(error.logClassification, classification, title);
						}
						return true;
					});
				});
				assertOmits(harness.lines.join("\n"), "plain-key-Q7", `${title}: the log never quotes the thrown text`);
			});
		}
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, {
				knownSecrets: ["plain-key-Q7"],
				inspectThrows: new Error("Denied plain-key-Q7"),
			});
			await withConfig(ALL_WRITES, async () => {
				await assert.rejects(prepareLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }), (error) => {
					assert.ok(error instanceof Error && !(error instanceof MirroredError), "a plain Error stays plain");
					assert.strictEqual(error.message, "Denied [redacted]");
					return true;
				});
			});
		});
		await withWiringSpies(async (spies) => {
			let landed = false;
			await wireUnderTest(ALL_WRITES, {
				settings: { [SERVERS_SETTING_KEY]: [{ label: "Prod", baseUrl: "http://prod.test" }] },
				secretStore: {
					get: async (key) =>
						landed && key === serverSecretsKey("Prod") ? JSON.stringify({ apiKey: "late-secret-Q7" }) : undefined,
					store: async () => undefined,
					delete: async () => undefined,
				},
				respond: () => {
					landed = true;
					return {
						outcome: "validation-error",
						reply: {
							kind: "fail",
							id: "x",
							method: "setNumberSetting",
							message: "Denied late-secret-Q7",
							failureKind: "operation",
						},
					};
				},
			});
			await withConfig(ALL_WRITES, async () => {
				const result = resultJson(await invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }));
				assert.deepStrictEqual(result, {
					method: "setNumberSetting",
					ok: false,
					failureKind: "operation",
					message: "Denied [redacted]",
				});
			});
		});
	});

	// The exits a fourth round of probes found open, closed by one conversion for every thrown value: a cancellation
	// leaves as a fresh one with no text and no log line; a log sink that throws stays inside; a mirrored error's
	// English mirror passes the fresh-read set like its display text; a prompt answer joins the exit set the moment
	// it is typed, so a later prompt that throws cannot quote it.
	test("a thrown cancellation, a failing log sink, a mirror, and a mid-prompt failure all leave converted", async () => {
		const cancellation = new vscode.CancellationError();
		cancellation.message = "Denied probe-secret-Q7";
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES, {
				knownSecrets: ["probe-secret-Q7"],
				submitThrows: cancellation,
			});
			await withConfig(ALL_WRITES, async () => {
				await assert.rejects(invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }), (error) => {
					assert.ok(error instanceof vscode.CancellationError, "cancellation stays a cancellation");
					assert.notStrictEqual(error, cancellation, "a fresh one, never the thrown object");
					assertOmits(String((error as Error).message), "probe-secret-Q7", "its text is dropped");
					return true;
				});
			});
			assert.deepStrictEqual(harness.lines, [], "cancellation is never logged");
		});
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES, {
				knownSecrets: ["probe-secret-Q7"],
				submitThrows: "Denied probe-secret-Q7",
				loggerThrows: true,
			});
			await withConfig(ALL_WRITES, async () => {
				await assertRefused(
					invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }),
					"setSetting",
					"non-error-throw",
					(message) => assert.strictEqual(message, "Denied [redacted]")
				);
			});
			assert.deepStrictEqual(harness.lines, [], "the sink's own failure went nowhere");
		});
		await withWiringSpies(async (spies) => {
			let landed = false;
			const harness = await wireUnderTest(ALL_WRITES, {
				settings: { [SERVERS_SETTING_KEY]: [{ label: "Prod", baseUrl: "http://prod.test" }] },
				secretStore: {
					get: async (key) =>
						landed && key === serverSecretsKey("Prod") ? JSON.stringify({ apiKey: "late-secret-Q7" }) : undefined,
					store: async () => undefined,
					delete: async () => undefined,
				},
				submitThrows: () => {
					landed = true;
					return new MirroredError("Display late-secret-Q7", { englishMessage: "English late-secret-Q7" });
				},
			});
			await withConfig(ALL_WRITES, async () => {
				await assert.rejects(invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }), (error) => {
					assert.ok(error instanceof MirroredError);
					assert.strictEqual(error.message, "Display [redacted]");
					assert.strictEqual(error.englishMessage, "English [redacted]");
					return true;
				});
			});
			assertOmits(harness.lines.join("\n"), "late-secret-Q7", "the mirror reached the channel redacted");
		});
		await withWiringSpies(async (spies) => {
			let asked = 0;
			await wireUnderTest(ALL_WRITES, {
				answerSecret: () => {
					asked += 1;
					if (asked === 1) {
						return "first-prompt-secret-Q7";
					}
					throw new Error("Rejected first-prompt-secret-Q7");
				},
			});
			await withConfig(ALL_WRITES, async () => {
				await assert.rejects(
					invokeLive(spies, "saveServer", {
						label: "Prod",
						virtualKeyHeader: "X-Private",
						secrets: {
							apiKey: { action: "set", location: "secure" },
							virtualKeyValue: { action: "set", location: "secure" },
						},
					}),
					(error) => {
						assert.ok(error instanceof Error);
						assert.strictEqual(error.message, "Rejected [redacted]");
						return true;
					}
				);
			});
			assert.strictEqual(asked, 2, "the second prompt is the one that threw");
		});
	});

	// A plain Error's message is the dashboard's or a response's text: the model gets it scrubbed, the log gets the
	// error's name alone (CLAUDE.md: logs carry classifications, never response-derived text).
	test("a plain Error's message reaches the model scrubbed and the log by name only", async () => {
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES, {
				submitThrows: new RangeError("Denied tenant alice@example.test"),
			});
			await withConfig(ALL_WRITES, async () => {
				await assert.rejects(invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }), (error) => {
					assert.ok(error instanceof Error && !(error instanceof MirroredError));
					assert.strictEqual(error.name, "RangeError");
					assert.strictEqual(error.message, "Denied tenant alice@example.test");
					return true;
				});
			});
			assertOmits(harness.lines.join("\n"), "alice@example.test", "the log carries the name, never the text");
			assert.ok(
				harness.lines.some((line) => line.includes("RangeError")),
				"the error's name is what the log records"
			);
		});
	});

	// The card's exit reads the store again after the card is built (a value landing while a setting is inspected is
	// in the card's "before"), and a mirrored error's classification passes the exit like its two messages.
	test("a value stored during card preparation and a classification carrying a value both leave redacted", async () => {
		await withWiringSpies(async (spies) => {
			let landed = false;
			await wireUnderTest(ALL_WRITES, {
				settings: {
					[SERVERS_SETTING_KEY]: [{ label: "Prod", baseUrl: "http://prod.test" }],
					"usage.currencySymbol": "card-late-secret-Q7",
				},
				secretStore: {
					get: async (key) =>
						landed && key === serverSecretsKey("Prod") ? JSON.stringify({ apiKey: "card-late-secret-Q7" }) : undefined,
					store: async () => undefined,
					delete: async () => undefined,
				},
				onInspect: () => {
					landed = true;
				},
			});
			await withConfig(ALL_WRITES, async () => {
				const prepared = await prepareLive(spies, "setSetting", { setting: "usage.currencySymbol", value: "$" });
				assert.strictEqual(
					cardText(prepared),
					[
						"```",
						"litellm-vscode-chat.usage.currencySymbol  (configured in: global)",
						'before: "[redacted]"',
						'after:  "$"',
						"```",
					].join("\n")
				);
			});
		});
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES, {
				knownSecrets: ["class-secret-Q7"],
				submitThrows: new MirroredError("Denied", {
					englishMessage: "fixed mirror",
					logClassification: "class-secret-Q7",
				}),
			});
			await withConfig(ALL_WRITES, async () => {
				await assert.rejects(invokeLive(spies, "setSetting", { setting: "chat.timeout", value: 1 }), (error) => {
					assert.ok(error instanceof MirroredError);
					assert.strictEqual(error.logClassification, "[redacted]");
					return true;
				});
			});
			assertOmits(harness.lines.join("\n"), "class-secret-Q7", "the classification reached the log redacted");
		});
	});

	// A value the user types into the masked prompt is a value the exit withholds from then on, before any store
	// holds it: a submit that fails may quote it back. A store that cannot be read fails the call closed with fixed
	// text, since the read error itself could carry a URL.
	test("a prompted value is withheld from a failing reply, and an unreadable store refuses with fixed text", async () => {
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, {
				answerSecret: () => "fresh-secret-Q7",
				respond: () => ({
					outcome: "validation-error",
					reply: {
						kind: "fail",
						id: "x",
						method: "saveServerSetting",
						message: "Rejected credential fresh-secret-Q7",
						failureKind: "operation",
					},
				}),
			});
			await withConfig(ALL_WRITES, async () => {
				const result = resultJson(
					await invokeLive(spies, "saveServer", {
						label: "Prod",
						secrets: { apiKey: { action: "set", location: "secure" } },
					})
				);
				assert.deepStrictEqual(result, {
					method: "saveServerSetting",
					ok: false,
					failureKind: "operation",
					message: "Rejected credential [redacted]",
				});
			});
		});
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, {
				settings: { [SERVERS_SETTING_KEY]: [{ label: "Prod", baseUrl: "http://prod.test" }] },
				secretStore: {
					get: () => Promise.reject(new Error("Storage failed at http://u:read-secret-Q7@host")),
					store: async () => undefined,
					delete: async () => undefined,
				},
			});
			await withConfig(ALL_WRITES, async () => {
				const fixed = "The secret store could not be read, so the tool cannot answer safely; call again.";
				await assertRefused(
					invokeLive(spies, "configuration", {}),
					"configuration",
					"secret store unreadable",
					(message) => assert.strictEqual(message, fixed)
				);
				await assert.rejects(
					prepareLive(spies, "saveServer", { label: "Prod", baseUrl: "http://new.test" }),
					(error) => {
						assert.ok(error instanceof MirroredError);
						assert.strictEqual(error.message, fixed);
						return true;
					}
				);
			});
		});
	});

	test("a refusal names the agent's identifier to the agent and only the classification to the log", async () => {
		// The setting key is agent-controlled text: the agent needs it back to fix the call, but the log feeds the
		// public issue report.
		const marker = "SYNTHETIC_INPUT_MARKER";
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest(ALL_WRITES);
			await withConfig(ALL_WRITES, () =>
				assertRefused(
					invokeLive(spies, "setSetting", { setting: marker, value: 1 }),
					"setSetting",
					"unknown-setting",
					(message) => assert.match(message, new RegExp(marker))
				)
			);
			const failures = harness.lines.filter((line) => line.startsWith("ERROR: Agent tool setSetting failed"));
			assert.strictEqual(failures.length, 1, "one failure line per refusal");
			assert.match(failures[0] as string, /AgentTools\(setSetting: unknown-setting\)/);
			// Every line, the stack trace's swapped first line included.
			for (const line of harness.lines) {
				assertOmits(line, marker, "agent-typed text never reaches the log");
			}
		});
	});

	test("a set_setting the planner refuses gets no card, so the servers setting's inline keys are never rendered", async () => {
		const inlineKey = "sk-inline-in-servers";
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, {
				settings: { servers: [{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: inlineKey } }] },
			});
			await withConfig(ALL_WRITES, async () => {
				const prepared = await prepareLive(spies, "setSetting", { setting: "servers", value: null });
				assert.strictEqual(prepared.confirmationMessages, undefined, "a refused plan shows no card");
				assertOmits(JSON.stringify(prepared), inlineKey, "the current value is not read into anything returned");
			});
		});
	});

	// The exit's one pass sees the ORIGINAL text with the fresh set: a value the fresh read adds ("tok-1234-tail")
	// whose head an older value matched ("tok-1234") leaves whole, never as "[redacted]-tail" from an earlier pass.
	test("a refusal and a card are redacted once, at the exit, with the fresh set", async () => {
		const settings = { [SERVERS_SETTING_KEY]: [{ label: "Prod", baseUrl: "http://prod.test" }] };
		const lateStore = (): SecretStore => {
			let reads = 0;
			return {
				get: async (key) =>
					++reads > 1 && key === serverSecretsKey("Prod") ? JSON.stringify({ apiKey: "tok-1234-tail" }) : undefined,
				store: async () => undefined,
				delete: async () => undefined,
			};
		};
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, { knownSecrets: ["tok-1234"], settings, secretStore: lateStore() });
			await withConfig(ALL_WRITES, async () => {
				await assertRefused(
					invokeLive(spies, "inspectModel", { server: "tok-1234-tail", model: "missing" }),
					"inspectModel",
					"model-not-found",
					(message) =>
						assert.strictEqual(
							message,
							'Server "[redacted]" serves no model "missing". Read the configuration tool\'s "models" section.'
						)
				);
			});
		});
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, { knownSecrets: ["tok-1234"], settings, secretStore: lateStore() });
			await withConfig(ALL_WRITES, async () => {
				const card = cardText(
					await prepareLive(spies, "saveServer", { label: "tok-1234-tail", baseUrl: "http://new.test" })
				);
				assert.ok(card.includes('new servers entry "[redacted]"'), card);
				assertOmits(card, "-tail", "the value leaves whole, not as its older head");
			});
		});
	});

	// Every prepareInvocation leaves through the one exit: a read tool's progress line passes the fresh read like a
	// card does, and an unreadable store refuses the read tool with the fixed text.
	test("a read tool's progress line takes the fresh read, and an unreadable store refuses it", async () => {
		const prod = [{ label: "Prod", baseUrl: "http://prod.test" }];
		await withWiringSpies(async (spies) => {
			let reads = 0;
			await wireUnderTest(ALL_WRITES, {
				settings: { [SERVERS_SETTING_KEY]: prod },
				secretStore: {
					// The first read is the initial one; the blob lands before the fresh read that the text leaves with.
					get: async (key) =>
						++reads > 1 && key === serverSecretsKey("Prod") ? JSON.stringify({ apiKey: "configuration" }) : undefined,
					store: async () => undefined,
					delete: async () => undefined,
				},
			});
			await withConfig(ALL_WRITES, async () => {
				assert.strictEqual(
					(await prepareLive(spies, "configuration", {})).invocationMessage,
					"Reading LiteLLM [redacted]..."
				);
			});
		});
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, {
				settings: { [SERVERS_SETTING_KEY]: prod },
				secretStore: {
					get: async () => {
						throw new Error("store exploded at http://u:store-pass@host.test");
					},
					store: async () => undefined,
					delete: async () => undefined,
				},
			});
			await withConfig(ALL_WRITES, async () => {
				await assertRefused(
					prepareLive(spies, "configuration", {}),
					"configuration",
					"secret store unreadable",
					(message) =>
						assert.strictEqual(
							message,
							"The secret store could not be read, so the tool cannot answer safely; call again."
						)
				);
			});
		});
	});

	// A rejected entry (two auth forms at once) still holds a secret, and its raw label and baseUrl reach the
	// misconfigured row the configuration result shows; the exit set holds its values like an accepted entry's.
	test("a rejected entry's inline key never reaches the model, even duplicated into the misconfigured row's URL", async () => {
		const fixture = agentToolsState();
		const state: DashboardState = {
			...fixture,
			servers: [
				...fixture.servers,
				{
					label: "Broken",
					baseUrl: "plain-key-Q7",
					servedModelCount: 0,
					credentials: "absent",
					hasOAuth: false,
					origin: "misconfigured",
					problems: ["has auth.apiKey beside auth.oauth; move it to auth.oauth.apiKey"],
					state: "error",
					error: "misconfigured entry; not used until its configuration is fixed",
					errorEnglish: "misconfigured entry; not used until its configuration is fixed",
				},
			],
		};
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES, {
				state,
				settings: {
					[SERVERS_SETTING_KEY]: [
						{ label: "Broken", baseUrl: "plain-key-Q7", auth: { apiKey: "plain-key-Q7", oauth: {} } },
					],
				},
			});
			await withConfig(ALL_WRITES, async () => {
				const result = resultJson(await invokeLive(spies, "configuration", { sections: ["servers"] }));
				assertOmits(JSON.stringify(result), "plain-key-Q7", "a rejected entry's key is in the exit set");
				const rows = (result as { servers: { label: string; baseUrl: string }[] }).servers;
				assert.strictEqual(
					rows.find((row) => row.label === "Broken")?.baseUrl,
					"[redacted]",
					"the misconfigured row keeps its place, its URL text redacted"
				);
			});
		});
	});

	test("an adoption card names the source group, the new label, and where each copied secret lands", async () => {
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES);
			await withConfig(ALL_WRITES, async () => {
				const prepared = await prepareLive(spies, "saveServer", {
					label: "Imported",
					adoptFrom: { label: "Copilot", baseUrl: COPILOT_BASE_URL },
					secretLocations: { apiKey: "settings" },
				});
				assert.match(String(prepared.confirmationMessages?.title), /Copilot.*Imported/);
				const card = cardText(prepared);
				assert.match(card, /provider group "Copilot" at http:\/\/copilot\.example:4000 as servers entry "Imported"/);
				assert.match(card, /apiKey: copied to settings storage/);
				// The fields the agent did not place take the secure default.
				assert.match(card, /oauthClientSecret: copied to secure storage/);
				// A stored URL with credentials: the agent only saw the credential-free form, so the card resolves the
				// stored group and says what it carries.
				const credentialed = cardText(
					await prepareLive(spies, "saveServer", {
						label: "Imported2",
						adoptFrom: { label: "Cred", baseUrl: CRED_DISPLAY_URL },
					})
				);
				assert.match(credentialed, /the stored URL carries credentials the card does not show/);
				assert.doesNotMatch(credentialed, /old-pass/);
				// A source the planner cannot find gets no card: the refusal reaches the agent without asking the user
				// to approve nothing.
				const missing = await prepareLive(spies, "saveServer", {
					label: "Imported",
					adoptFrom: { label: "Missing", baseUrl: "http://missing.test" },
				});
				assert.strictEqual(missing.confirmationMessages, undefined, "no card for a refused adoption");
			});
		});
	});

	suite("live host registration", () => {
		const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);

		/**
		 * Write `key` to the user scope and wait for the configuration event itself: the production listener registers
		 * inside it, and a listener attached later runs after. A bounded fallback keeps a coalesced event from hanging
		 * the suite; a registration that still did not happen fails the invoke with the host's own tool-not-found.
		 */
		const writeGlobal = async (key: string, value: unknown): Promise<void> => {
			const settled = new Promise<void>((resolve) => {
				const listener = vscode.workspace.onDidChangeConfiguration((event) => {
					if (event.affectsConfiguration(`${CONFIG_SECTION}.${key}`)) {
						listener.dispose();
						resolve();
					}
				});
				setTimeout(() => {
					listener.dispose();
					resolve();
				}, 2000);
			});
			await config().update(key, value, vscode.ConfigurationTarget.Global);
			await settled;
		};

		suiteSetup(async () => {
			await writeGlobal("agentTools.enabled", true);
		});

		suiteTeardown(async () => {
			await config().update("agentTools.enabled", undefined, vscode.ConfigurationTarget.Global);
		});

		test("the configuration read answers an lm.invokeTool call with the sections asked for", async () => {
			const result = await Promise.resolve(
				vscode.lm.invokeTool(
					name("configuration"),
					{ toolInvocationToken: undefined, input: { sections: ["settings"] } },
					new vscode.CancellationTokenSource().token
				)
			);
			const json = resultJson(result) as Record<string, unknown>;
			assert.ok(Object.hasOwn(json, "settings"), "the asked-for section is present");
			assert.ok(!Object.hasOwn(json, "servers"), "an unasked section is absent");
		});

		test("a write whose toggle is off has no registration: the host refuses the call before the tool could", async () => {
			// vscode.lm.tools lists every CONTRIBUTION whatever its when clause says (the consult suite found the
			// same), so the picker proves nothing here. Inputs each schema accepts, so a host-side schema rejection
			// cannot be what fails the call.
			//
			//   an unregistered name                  -> fails inside the host with its missing-implementation text
			//   a tool registered without its toggle  -> would answer with its own "switched off" refusal
			const validInputs: Record<AgentToolId, object> = {
				diagnostics: {},
				configuration: {},
				inspectModel: { server: "Prod", model: "gpt-test" },
				searchCatalog: { query: "gpt" },
				setSetting: { setting: "chat.timeout", value: 1 },
				editModelRecords: { kind: "parameters", key: "gpt-*", set: { temperature: 0 } },
				saveServer: NEW_SERVER,
				removeServer: { action: "remove", label: "Prod" },
				runAction: { action: "syncModels" },
			};
			for (const id of WRITE_IDS) {
				await assert.rejects(
					Promise.resolve(
						vscode.lm.invokeTool(
							name(id),
							{ toolInvocationToken: undefined, input: validInputs[id] },
							new vscode.CancellationTokenSource().token
						)
					),
					(error: unknown) => {
						// The host's own missing-tool text, not merely "not our refusal": a dropped RPC connection must
						// not read as an unregistered tool.
						assert.match(
							String((error as Error).message),
							/does not have an implementation registered/,
							`${name(id)} must not be registered while its toggle is off`
						);
						return true;
					}
				);
			}
		});

		test("a write round-trips through the real controller into the user scope and back out", async () => {
			// The fake-controller tests cannot see a break in the real submit path (the frame, the serialized channel,
			// the settings access's scope pick) because the webview never exercises it for an external caller; only a
			// real write does.
			const key = "live-agent-test-model";
			const setting = "models.capabilities";
			const globalValue = () =>
				config().inspect<Record<string, unknown>>(setting)?.globalValue as Record<string, unknown> | undefined;
			const original = globalValue();
			const { [key]: _stale, ...others } = original ?? {};
			const edit = (input: object) =>
				Promise.resolve(
					vscode.lm.invokeTool(
						name("editModelRecords"),
						{ toolInvocationToken: undefined, input },
						new vscode.CancellationTokenSource().token
					)
				);
			try {
				await writeGlobal(AGENT_TOOL_TOGGLE_KEYS.editModelRecords, true);
				if (original !== undefined && Object.hasOwn(original, key)) {
					await config().update(setting, others, vscode.ConfigurationTarget.Global);
				}

				const added = await edit({ kind: "capabilities", key, set: { context_length: 123456 } });
				assert.deepStrictEqual(resultJson(added), { method: "setModelCapabilities", ok: true });
				assert.deepStrictEqual(
					globalValue(),
					{ ...others, [key]: { context_length: 123456 } },
					"the record landed in the user scope beside every pre-existing key"
				);

				const removed = await edit({ kind: "capabilities", key, removeKey: true });
				assert.deepStrictEqual(resultJson(removed), { method: "setModelCapabilities", ok: true });
				assert.deepStrictEqual(globalValue(), others, "the key is gone and the rest is untouched");
			} finally {
				// The feature switch is the suite's; suiteTeardown restores it.
				await config().update(setting, original, vscode.ConfigurationTarget.Global);
				await config().update(AGENT_TOOL_TOGGLE_KEYS.editModelRecords, undefined, vscode.ConfigurationTarget.Global);
			}
		});
	});
});
