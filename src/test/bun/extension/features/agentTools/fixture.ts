/**
 * The one dashboard state the agent-tools suites plan against. Built so every
 * planner rule has a row to trip on: a proven entry with stored config, an
 * OAuth entry whose secret's destination is the token URL rather than the
 * host, an unproven entry, two external groups sharing one base URL under
 * different labels (adoption and hiding must pick by label), a hidden
 * tombstone, and record settings whose `effective` view differs from the edit
 * scope's own `value` (the merge hazard planEditModelRecords must not fall into).
 */
import type { DashboardState } from "../../../../../dashboard/viewModels";
import { makeSettings } from "../../../../dashboardSettingsFixture";
import {
	declaredWithSecrets,
	makeExternalServer,
	makeModel,
	makeState,
	makeUnprovenServer,
} from "../../../webview/fixtures";

export const PROD_LOCATIONS = { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" } as const;
const OAUTH_LOCATIONS = { apiKey: "none", oauthClientSecret: "secure", virtualKeyValue: "none" } as const;
const OAUTH_TOKEN_URL = "http://token.test/oauth";
export const COPILOT_BASE_URL = "http://copilot.example:4000";
export const COPILOT_HANDLE = "handle-abc123";
export const TWIN_HANDLE = "handle-twin456";
/** An external group whose stored URL carries userinfo; the agent only ever sees CRED_DISPLAY_URL. */
export const CRED_BASE_URL = "http://alice:old-pass@cred.example:4000";
export const CRED_DISPLAY_URL = "http://cred.example:4000";
export const CRED_HANDLE = "handle-cred789";

export const PROD_CONFIG = {
	apiVersion: "v2",
	headers: { "X-Team": "platform" },
	budget: 25,
	declaredModels: ["decl-1"],
	expectedFailures: ["modelInfo"],
	modelCapabilities: { "gpt-*": { vision: true } },
	modelParameters: { "gpt-*": { temperature: 0.2 } },
	mcp: { url: "http://prod.test/mcp" },
} as const;

export function agentToolsState(): DashboardState {
	return makeState({
		servers: [
			declaredWithSecrets(PROD_LOCATIONS, {
				label: "Prod",
				baseUrl: "http://prod.test",
				config: { secrets: { kind: "proven", locations: PROD_LOCATIONS }, ...PROD_CONFIG },
			}),
			declaredWithSecrets(OAUTH_LOCATIONS, {
				label: "Oauth",
				baseUrl: "http://oauth.test",
				hasOAuth: true,
				config: {
					secrets: { kind: "proven", locations: OAUTH_LOCATIONS },
					oauthTokenUrl: OAUTH_TOKEN_URL,
					oauthClientId: "client-1",
				},
			}),
			makeUnprovenServer({ label: "Staging", baseUrl: "http://staging.test" }),
			makeExternalServer({ label: "Copilot", baseUrl: COPILOT_BASE_URL, adoptHandle: COPILOT_HANDLE }),
			makeExternalServer({ label: "Twin", baseUrl: COPILOT_BASE_URL, adoptHandle: TWIN_HANDLE }),
			makeExternalServer({ label: "Cred", baseUrl: CRED_BASE_URL, adoptHandle: CRED_HANDLE }),
		],
		hiddenGroups: [
			{ label: "Old", baseUrl: "http://old.test", reason: "removed" },
			{ label: "Old", baseUrl: "http://old2.test", reason: "removed" },
			{ label: "Moved", baseUrl: "http://moved.test", reason: "superseded", declaredBaseUrl: "http://moved.test/v1" },
		],
		models: [
			makeModel({ serverLabel: "Prod", rawId: "gpt-test", id: "gpt-test", scopeKey: "scope-prod" }),
			makeModel({ serverLabel: "Copilot", rawId: "claude", id: "claude", scopeKey: "scope-copilot" }),
		],
		settings: makeSettings({
			modelCapabilities: {
				editScope: "global",
				value: { "gpt-*": { toolCalling: true } },
				otherScopes: [{ scope: "workspace", value: { "ws-*": { reasoning: true } } }],
				effective: { "gpt-*": { toolCalling: true }, "ws-*": { reasoning: true } },
			},
			modelParameters: {
				editScope: "global",
				value: { "gpt-*": { temperature: 1 } },
				otherScopes: [{ scope: "workspace", value: { "ws-*": { top_p: 0.5 } } }],
				effective: { "gpt-*": { temperature: 1 }, "ws-*": { top_p: 0.5 } },
			},
			featureModels: { ...makeSettings().featureModels, commitGeneration: { server: "Prod", model: "gpt-test" } },
		}),
	});
}
