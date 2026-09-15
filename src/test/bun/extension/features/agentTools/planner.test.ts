/**
 * The agent-tools planner against the dashboard's own request schema. Every
 * produced request is parsed by parseDashboardRequest, because a route that
 * builds a payload the dashboard refuses is a tool that silently never works;
 * the refusals pinned here are the ones a wrong branch would silently turn
 * into a write.
 */
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import type { SaveServerPayload, SecretDirective } from "../../../../../dashboard/endpoints";
import { parseDashboardRequest } from "../../../../../extension/dashboard/intentSchema";
import type { AgentToolInput } from "../../../../../extension/features/agentTools/inputSchema";
import { parseAgentToolInput } from "../../../../../extension/features/agentTools/inputSchema";
import type { AgentRequest, RefusalReason, ToolPlan } from "../../../../../extension/features/agentTools/planner";
import {
	planEditModelRecords,
	planInspectModel,
	planRemoveServer,
	planRunAction,
	planSaveServer,
	planSetSetting,
	withSecretValues,
} from "../../../../../extension/features/agentTools/planner";
import {
	describeServerChange,
	refusalText,
	renderJson,
	shapeSubmission,
} from "../../../../../extension/features/agentTools/render";
import {
	AGENT_TOOLS_SETTING_KEYS,
	ALL_SETTING_KEYS,
	BOOLEAN_SETTING_SPECS,
	FEATURE_MODEL_SETTING_KEY_LIST,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	NUMBER_SETTING_SPECS,
	SERVERS_SETTING_KEY,
} from "../../../../../shared/config/settingSpec";
import type { SecretFieldId } from "../../../../../shared/serverEntry";
import { resolveFuzzSeed } from "../../../../fuzzStream";
import {
	agentToolsState,
	COPILOT_BASE_URL,
	COPILOT_HANDLE,
	CRED_BASE_URL,
	CRED_DISPLAY_URL,
	CRED_HANDLE,
	PROD_CONFIG,
	PROD_LOCATIONS,
	TWIN_HANDLE,
} from "./fixture";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
const SEED = resolveFuzzSeed();

const state = agentToolsState();

/** The dashboard's own parse of one planned request, exactly as the wiring will submit it. */
function dashboardParse(request: AgentRequest) {
	return parseDashboardRequest({ kind: "request", id: "x", method: request.method, payload: request.payload });
}

function requestsOf(plan: ToolPlan): Extract<ToolPlan, { kind: "requests" }> {
	if (plan.kind !== "requests") {
		throw new Error(`expected requests, got refusal ${plan.reason} ${JSON.stringify(plan.detail)}`);
	}
	for (const request of plan.requests) {
		const parsed = dashboardParse(request);
		if (!parsed.success) {
			throw new Error(`${request.method} refused by the dashboard schema: ${JSON.stringify(parsed.issues)}`);
		}
	}
	return plan;
}

function refusalOf(plan: ToolPlan): { reason: RefusalReason; detail: Readonly<Record<string, string>> } {
	if (plan.kind !== "refused") {
		throw new Error(`expected a refusal, got ${JSON.stringify(plan.requests)}`);
	}
	return plan;
}

interface SavePayload {
	readonly server: SaveServerPayload;
	readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
	readonly replace?: Record<string, unknown> | undefined;
}

function savePayload(plan: ToolPlan): SavePayload {
	const { requests } = requestsOf(plan);
	expect(requests.map((request) => request.method)).toEqual(["saveServerSetting"]);
	return requests[0]?.payload as SavePayload;
}

const KEEP: SecretDirective = { action: "keep" };
const CLEAR: SecretDirective = { action: "clear" };
const KEEP_ALL = { apiKey: KEEP, oauthClientSecret: KEEP, virtualKeyValue: KEEP };
const CLEAR_ALL = { apiKey: CLEAR, oauthClientSecret: CLEAR, virtualKeyValue: CLEAR };

const PROD_REPLACE = { label: "Prod", baseUrl: "http://prod.test", apiVersion: "v2", secrets: PROD_LOCATIONS };

// ---------------------------------------------------------------------------

