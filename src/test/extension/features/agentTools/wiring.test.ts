/**
 * The agent tools' host surface: which tools are registered under which
 * switches, what an invoke refuses before anything reaches the dashboard,
 * what a landed write submits, what the confirmation cards spell out, and
 * what the masked secret prompt does. The planner's rules (routes, refusal
 * reasons, secret directives) live in the bun suites; this one pins what only
 * the host adapter decides: registration, the live-switch re-check, the
 * prompt, the log, and the result envelope.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DashboardSubmission } from "../../../../extension/dashboard/panel";
import type { SecretPrompt } from "../../../../extension/features/agentTools/planner";
import type { AgentToolsDeps } from "../../../../extension/features/agentTools/wiring";
import { wireAgentTools } from "../../../../extension/features/agentTools/wiring";
import { IssueReporter } from "../../../../extension/ui/issueReporter";
import type { AgentToolId } from "../../../../shared/config/commandIds";
import { AGENT_TOOL_IDS, AGENT_TOOLS } from "../../../../shared/config/commandIds";
import type { AgentWriteToolId } from "../../../../shared/config/settingSpec";
import {
	AGENT_TOOL_TOGGLE_KEYS,
	AGENT_TOOLS_SECRET_VALUES_KEY,
	CONFIG_SECTION,
} from "../../../../shared/config/settingSpec";
import { MirroredError } from "../../../../shared/mirroredError";
import { agentToolsState, COPILOT_BASE_URL } from "../../../bun/extension/features/agentTools/fixture";
import { assertOmits, makeLogger } from "../../../pureHelpers";
import { withConfig } from "../../../testUtils";
import type { WiringSpies } from "../wiringSpies";
import { fakeContext, withWiringSpies } from "../wiringSpies";

const name = (id: AgentToolId): string => AGENT_TOOLS[id].name;
const READ_IDS = AGENT_TOOL_IDS.filter((id) => AGENT_TOOLS[id].toggle === undefined);
const WRITE_IDS = AGENT_TOOL_IDS.filter((id) => AGENT_TOOLS[id].toggle !== undefined);
const WRITE_TOGGLES = Object.keys(AGENT_TOOL_TOGGLE_KEYS) as AgentWriteToolId[];

const FEATURE_ON = { "agentTools.enabled": true };

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
	/** Every frame the dashboard fake received, in order. */
	readonly submitted: FramedRequest[];
	/** Every masked prompt the wiring asked for, in order, with the token it was handed. */
	readonly prompts: {
		readonly prompt: SecretPrompt;
		readonly label: string;
		readonly token: vscode.CancellationToken;
	}[];
	/** The logger's channel lines; error lines carry the "ERROR: " prefix makeLogger adds. */
	readonly lines: string[];
}

interface HarnessOptions {
	/** The dashboard fake's verdict per frame; everything lands quietly by default. */
	readonly respond?: (request: FramedRequest) => DashboardSubmission;
	/** What the user types into the masked box; undefined is a cancel. */
	readonly answerSecret?: () => string | undefined;
	/** The settings the confirmation cards read current values from. */
	readonly settings?: Record<string, unknown>;
}

