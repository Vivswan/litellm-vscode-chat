/**
 * Robustness fuzz over the agent tools' pure core: whatever an agent sends,
 * the envelope parse and the planner never throw, a plan only ever names a
 * dashboard method the tools may reach, every planned request is at least
 * frame-valid to the dashboard's own parser, and the renderers never throw
 * on the values they are handed. Seeded through the repo's fuzz seed so a
 * failure replays; a shrunk counterexample becomes a pinned case in the
 * sibling suites.
 */
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { DASHBOARD_ENDPOINTS } from "../../../../../dashboard/endpoints";
import { parseDashboardRequest } from "../../../../../extension/dashboard/intentSchema";
import { parseAgentToolInput } from "../../../../../extension/features/agentTools/inputSchema";
import type { ToolPlan } from "../../../../../extension/features/agentTools/planner";
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
	describeRecordChange,
	describeServerChange,
	describeSettingChange,
	refusalText,
	renderJson,
	shapeConfiguration,
	shapeSubmission,
} from "../../../../../extension/features/agentTools/render";
import { AGENT_TOOL_IDS, type AgentToolId } from "../../../../../shared/config/commandIds";
import { ALL_SETTING_KEYS } from "../../../../../shared/config/settingSpec";
import { resolveFuzzSeed } from "../../../../fuzzStream";
import { agentToolsState, COPILOT_BASE_URL } from "./fixture";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();
const state = agentToolsState();

/** The methods a plan may name; the excluded four are the type-level fence the planner keeps. */
const REACHABLE = new Set(
	Object.keys(DASHBOARD_ENDPOINTS).filter(
		(method) => !["ready", "readInlineSecrets", "executeCommand", "revealSetting"].includes(method)
	)
);

const labelArb = fc.oneof(
	fc.constantFrom("Prod", "Oauth", "Staging", "Copilot", "Twin", "Cred", "Old", "Nope"),
	fc.string({ minLength: 1, maxLength: 40 })
);
const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
const clearable = optional(fc.oneof(fc.constant(null), fc.string({ maxLength: 40 })));
const directiveArb = fc.oneof(
	fc.record({ action: fc.constant("keep" as const) }),
	fc.record({ action: fc.constant("clear" as const) }),
	fc.record({
		action: fc.constant("set" as const),
		location: fc.constantFrom("settings", "secure"),
		value: optional(fc.string({ minLength: 1, maxLength: 20 })),
	})
);
const secretsArb = optional(
	fc.record(
		{
			apiKey: optional(directiveArb),
			oauthClientSecret: optional(directiveArb),
			virtualKeyValue: optional(directiveArb),
		},
		{ requiredKeys: [] }
	)
);

/** Inputs shaped like each tool's grammar, plus arbitrary JSON so the parse itself is exercised. */
const shapedInput: Record<AgentToolId, fc.Arbitrary<unknown>> = {
	diagnostics: fc.record({ includeLogs: optional(fc.boolean()) }, { requiredKeys: [] }),
	configuration: fc.record(
		{
			sections: optional(
				fc.array(fc.constantFrom("servers", "settings", "models", "hiddenGroups", "catalog", "usage"))
			),
		},
		{ requiredKeys: [] }
	),
	inspectModel: fc.record({ server: labelArb, model: fc.oneof(fc.constantFrom("gpt-test", "claude"), fc.string()) }),
	searchCatalog: fc.record({ query: fc.string({ maxLength: 40 }) }),
	setSetting: fc.record({
		setting: fc.oneof(fc.constantFrom(...ALL_SETTING_KEYS), fc.string({ maxLength: 40 })),
		value: fc.jsonValue(),
	}),
	editModelRecords: fc.record(
		{
			kind: fc.constantFrom("capabilities", "parameters"),
			key: fc.oneof(fc.constantFrom("gpt-test", "gpt-5*", "*"), fc.string({ maxLength: 40 })),
			set: optional(fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue())),
			unset: optional(fc.array(fc.string({ maxLength: 20 }))),
			removeKey: optional(fc.boolean()),
			server: optional(labelArb),
		},
		{ requiredKeys: ["kind", "key"] }
	),
	saveServer: fc.oneof(
		fc.record(
			{
				label: labelArb,
				adoptFrom: fc.record({ label: labelArb, baseUrl: fc.constantFrom(COPILOT_BASE_URL, "http://nowhere.test") }),
				secretLocations: optional(
					fc.record(
						{
							apiKey: optional(fc.constantFrom("settings", "secure")),
							oauthClientSecret: optional(fc.constantFrom("settings", "secure")),
							virtualKeyValue: optional(fc.constantFrom("settings", "secure")),
						},
						{ requiredKeys: [] }
					)
				),
			},
			{ requiredKeys: ["label", "adoptFrom"] }
		),
		fc.record(
			{
				label: labelArb,
				baseUrl: optional(fc.oneof(fc.constant("http://prod.test"), fc.webUrl(), fc.string({ maxLength: 40 }))),
				apiVersion: clearable,
				oauthTokenUrl: clearable,
				oauthClientId: clearable,
				oauthScopes: clearable,
				virtualKeyHeader: clearable,
				headers: optional(fc.jsonValue()),
				declaredModels: optional(fc.jsonValue()),
				expectedFailures: optional(fc.jsonValue()),
				modelCapabilities: optional(fc.jsonValue()),
				modelParameters: optional(fc.jsonValue()),
				budget: optional(fc.jsonValue()),
				mcp: optional(fc.jsonValue()),
				secrets: secretsArb,
				renameFrom: optional(labelArb),
			},
			{ requiredKeys: ["label"] }
		)
	),
	removeServer: fc.oneof(
		fc.record({ action: fc.constant("remove"), label: labelArb }),
		fc.record({
			action: fc.constantFrom("hide", "unhide"),
			label: labelArb,
			baseUrl: fc.constantFrom(
				COPILOT_BASE_URL,
				"http://old.test",
				"http://old2.test/",
				"http://moved.test",
				"http://nowhere.test"
			),
		})
	),
	runAction: fc.oneof(
		fc.record({ action: fc.constant("testConnection"), label: labelArb }),
		fc.record({
			action: fc.constant("testFeatureModel"),
			feature: fc.constantFrom(
				"inlineCompletions",
				"commitGeneration",
				"prGeneration",
				"consultTool",
				"quickFix",
				"reviewComments"
			),
		}),
		fc.record({ action: fc.constantFrom("syncModels", "refreshCatalog", "refreshUsage") })
	),
};