describe("agentTools planner set_setting", () => {
	/** A valid value per structured key; a spec key with no sample here fails the totality test below. */
	const STRUCTURED_SAMPLES: Readonly<Record<string, unknown>> = {
		"chat.additionalToolSchemaKeywords": ["format"],
		"chat.tokenEstimation": "heuristic",
		"usage.alertThresholds": [0.5],
		"usage.statusBar": "off",
		"usage.currencySymbol": "$",
		"ui.theme": "dark",
		"ui.accent": "teal",
		"inlineCompletions.languageFilter": { languages: ["python"] },
		"commitGeneration.prompt": "x",
		...Object.fromEntries(FEATURE_MODEL_SETTING_KEY_LIST.map((key) => [key, { server: "Prod", model: "m" }])),
		[SERVERS_SETTING_KEY]: [],
		[MODEL_CAPABILITIES_SETTING_KEY]: {},
		[MODEL_PARAMETERS_SETTING_KEY]: {},
	};

	function sampleFor(setting: string): unknown {
		if (setting in NUMBER_SETTING_SPECS) {
			return NUMBER_SETTING_SPECS[setting as keyof typeof NUMBER_SETTING_SPECS].default;
		}
		if (setting in BOOLEAN_SETTING_SPECS) {
			return true;
		}
		if (!(setting in STRUCTURED_SAMPLES)) {
			throw new Error(`no sample value for ${setting}: add one so the route is exercised`);
		}
		return STRUCTURED_SAMPLES[setting];
	}

	/** What the planner must do with each key; a key in neither table is routable and must parse. */
	const OWNED: Readonly<Record<string, string>> = {
		[SERVERS_SETTING_KEY]: "saveServer",
		[MODEL_CAPABILITIES_SETTING_KEY]: "editModelRecords",
		[MODEL_PARAMETERS_SETTING_KEY]: "editModelRecords",
	};
	const SWITCHES = new Set<string>(AGENT_TOOLS_SETTING_KEYS);

	// Drifts silently: a setting added to the spec without a route (it would
	// read as unknown-setting), or a route whose payload the dashboard refuses.
	test.each([...ALL_SETTING_KEYS] as string[])(
		"%s routes, refuses, or resets exactly as the dashboard schema accepts",
		(setting) => {
			const plan = planSetSetting({ setting, value: sampleFor(setting) });
			const reset = planSetSetting({ setting, value: null });
			if (SWITCHES.has(setting)) {
				expect(plan).toEqual({ kind: "refused", reason: "agent-tools-switch", detail: { setting } });
				expect(reset).toEqual(plan);
				return;
			}
			const owner = OWNED[setting];
			if (owner !== undefined) {
				expect(plan).toEqual({ kind: "refused", reason: "setting-owned-by-tool", detail: { setting, tool: owner } });
				expect(reset).toEqual(plan);
				return;
			}
			const { requests, prompts } = requestsOf(plan);
			expect(prompts).toEqual([]);
			expect(requests.length).toBe(1);
			expect(requestsOf(reset).requests).toEqual([{ method: "resetSetting", payload: { setting } }]);
		}
	);

	// Drifts silently: split into two requests, the second half's read-merge-
	// write would read a filter the first half just moved between scopes
	// (global allow/js, workspace allow/[] -> block/python ends as allow/python
	// globally). One half per call is the dashboard's own grammar.
	test("the language filter takes one half per call and refuses both at once", () => {
		expect(
			planSetSetting({ setting: "inlineCompletions.languageFilter", value: { mode: "allow", languages: ["python"] } })
		).toEqual({
			kind: "refused",
			reason: "language-filter-one-half",
			detail: { setting: "inlineCompletions.languageFilter" },
		});
		expect(
			requestsOf(planSetSetting({ setting: "inlineCompletions.languageFilter", value: { mode: "block" } })).requests
		).toEqual([{ method: "setLanguageFilter", payload: { mode: "block" } }]);
	});
});

// ---------------------------------------------------------------------------