/** Wire the feature under `config` against fakes; the state is the bun fixture every agent-tools suite plans against. */
async function wireUnderTest(config: Record<string, unknown>, options: HarnessOptions = {}): Promise<Harness> {
	const context = fakeContext();
	const submitted: FramedRequest[] = [];
	const prompts: Harness["prompts"] = [];
	const { logger, lines } = makeLogger();
	const settings = options.settings ?? {};
	const deps: AgentToolsDeps = {
		dashboard: {
			readState: () => agentToolsState(),
			submit: async (raw) => {
				const framed = asFramed(raw);
				submitted.push(framed);
				return (options.respond ?? (() => ({ outcome: "ok" })))(framed);
			},
		},
		settings: {
			readEffective: (key) => settings[key],
			inspect: (key) => (Object.hasOwn(settings, key) ? { globalValue: settings[key] } : undefined),
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

/** The names registered and not yet disposed, in registration order. */
function liveNames(spies: WiringSpies): string[] {
	return spies.registrations.filter((record) => !record.disposed).map((record) => record.name);
}

function liveTool(spies: WiringSpies, id: AgentToolId): vscode.LanguageModelTool<unknown> {
	const record = spies.registrations.find((candidate) => !candidate.disposed && candidate.name === name(id));
	assert.ok(record !== undefined, `${name(id)} is registered`);
	return record.tool;
}

/** Invoke the recorded tool the way the host does: the live settings at call time decide, so callers wrap in withConfig. */
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

function prepareLive(spies: WiringSpies, id: AgentToolId, input: unknown): vscode.PreparedToolInvocation {
	const tool = liveTool(spies, id);
	assert.ok(tool.prepareInvocation !== undefined, `${name(id)} customizes its invocation`);
	const prepared = tool.prepareInvocation({ input }, new vscode.CancellationTokenSource().token);
	assert.ok(prepared != null && !("then" in prepared), "the card is prepared synchronously");
	return prepared;
}

/** The one text part an agent tool result carries, parsed: every result is JSON for the model. */
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

/** Assert `promise` rejects with the wiring's classified refusal for `id`. */
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
		// What drifts without this: a write registered without its toggle, a
		// read gated on a toggle, or a toggle that registers while the feature
		// switch is off.
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
				// The agent tools gate on plain settings, so the manifest's when
				// clauses need no context key and the wiring publishes none.
				assert.strictEqual(spies.contextStates.size, 0, `${title}: no context key`);
			});
		}
	});

	test("a configuration change disposes exactly what went off and registers exactly what came on", async () => {
		await withWiringSpies(async (spies) => {
			const harness = await wireUnderTest({ ...FEATURE_ON, ...toggles("setSetting") });
			const steps: { readonly config: Record<string, unknown>; readonly live: AgentToolId[] }[] = [
				// setSetting off: its registration goes, the reads stay.
				{ config: FEATURE_ON, live: [...READ_IDS] },
				// editModelRecords on: one new registration, nothing re-registered.
				{ config: { ...FEATURE_ON, ...toggles("editModelRecords") }, live: [...READ_IDS, "editModelRecords"] },
				// Feature off: everything goes, toggles notwithstanding.
				{ config: toggles("editModelRecords"), live: [] },
				{ config: ALL_WRITES, live: [...AGENT_TOOL_IDS] },
			];
			for (const [index, { config, live }] of steps.entries()) {
				await withConfig(config, () => {
					spies.fireConfigChange();
				});
				assert.deepStrictEqual(liveNames(spies), live.map(name), `step ${index + 1}`);
			}
			// 5 at wiring, +1 for editModelRecords, +9 after the feature came back: a
			// wiring that re-registered the untouched reads on every change would
			// count higher.
			assert.strictEqual(spies.registrations.length, 15, "untouched registrations are left alone");
			for (const subscription of harness.context.subscriptions) {
				subscription.dispose();
			}
			assert.deepStrictEqual(liveNames(spies), [], "deactivation releases every name");
		});
	});

	test("a switch flipped under a registered tool is refused by the invoke itself", async () => {
		// The configuration event races an in-flight agent turn: the registration
		// still stands, so the tool must answer the live settings.
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
			await withConfig({ ...ALL_WRITES, [AGENT_TOOLS_SECRET_VALUES_KEY]: true }, () => {
				for (const id of READ_IDS) {
					const prepared = prepareLive(spies, id, {});
					assert.ok(prepared.invocationMessage !== undefined, `${name(id)} shows progress`);
					// A read-only tool: a confirmation would interrupt every agent turn for nothing.
					assert.strictEqual(prepared.confirmationMessages, undefined, `${name(id)} asks no confirmation`);
				}

				const setting = prepareLive(spies, "setSetting", { setting: "chat.timeout", value: 60000 });
				assert.match(String(setting.confirmationMessages?.title), /chat\.timeout/);
				const settingCard = cardText(setting);
				assert.match(settingCard, /litellm-vscode-chat\.chat\.timeout {2}\(configured in: global\)/);
				assert.match(settingCard, /before: 300000/);
				assert.match(settingCard, /after: {2}60000/);

				const inline = prepareLive(spies, "saveServer", {
					...NEW_SERVER,
					secrets: { apiKey: { action: "set", location: "secure", value: "sk-inline" } },
				});
				const inlineCard = cardText(inline);
				assert.match(inlineCard, /new servers entry "New"/);
				assert.match(inlineCard, /apiKey: set \(secure\)/);
				assertOmits(inlineCard, "sk-inline", "the card names the secret's location, never its value");

				const prompted = prepareLive(spies, "saveServer", {
					...NEW_SERVER,
					secrets: { apiKey: { action: "set", location: "secure" } },
				});
				assert.match(cardText(prompted), /apiKey: you will be asked to type it \(stored in secure\)/);
			});
			// A plan that would refuse gets no card: the refusal is the invoke's to hand back.
			await withConfig(ALL_WRITES, () => {
				const refused = prepareLive(spies, "saveServer", {
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
			// The typed value is spliced into the directive; the fields the agent
			// did not name are cleared, because the entry is new.
			assert.deepStrictEqual(payload.secrets, {
				apiKey: { action: "set", location: "secure", value: "sk-typed" },
				oauthClientSecret: { action: "clear" },
				virtualKeyValue: { action: "clear" },
			});
			for (const line of harness.lines) {
				assertOmits(line, "sk-typed", "the typed value never reaches the log");
			}
		});

		// A dismissed box and an empty answer both cancel: an empty string must
		// never be stored as the key.
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
		// The token is the host's: a cancel that arrives already-set must never
		// reach the dashboard, and one that lands mid-plan must stop the plan
		// before its next request.
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
			// The model inspection is the plan that travels as TWO requests (the
			// capabilities read, then the parameters read).
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

	test("a refusal names the agent's identifier to the agent and only the classification to the log", async () => {
		// The setting key is agent-controlled text: the agent needs it back to
		// fix the call, but the log feeds the public issue report.
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
			await withConfig(ALL_WRITES, () => {
				const prepared = prepareLive(spies, "setSetting", { setting: "servers", value: null });
				assert.strictEqual(prepared.confirmationMessages, undefined, "a refused plan shows no card");
				assertOmits(JSON.stringify(prepared), inlineKey, "the current value is not read into anything returned");
			});
		});
	});

	test("an adoption card names the source group, the new label, and where each copied secret lands", async () => {
		await withWiringSpies(async (spies) => {
			await wireUnderTest(ALL_WRITES);
			await withConfig(ALL_WRITES, () => {
				const prepared = prepareLive(spies, "saveServer", {
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
			});
		});
	});

	/**
	 * The production wiring against the real host: with only the feature switch
	 * written for real, lm.invokeTool resolves a read tool to the extension's
	 * own registration and no write tool at all. The write toggles stay at
	 * their off default, so nothing this suite does can reach a real setting
	 * write.
	 */
	suite("live host registration", () => {
		const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);

		suiteSetup(async () => {
			// Wait for the configuration event itself: the production listener
			// registers inside it, and this listener was attached later, so it
			// runs after. A bounded fallback keeps a coalesced event from hanging
			// the suite; a registration that still did not happen fails the
			// invoke below with the host's own tool-not-found.
			const settled = new Promise<void>((resolve) => {
				const listener = vscode.workspace.onDidChangeConfiguration((event) => {
					if (event.affectsConfiguration(`${CONFIG_SECTION}.agentTools.enabled`)) {
						listener.dispose();
						resolve();
					}
				});
				setTimeout(() => {
					listener.dispose();
					resolve();
				}, 2000);
			});
			await config().update("agentTools.enabled", true, vscode.ConfigurationTarget.Global);
			await settled;
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
			// vscode.lm.tools lists every CONTRIBUTION whatever its when clause says
			// (the consult suite found the same), so the picker proves nothing
			// here. What is provable: an unregistered name fails inside the host
			// with its missing-implementation text, while a tool registered without
			// its toggle would answer with its own "switched off" refusal.
			// Inputs each schema accepts, so a host-side schema rejection cannot be
			// what fails the call.
			const validInputs: Record<AgentToolId, object> = {
				diagnostics: {},
				configuration: {},
				inspectModel: { server: "Prod", model: "gpt-test" },
				searchCatalog: { query: "gpt" },
				setSetting: { setting: "chat.timeout", value: 1 },
				editModelRecords: { kind: "parameters", key: "gpt-*", set: { temperature: 0 } },
				saveServer: NEW_SERVER,
				removeServer: { label: "Prod" },
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
						// The host's own missing-tool text, not merely "not our refusal":
						// a dropped RPC connection must not read as an unregistered tool.
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
	});
});