function planFor(tool: AgentToolId, raw: unknown, acceptSecretValues: boolean): ToolPlan | undefined {
	const parsed = parseAgentToolInput(tool, raw);
	if (!parsed.ok) {
		return undefined;
	}
	switch (tool) {
		case "setSetting":
			return planSetSetting(parsed.input as never);
		case "editModelRecords":
			return planEditModelRecords(parsed.input as never, state);
		case "saveServer":
			return planSaveServer(parsed.input as never, state, acceptSecretValues);
		case "removeServer":
			return planRemoveServer(parsed.input as never, state);
		case "runAction":
			return planRunAction(parsed.input as never, state);
		case "inspectModel":
			return planInspectModel(parsed.input as never, state);
		default:
			return undefined;
	}
}

describe("agentTools core fuzz", () => {
	// Drifts silently: a planner branch that throws on an odd but envelope-valid
	// input would surface as an unclassified tool error in the agent's chat,
	// where no test reads it; a plan naming an unreachable method would bypass
	// the one fence between the agent and the dashboard's secret reads.
	test.each(AGENT_TOOL_IDS.map((tool) => [tool] as const))(
		"%s: parse and plan never throw, plans stay reachable and frame-valid",
		(tool) => {
			fc.assert(
				fc.property(fc.oneof(shapedInput[tool], fc.jsonValue()), fc.boolean(), (raw, acceptSecretValues) => {
					const plan = planFor(tool, raw, acceptSecretValues);
					if (plan === undefined) {
						return;
					}
					if (plan.kind === "refused") {
						expect(refusalText(plan.reason, plan.detail).length).toBeGreaterThan(0);
						return;
					}
					for (const planned of plan.requests) {
						expect(REACHABLE.has(planned.method)).toBe(true);
						const filled = withSecretValues(planned, {
							apiKey: "typed",
							oauthClientSecret: "typed",
							virtualKeyValue: "typed",
						});
						const parsed = parseDashboardRequest({
							kind: "request",
							id: "fuzz",
							method: filled.method,
							payload: filled.payload,
						});
						// The dashboard may refuse the VALUE (that is its job); the frame
						// and method must always be the planned ones.
						if (parsed.success) {
							expect(parsed.request.method).toBe(planned.method);
						} else {
							expect(parsed.frame?.method).toBe(planned.method);
						}
						expect(() => renderJson(shapeSubmission(filled, { outcome: "ok" }, (text) => text))).not.toThrow();
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS }
			);
		}
	);

	// Drifts silently: the cards render agent-written values; a value shape
	// that throws inside a card builder would abort the confirmation and land
	// nothing, with the agent seeing only an opaque error.
	test("renderers never throw on arbitrary values and stay within the reply bound", () => {
		fc.assert(
			fc.property(
				fc.jsonValue(),
				// Values past the reply bound included, so the cut is exercised on
				// generated input rather than on the fixture's fixed size.
				fc.oneof(fc.jsonValue(), fc.string({ minLength: 60_001, maxLength: 70_000 })),
				fc.string({ maxLength: 40 }),
				(before, after, key) => {
					expect(() => describeSettingChange(key, before, after, null)).not.toThrow();
					expect(() => describeRecordChange("capabilities", key, before, after, "global settings")).not.toThrow();
					const record = (value: unknown): Record<string, unknown> =>
						typeof value === "object" && value !== null && !Array.isArray(value)
							? (value as Record<string, unknown>)
							: { value };
					expect(() => describeServerChange(key, record(before), record(after), [], [])).not.toThrow();
					expect(renderJson(shapeConfiguration(state, undefined, (text) => text)).length).toBeLessThanOrEqual(60_000);
					expect(renderJson(after).length).toBeLessThanOrEqual(60_000);
				}
			),
			{ seed: SEED, numRuns: NUM_RUNS }
		);
	});
});