describe("agentTools planner model records", () => {
	// Drifts silently: a route that patched `effective` (the scope-merged view)
	// would copy the workspace's "ws-*" record into the global scope.
	test.each([
		[
			"capabilities patch writes the whole edit-scope map, never the merged view",
			{ kind: "capabilities", key: "gpt-*", set: { reasoning: true } },
			{ method: "setModelCapabilities", payload: { value: { "gpt-*": { toolCalling: true, reasoning: true } } } },
		],
		[
			"parameters patch goes to its own intent",
			{ kind: "parameters", key: "claude-*", set: { top_k: 5 } },
			{
				method: "setModelParameters",
				payload: { value: { "gpt-*": { temperature: 1 }, "claude-*": { top_k: 5 } } },
			},
		],
	] as const)("%s", (_name, input, request) => {
		expect(requestsOf(planEditModelRecords(input, state)).requests).toEqual([request]);
	});

	// Drifts silently: an entry save that omitted a stored field would clear
	// it, because the dashboard schema reads absence as "none".
	test("a per-entry capabilities patch saves the stored entry with only that map changed, keeping every secret", () => {
		const payload = savePayload(
			planEditModelRecords(
				{ kind: "capabilities", key: "gpt-*", set: { vision: false, reasoning: true }, server: "Prod" },
				state
			)
		);
		expect(payload.server.modelCapabilities).toEqual({ "gpt-*": { vision: false, reasoning: true } });
		expect(payload.server.modelParameters).toEqual(PROD_CONFIG.modelParameters);
		expect(payload.server.headers).toEqual(PROD_CONFIG.headers);
		expect(payload.secrets).toEqual(KEEP_ALL);
		expect(payload.replace).toEqual(PROD_REPLACE);
	});
});

// ---------------------------------------------------------------------------

describe("agentTools planner save_server", () => {
	type Input = AgentToolInput<"saveServer">;

	test("a new entry starts with every secret cleared, empty lists, and no replace identity", () => {
		const payload = savePayload(planSaveServer({ label: "New", baseUrl: "http://new.test" }, state, false));
		expect(payload).toEqual({
			server: {
				label: "New",
				baseUrl: "http://new.test",
				modelCapabilities: {},
				expectedFailures: [],
				headers: {},
				declaredModels: [],
				budget: null,
				mcp: null,
			},
			secrets: CLEAR_ALL,
		});
	});

	// Drifts silently: an edit that omitted a field from the payload would
	// clear it, because the dashboard schema reads absence as "none".
	test("editing an existing entry carries every stored field, keeps every secret, and names the displayed identity", () => {
		const payload = savePayload(planSaveServer({ label: "Prod", budget: 40 }, state, false));
		expect(payload).toEqual({
			server: {
				label: "Prod",
				baseUrl: "http://prod.test",
				apiVersion: "v2",
				headers: PROD_CONFIG.headers,
				budget: 40,
				declaredModels: PROD_CONFIG.declaredModels,
				expectedFailures: PROD_CONFIG.expectedFailures,
				modelCapabilities: PROD_CONFIG.modelCapabilities,
				modelParameters: PROD_CONFIG.modelParameters,
				mcp: PROD_CONFIG.mcp,
			},
			secrets: KEEP_ALL,
			replace: PROD_REPLACE,
		});
	});

	// Drifts silently: the dashboard's save trims the label, so an untrimmed
	// " Prod " that missed the stored Prod here would overwrite it with
	// new-entry defaults and no replace identity, deleting its configuration.
	test("a whitespace-padded label still edits the stored entry it names", () => {
		const parsed = parseAgentToolInput("saveServer", { label: " Prod ", budget: 40 });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		const payload = savePayload(planSaveServer(parsed.input, state, false));
		expect(payload.server.label).toBe("Prod");
		expect(payload.server.headers).toEqual(PROD_CONFIG.headers);
		expect(payload.secrets).toEqual(KEEP_ALL);
		expect(payload.replace).toEqual(PROD_REPLACE);
	});

	// Drifts silently: null and absent collapse to the same thing in a naive
	// `??` merge, so a clear would keep the stored value.
	test("null clears a clearable field and a string sets it; the rename keeps the old identity in replace", () => {
		const payload = savePayload(
			planSaveServer({ label: "Prod2", renameFrom: "Prod", apiVersion: null, virtualKeyHeader: "X-Key" }, state, false)
		);
		expect(payload.server.label).toBe("Prod2");
		expect("apiVersion" in payload.server).toBe(false);
		expect(payload.server.virtualKeyHeader).toBe("X-Key");
		expect(payload.replace).toEqual(PROD_REPLACE);
	});

	// Drifts silently: the tool envelope judging entry fields would refuse or
	// admit shapes the dashboard decides differently; the dashboard is the judge.
	test.each([
		["an array header value", { "X-Retry": ["2"] }, false],
		["a scalar header value", { "X-Retry": 2 }, true],
	])("%s passes the tool envelope and the dashboard schema decides it", (_name, headers, accepted) => {
		const parsed = parseAgentToolInput("saveServer", { label: "Prod", headers });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		const plan = planSaveServer(parsed.input, state, false);
		expect(plan.kind).toBe("requests");
		if (plan.kind !== "requests") {
			return;
		}
		const verdict = dashboardParse(plan.requests[0] as AgentRequest);
		expect(verdict.success).toBe(accepted);
		if (!verdict.success) {
			expect(verdict.issues.map((issue) => issue.path)).toEqual(["payload.server.headers.X-Retry"]);
		}
	});

	test("a valueless set becomes one prompt and a placeholder the typed value later fills", () => {
		const plan = planSaveServer(
			{ label: "Prod", secrets: { apiKey: { action: "set", location: "secure" } } },
			state,
			false
		);
		const { requests, prompts } = requestsOf(plan);
		expect(prompts).toEqual([{ field: "apiKey", location: "secure" }]);
		const before = requests[0] as AgentRequest;
		expect((before.payload as SavePayload).secrets.apiKey).toEqual({ action: "set", location: "secure", value: "" });
		const after = withSecretValues(before, { apiKey: "sk-typed" });
		expect(dashboardParse(after).success).toBe(true);
		expect((after.payload as SavePayload).secrets).toEqual({
			...KEEP_ALL,
			apiKey: { action: "set", location: "secure", value: "sk-typed" },
		});
		// A value for a field whose directive is not `set` is dropped, not smuggled in.
		expect(withSecretValues(before, { oauthClientSecret: "leak" }).payload).toEqual(before.payload);
	});

	test.each([
		[
			"refused without the switch",
			false,
			{ kind: "refused", reason: "secret-value-refused", detail: { fields: "apiKey" } },
		],
		["accepted with the switch", true, { action: "set", location: "settings", value: "sk-inline" }],
	] as const)("a secret value in tool input is %s", (_name, accept, expected) => {
		const plan = planSaveServer(
			{ label: "Prod", secrets: { apiKey: { action: "set", location: "settings", value: "sk-inline" } } },
			state,
			accept
		);
		if (!accept) {
			expect(plan).toEqual(expected as ToolPlan);
			return;
		}
		expect(requestsOf(plan).prompts).toEqual([]);
		expect(savePayload(plan).secrets.apiKey).toEqual(expected as SecretDirective);
	});

	// Drifts silently: the destination rule per field. apiKey follows the
	// base URL, oauthClientSecret follows the token URL; a check on the base
	// URL alone would refuse the OAuth host move and allow the token URL move.
	test.each<[string, Input, "allowed" | { fields: string; label: string }]>([
		[
			"Prod host change with apiKey kept",
			{ label: "Prod", baseUrl: "http://other.test" },
			{ label: "Prod", fields: "apiKey" },
		],
		[
			"Prod host change with apiKey cleared",
			{ label: "Prod", baseUrl: "http://other.test", secrets: { apiKey: { action: "clear" } } },
			"allowed",
		],
		[
			"Prod host change with apiKey re-set (prompt)",
			{ label: "Prod", baseUrl: "http://other.test", secrets: { apiKey: { action: "set", location: "secure" } } },
			"allowed",
		],
		["Prod same host spelled with a trailing slash", { label: "Prod", baseUrl: "http://prod.test/" }, "allowed"],
		[
			"Oauth token URL change with the client secret kept",
			{ label: "Oauth", oauthTokenUrl: "http://token2.test/oauth" },
			{ label: "Oauth", fields: "oauthClientSecret" },
		],
		[
			"Oauth host change (client secret goes to the token URL, not the host)",
			{ label: "Oauth", baseUrl: "http://oauth2.test" },
			"allowed",
		],
	])("kept-secret destination: %s", (_name, input, expected) => {
		const plan = planSaveServer(input, state, false);
		if (expected === "allowed") {
			savePayload(plan);
			return;
		}
		expect(plan).toEqual({ kind: "refused", reason: "kept-secret-host-change", detail: expected });
	});

	// Drifts silently: two external groups can share a base URL; a URL-only
	// match would adopt (or hide) the first one's handle under the other's label.
	test.each([
		[
			"Copilot",
			COPILOT_HANDLE,
			undefined,
			{ apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
		],
		[
			"Twin",
			TWIN_HANDLE,
			{ apiKey: "settings" },
			{ apiKey: "settings", oauthClientSecret: "secure", virtualKeyValue: "secure" },
		],
	] as const)(
		"adopting %s at the shared base URL names its own handle",
		(label, handle, secretLocations, locations) => {
			const plan = planSaveServer(
				{ label: `${label}-adopted`, adoptFrom: { label, baseUrl: `${COPILOT_BASE_URL}/` }, secretLocations },
				state,
				false
			);
			expect(requestsOf(plan).requests).toEqual([
				{
					method: "adoptServer",
					payload: { label: `${label}-adopted`, baseUrl: COPILOT_BASE_URL, sourceHandle: handle, secrets: locations },
				},
			]);
		}
	);

	// Drifts silently: the adopt grammar is closed so the intent copies exactly
	// what the group holds; an edit field or a secret directive riding it would
	// be dropped without a word.
	test.each([
		["an edit field", { budget: 10 }],
		["a secrets directive", { secrets: { apiKey: { action: "set", location: "secure" } } }],
	])("an adopt call carrying %s fails the tool envelope", (_name, extra) => {
		const parsed = parseAgentToolInput("saveServer", {
			label: "X",
			adoptFrom: { label: "Copilot", baseUrl: COPILOT_BASE_URL },
			...extra,
		});
		expect(parsed.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------

describe("agentTools planner empty patches", () => {
	// Drifts silently: a patch naming a missing key with nothing to set would
	// mint "gpt-5": {}, and that more specific empty record wins the walk and
	// hides broader records' fields although the call asked for no edit.
	test("a patch with nothing to set on a missing key changes nothing and is refused", () => {
		expect(planEditModelRecords({ kind: "parameters", key: "gpt-5" }, state)).toEqual({
			kind: "refused",
			reason: "nothing-to-change",
			detail: { key: "gpt-5" },
		});
	});
});

describe("agentTools planner external groups by the URL the agent sees", () => {
	// Drifts silently: results render a URL without its userinfo, so an agent
	// that hands that URL back must still find the group whose stored URL has it.
	test("adopting and hiding a credentialed external group works with the displayed URL and keeps the stored one", () => {
		const adopted = planSaveServer(
			{ label: "Imported", adoptFrom: { label: "Cred", baseUrl: CRED_DISPLAY_URL } },
			state,
			false
		);
		expect(adopted.kind).toBe("requests");
		if (adopted.kind === "requests") {
			expect(adopted.requests[0]?.payload).toMatchObject({ sourceHandle: CRED_HANDLE, baseUrl: CRED_BASE_URL });
		}
		const hidden = planRemoveServer({ label: "Cred", baseUrl: CRED_DISPLAY_URL, action: "hide" }, state);
		expect(hidden.kind).toBe("requests");
		if (hidden.kind === "requests") {
			expect(hidden.requests[0]?.payload).toMatchObject({ sourceHandle: CRED_HANDLE, baseUrl: CRED_BASE_URL });
		}
	});
});

describe("agentTools planner remove_server, run_action, inspect_model", () => {
	test.each<[string, AgentToolInput<"removeServer">, AgentRequest]>([
		["remove a declared entry", { label: "Prod" }, { method: "removeServerSetting", payload: { label: "Prod" } }],
		[
			"hide the twin at the shared base URL picks its handle by label",
			{ label: "Twin", baseUrl: `${COPILOT_BASE_URL}/`, action: "hide" },
			{ method: "hideExternalServer", payload: { baseUrl: COPILOT_BASE_URL, sourceHandle: TWIN_HANDLE } },
		],
		[
			"unhide a hidden group echoes its stored identity",
			{ label: "Old", action: "unhide" },
			{ method: "unhideServer", payload: { label: "Old", baseUrl: "http://old.test" } },
		],
	])("remove_server: %s", (_name, input, request) => {
		expect(requestsOf(planRemoveServer(input, state)).requests).toEqual([request]);
	});

	// Drifts silently: an external-only label falling into the declared branch
	// would submit a removeServerSetting the dashboard then fails on.
	test("removing an external-only label is refused as not declared", () => {
		expect(refusalOf(planRemoveServer({ label: "Copilot" }, state)).reason).toBe("server-not-declared");
	});

	test.each<[string, AgentToolInput<"runAction">, AgentRequest]>([
		["syncModels", { action: "syncModels" }, { method: "syncModels", payload: null }],
		["refreshCatalog", { action: "refreshCatalog" }, { method: "refreshCatalog", payload: null }],
		["refreshUsage", { action: "refreshUsage" }, { method: "refreshUsage", payload: null }],
		[
			"testFeatureModel with a picked model",
			{ action: "testFeatureModel", feature: "commitGeneration" },
			{
				method: "testFeatureModel",
				payload: { feature: "commitGeneration", model: { server: "Prod", model: "gpt-test" } },
			},
		],
	])("run_action: %s", (_name, input, request) => {
		expect(requestsOf(planRunAction(input, state)).requests).toEqual([request]);
	});

	// Drifts silently: a probe built from agent-supplied fields would send the
	// kept key wherever the agent pointed it; the draft must be the stored entry.
	test("testConnection probes the STORED entry with every secret kept", () => {
		const { requests } = requestsOf(planRunAction({ action: "testConnection", label: "Prod" }, state));
		expect(requests.map((request) => request.method)).toEqual(["testServerDraft"]);
		const payload = requests[0]?.payload as SavePayload;
		expect(payload.server.baseUrl).toBe("http://prod.test");
		expect(payload.server.headers).toEqual(PROD_CONFIG.headers);
		expect(payload.secrets).toEqual(KEEP_ALL);
		expect(payload.replace).toEqual(PROD_REPLACE);
	});

	// Drifts silently: the reads are addressed by the model's opaque scope key,
	// so a lookup by label alone would resolve the wrong server's model.
	test("inspect_model yields both inspector reads under the served model's scope key", () => {
		const { requests } = requestsOf(planInspectModel({ server: "Copilot", model: "claude" }, state));
		expect(requests).toEqual([
			{ method: "readModelCapabilities", payload: { scopeKey: "scope-copilot", rawId: "claude" } },
			{ method: "readModelParameters", payload: { scopeKey: "scope-copilot", rawId: "claude" } },
		]);
	});
});

// ---------------------------------------------------------------------------

describe("agentTools planner secrets never reach rendered text", () => {
	const secretArb = fc.string({
		unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-_"),
		minLength: 12,
		maxLength: 64,
	});
	const fieldArb = fc.constantFrom<SecretFieldId>("apiKey", "oauthClientSecret", "virtualKeyValue");
	const identity = (text: string): string => text;

	// Drifts silently: a card, a refusal detail, or a submission echo that
	// spreads the payload's `secrets` instead of the location summary.
	test("a typed or inline secret value appears in no card, refusal, or submission text", () => {
		fc.assert(
			fc.property(secretArb, fieldArb, (secret, field) => {
				const base = savePayload(planSaveServer({ label: "Prod" }, state, false)).server;
				const inline = planSaveServer(
					{ label: "Prod", secrets: { [field]: { action: "set", location: "settings", value: secret } } },
					state,
					true
				);
				const request = requestsOf(inline).requests[0] as AgentRequest;
				const payload = request.payload as SavePayload;
				const summary = [`${field}: set (stored in settings)`];
				expect(describeServerChange("Prod", { ...base }, { ...payload.server }, summary, [])).not.toContain(secret);
				expect(JSON.stringify(payload.server)).not.toContain(secret);

				const prompted = planSaveServer(
					{ label: "Prod", secrets: { [field]: { action: "set", location: "secure" } } },
					state,
					false
				);
				const typed = withSecretValues(requestsOf(prompted).requests[0] as AgentRequest, { [field]: secret });
				expect(
					describeServerChange(
						"Prod",
						{ ...base },
						{ ...(typed.payload as SavePayload).server },
						[],
						requestsOf(prompted).prompts
					)
				).not.toContain(secret);

				const refusals = [
					planSaveServer(
						{ label: "Prod", secrets: { [field]: { action: "set", location: "settings", value: secret } } },
						state,
						false
					),
					planSaveServer(
						{
							label: "Prod",
							baseUrl: "http://moved.test",
							secrets: { virtualKeyValue: { action: "set", location: "settings", value: secret } },
						},
						state,
						true
					),
				];
				for (const plan of refusals) {
					const { reason, detail } = refusalOf(plan);
					expect(refusalText(reason, detail)).not.toContain(secret);
				}

				const submissions = [
					shapeSubmission(
						typed,
						{ outcome: "ok", reply: { kind: "ack", id: "x", method: "saveServerSetting" } },
						identity
					),
					shapeSubmission(
						typed,
						{
							outcome: "validation-error",
							reply: {
								kind: "fail",
								id: "x",
								method: "saveServerSetting",
								message: "The change was not applied.",
								failureKind: "validation",
							},
							issues: [{ path: "server.label", code: "too_big", message: "too long" }],
						},
						identity
					),
					shapeSubmission(typed, { outcome: "ignored-malformed", issues: [] }, identity),
				];
				for (const shaped of submissions) {
					expect(renderJson(shaped)).not.toContain(secret);
				}
			}),
			{ seed: SEED, numRuns: NUM_RUNS }
		);
	});
});
