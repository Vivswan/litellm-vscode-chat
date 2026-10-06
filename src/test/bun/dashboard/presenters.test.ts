import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	classifyOverall,
	latestCheckedMs,
	overallStatusText,
	parseNumberDraft,
	servedModelsBreakdown,
	serverOutcomeParts,
	serverOutcomeText,
	zeroModelEnglishDetail,
	zeroModelExplanation,
} from "../../../dashboard/presenters";
import type { DashboardServer, VerdictRow } from "../../../dashboard/viewModels";
import type { CapabilityJsonValue } from "../../../shared/config/capabilityResolution";
import { capabilityField } from "../../../shared/config/capabilityResolution";
import type { NumberSettingId } from "../../../shared/config/settingSpec";
import { NUMBER_SETTING_SPECS } from "../../../shared/config/settingSpec";
import type { FailureCause } from "../../../shared/failureCause";

// Causes as the rows carry them (keys, never text); the pinned lines below are their English renderings.
const CONNECTION: FailureCause = { kind: "transport", classification: { kind: "connection" } };
const TIMEOUT: FailureCause = { kind: "transport", classification: { kind: "timeout" } };
const HTTP_404: FailureCause = { kind: "transport", classification: { kind: "http", status: 404 } };
const UPSERT_FAILED: FailureCause = { kind: "sync", failureClass: "upsertFailed" };
const PROD = "http://prod.test";

/**
 * These lines are what users copy out of the Diagnostics tab into issue reports, so the exact text is pinned once here
 * instead of per surface.
 */

type DeclaredServer = Extract<DashboardServer, { origin: "declared" }>;

function declaredServer(overrides: Partial<DeclaredServer> = {}): DashboardServer {
	const base: DeclaredServer = {
		origin: "declared",
		label: "Prod",
		baseUrl: "http://prod.test",
		servedModelCount: 0,
		credentials: "absent",
		hasOAuth: false,
		hasVirtualKey: false,
		state: "ok",
		config: {
			secrets: { kind: "proven", locations: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } },
		},
	};
	return { ...base, ...overrides } as DeclaredServer;
}

function misconfiguredServer(problems: readonly string[]): DashboardServer {
	return {
		origin: "misconfigured",
		label: "Broken",
		baseUrl: "http://broken.test",
		servedModelCount: 0,
		credentials: "absent",
		hasOAuth: false,
		hasVirtualKey: false,
		state: "error",
		problems,
		cause: { kind: "misconfiguredEntry" },
	};
}

describe("dashboard/presenters renderers", () => {
	describe("overallStatusText", () => {
		// The host's published verdict rows (verdictRows): one per window status, unchecked entry, or refused entry.
		const row = (overrides: Partial<VerdictRow> = {}): VerdictRow => ({
			state: "ok",
			servedModelCount: 0,
			...overrides,
		});
		const failed = (cause: FailureCause, overrides: Partial<VerdictRow> = {}): VerdictRow =>
			row({ state: "error", failure: { cause, baseUrl: PROD }, ...overrides });
		const MISCONFIGURED = failed({ kind: "misconfiguredEntry" }, { misconfigured: true });

		test("nothing configured anywhere reads as not configured", () => {
			assert.strictEqual(overallStatusText([], 0), "Not configured");
		});

		test("connected with zero models names the empty listings through the one English detail", () => {
			assert.strictEqual(
				overallStatusText([row()], 0),
				"Connected, but 0 models are served (answered with an empty listing)"
			);
		});

		test("hidden groups alone read as the connected zero-model warning, never as not configured", () => {
			// Hidden groups leave the servers table, but they are answering configuration the user chose to silence:
			// their rows stay in the verdict set, so the hero and the paste line match the status bar's warning.
			const hidden = row({ hiddenByRemoval: true });
			assert.strictEqual(classifyOverall([hidden]), "connected");
			assert.strictEqual(
				overallStatusText([hidden], 0),
				"Connected, but 0 models are served (1 hidden by the user's configuration)"
			);
			assert.strictEqual(
				overallStatusText([hidden, hidden], 0),
				"Connected, but 0 models are served (2 hidden by the user's configuration)"
			);
		});

		test("a hidden group beside an empty-listing server names both causes on the paste line", () => {
			assert.strictEqual(
				overallStatusText([row({ hiddenByRemoval: true }), row()], 0),
				"Connected, but 0 models are served (1 hidden by the user's configuration; 1 answered with an empty listing)"
			);
		});

		test("every server reachable reads as connected with the model count", () => {
			const rows = [row({ servedModelCount: 4 }), row({ servedModelCount: 2 })];
			assert.strictEqual(overallStatusText(rows, 6), "Connected (6 models)");
		});

		test("one failing server among reachable ones reads as degraded", () => {
			const rows = [row({ servedModelCount: 4 }), failed(CONNECTION)];
			assert.strictEqual(overallStatusText(rows, 4), "Degraded (4 models, some servers failed)");
		});

		test("every server failing surfaces the first error as the status", () => {
			const rows = [failed(CONNECTION), failed(TIMEOUT)];
			assert.strictEqual(overallStatusText(rows, 0), "Error: Could not connect to http://prod.test");
		});

		test("declared entries no discovery pass has seen read as waiting, never as a failure", () => {
			const rows = [row({ state: "unchecked" })];
			assert.strictEqual(classifyOverall(rows), "waiting");
			assert.strictEqual(overallStatusText(rows, 0), "Waiting for first sync");
		});

		test("expected failures never count as failures: declared models read as connected", () => {
			const rows = [row({ servedModelCount: 4 }), failed(HTTP_404, { expected: true, servedModelCount: 2 })];
			assert.strictEqual(classifyOverall(rows), "connected");
			assert.strictEqual(overallStatusText(rows, 6), "Connected (6 models)");
		});

		test("all-expected failures with nothing declared read as the neutral needs-declare verdict", () => {
			const rows = [failed(HTTP_404, { expected: true })];
			assert.strictEqual(classifyOverall(rows), "needs-declare");
			assert.strictEqual(
				overallStatusText(rows, 0),
				"Expected discovery failures; no declared models (add IDs to the entry's discovery.declared)"
			);
		});

		test("an expected failure beside an entry awaiting its first report waits: not every server has answered", () => {
			const rows = [failed(HTTP_404, { expected: true }), row({ state: "unchecked" })];
			assert.strictEqual(classifyOverall(rows), "waiting");
			assert.strictEqual(overallStatusText(rows, 0), "Waiting for first sync");
		});

		test("a misconfigured entry beside a healthy server stays neutral: connected, not degraded", () => {
			// The status bar cannot see refused entries, so counting them here would split the headline from the bar.
			const rows = [MISCONFIGURED, row({ servedModelCount: 3 })];
			assert.strictEqual(classifyOverall(rows), "connected");
			assert.strictEqual(overallStatusText(rows, 3), "Connected (3 models)");
		});

		test("with every real server down, the headline names the transport failure, not the misconfigured row", () => {
			// Whatever the row order, the real outage is the line worth pasting into an issue report.
			const rows = [MISCONFIGURED, failed(CONNECTION)];
			assert.strictEqual(classifyOverall(rows), "error");
			assert.strictEqual(overallStatusText(rows, 0), "Error: Could not connect to http://prod.test");
		});

		test("a configuration of only misconfigured entries is an error, never waiting", () => {
			assert.strictEqual(classifyOverall([MISCONFIGURED]), "error");
			assert.strictEqual(
				overallStatusText([MISCONFIGURED], 0),
				"Error: misconfigured entry; not used until its configuration is fixed"
			);
		});

		test("an unexpected failure beside an expected one still degrades, not errors", () => {
			const rows = [failed(CONNECTION), failed(HTTP_404, { expected: true, servedModelCount: 1 })];
			assert.strictEqual(classifyOverall(rows), "degraded");
		});
	});

	describe("serverOutcomeText", () => {
		test("a reachable server reads OK with its model count", () => {
			assert.strictEqual(serverOutcomeText(declaredServer({ servedModelCount: 3 })), "OK (3 models)");
		});

		test("a reachable server whose sync failed reads Error with its still-served count", () => {
			// declaredOutcome renders a sync failure as an error row keeping the live served count, so the paste line
			// says both facts.
			const server = declaredServer({ state: "error", cause: UPSERT_FAILED, servedModelCount: 2 });
			assert.strictEqual(
				serverOutcomeText(server),
				"Error (2 models still served): The host rejected the provider group upsert"
			);
		});

		test("a failing server reads its cause, rendered in English", () => {
			const server = declaredServer({ state: "error", cause: CONNECTION });
			assert.strictEqual(serverOutcomeText(server), "Error: Could not connect to http://prod.test");
		});

		test("an unchecked entry reads not checked yet", () => {
			assert.strictEqual(serverOutcomeText(declaredServer({ state: "unchecked" })), "Not checked yet");
		});

		test("an expected failure with declared models reads as OK, annotated (expected)", () => {
			const server = declaredServer({
				state: "error",
				cause: HTTP_404,
				expected: true,
				servedModelCount: 2,
				declaredModelCount: 2,
			});
			assert.strictEqual(
				serverOutcomeText(server),
				"OK (2 declared models) - The server at http://prod.test answered 404 (expected)"
			);
			assert.strictEqual(
				serverOutcomeText(
					declaredServer({
						state: "error",
						cause: HTTP_404,
						expected: true,
						servedModelCount: 1,
						declaredModelCount: 1,
					})
				),
				"OK (1 declared model) - The server at http://prod.test answered 404 (expected)"
			);
		});

		test("an expected failure serving stale AND declared models names the served total, declared as qualifier", () => {
			// The declared subset must never displace the served count: the row's "5 models" and the paste line have to
			// agree on one number.
			const server = declaredServer({
				state: "error",
				cause: HTTP_404,
				expected: true,
				servedModelCount: 5,
				declaredModelCount: 2,
			});
			assert.strictEqual(
				serverOutcomeText(server),
				"OK (5 models, 2 declared) - The server at http://prod.test answered 404 (expected)"
			);
		});

		test("servedModelsBreakdown classifies once for both string surfaces", () => {
			// The English paste line and the Servers row's localized headline both render this classification; these
			// pins are the shared vocabulary.
			assert.deepStrictEqual(servedModelsBreakdown(2, 2), { kind: "declared", declared: 2 });
			assert.deepStrictEqual(servedModelsBreakdown(5, 2), { kind: "mixed", served: 5, declared: 2 });
			// Discovery serves every declared model (served = discovered + declared, groupDiscovery), so declared never
			// exceeds served and mixed implies served >= 2 - which is why neither surface carries a singular mixed
			// form. An out-of-contract input still classifies as the two-count form rather than claiming the whole
			// served set is declared.
			assert.deepStrictEqual(servedModelsBreakdown(1, 2), { kind: "mixed", served: 1, declared: 2 });
			assert.deepStrictEqual(servedModelsBreakdown(3, 0), { kind: "stale", served: 3 });
		});

		test("the models part, when present, always states the server's servedModelCount", () => {
			const servers: DashboardServer[] = [
				declaredServer({ servedModelCount: 3 }),
				declaredServer({ state: "error", cause: UPSERT_FAILED, servedModelCount: 2 }),
				declaredServer({ state: "error", cause: HTTP_404, servedModelCount: 4 }),
				declaredServer({ state: "error", cause: HTTP_404, expected: true, servedModelCount: 5, declaredModelCount: 2 }),
				declaredServer({ state: "error", cause: HTTP_404, expected: true, servedModelCount: 2, declaredModelCount: 2 }),
				declaredServer({ state: "error", cause: HTTP_404, expected: true, servedModelCount: 3 }),
			];
			for (const server of servers) {
				const models = serverOutcomeParts(server).models;
				assert.ok(models !== undefined, serverOutcomeText(server));
				assert.ok(
					models.startsWith(`${server.servedModelCount} `),
					`"${models}" must state servedModelCount ${server.servedModelCount}`
				);
			}
		});

		test("an expected error carries its (expected) annotation on the error part itself", () => {
			const server = declaredServer({
				state: "error",
				cause: HTTP_404,
				expected: true,
				servedModelCount: 2,
				declaredModelCount: 2,
			});
			assert.strictEqual(serverOutcomeParts(server).error, "The server at http://prod.test answered 404 (expected)");
		});

		test("an ok row with every model skipped by mode names the includeModes fix", () => {
			const line = serverOutcomeText(
				declaredServer({ state: "ok", servedModelCount: 0, notices: ["non-chat-modes-skipped"] })
			);
			assert.strictEqual(
				line,
				"OK (0 models) - no models registered, and discovery skipped models by mode; add the modes to the entry's discovery.includeModes list to register them"
			);
		});

		test("an expected failure with nothing declared stays an annotated error line", () => {
			const line = serverOutcomeText(
				declaredServer({
					state: "error",
					cause: HTTP_404,
					expected: true,
					notices: ["expected-failures-nothing-declared"],
				})
			);
			assert.ok(line.startsWith("Error: The server at http://prod.test answered 404 (expected)"), line);
			assert.ok(line.includes("discovery.declared"), line);
		});

		test("an entry whose group cannot serve its per-entry parameters says so on a healthy line", () => {
			// The row is healthy, which is why the line must call the inactive parameters out.
			const line = serverOutcomeText(declaredServer({ servedModelCount: 2, notices: ["entry-params-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - per-entry modelParameters are not applied"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("an entry whose group cannot serve its apiVersion override says so on a healthy line", () => {
			const line = serverOutcomeText(declaredServer({ servedModelCount: 2, notices: ["entry-api-version-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - the per-entry API version override is not applied"), line);
			assert.ok(line.includes("requests use the auto rule"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("the capabilities twin of the params-inactive line names its own fields", () => {
			const line = serverOutcomeText(declaredServer({ servedModelCount: 2, notices: ["entry-capabilities-inactive"] }));
			assert.ok(
				line.startsWith(
					"OK (2 models) - per-entry modelCapabilities, declared models, expectedFailures, and includeModes are not applied"
				),
				line
			);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("the custom-headers twin of the params-inactive line names its own fields", () => {
			const line = serverOutcomeText(declaredServer({ servedModelCount: 2, notices: ["entry-headers-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - per-entry custom headers are not applied"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("the four entry-*-inactive notices share one composed cause-and-remedy clause", () => {
			// Each notice is its own subject plus the clause the composer appends; the clause is pinned here once, as
			// users paste it into issue reports.
			const clause =
				" (the provider group does not carry this entry's labeled identity); " +
				"delete the group in Manage Language Models (or remove its object from the models file, chatLanguageModels.json, and reload the window), " +
				"then run Sync Models Now, or save the entry under a new label";
			const notices = [
				"entry-params-inactive",
				"entry-capabilities-inactive",
				"entry-headers-inactive",
				"entry-api-version-inactive",
			] as const;
			const subjects = notices.map((notice) => {
				const [text = ""] = serverOutcomeParts(declaredServer({ servedModelCount: 1, notices: [notice] })).notice;
				assert.ok(text.endsWith(clause), `${notice}: ${text}`);
				return text.slice(0, -clause.length);
			});
			assert.strictEqual(new Set(subjects).size, notices.length, "each notice names its own affected fields");
		});

		test("a row carrying both inactive notices lists them both, params first", () => {
			const line = serverOutcomeText(
				declaredServer({ servedModelCount: 2, notices: ["entry-params-inactive", "entry-capabilities-inactive"] })
			);
			assert.ok(line.includes("per-entry modelParameters are not applied"), line);
			assert.ok(
				line.includes(
					"per-entry modelCapabilities, declared models, expectedFailures, and includeModes are not applied"
				),
				line
			);
			assert.ok(
				line.indexOf("modelParameters are not applied") <
					line.indexOf("modelCapabilities, declared models, expectedFailures, and includeModes"),
				line
			);
		});

		test("a misconfigured row short-circuits to its status with the parser's reports as the error", () => {
			const server = misconfiguredServer(["auth must pick one form", "unknown field ignored"]);
			assert.deepStrictEqual(serverOutcomeParts(server), {
				status: "Misconfigured",
				error: "auth must pick one form; unknown field ignored",
				notice: [],
			});
			assert.strictEqual(serverOutcomeText(server), "Misconfigured: auth must pick one form; unknown field ignored");
		});

		test("the one-line form is exactly the composition of serverOutcomeParts", () => {
			// The Diagnostics grid renders the decomposed parts; the pinned line is what lands in issue reports.
			// Re-deriving one from the other keeps the two surfaces from drifting.
			const cases: DashboardServer[] = [
				declaredServer({ servedModelCount: 3 }),
				declaredServer({ state: "error", cause: UPSERT_FAILED, servedModelCount: 2 }),
				declaredServer({ state: "error", cause: CONNECTION }),
				declaredServer({ state: "unchecked" }),
				declaredServer({ servedModelCount: 2, notices: ["entry-params-inactive"] }),
				declaredServer({
					state: "error",
					cause: UPSERT_FAILED,
					servedModelCount: 2,
					notices: ["entry-params-inactive"],
				}),
				declaredServer({ state: "error", cause: CONNECTION, notices: ["entry-params-inactive"] }),
				declaredServer({ state: "unchecked", notices: ["entry-params-inactive"] }),
				declaredServer({ servedModelCount: 2, notices: ["entry-params-inactive", "entry-capabilities-inactive"] }),
				declaredServer({ state: "error", cause: HTTP_404, expected: true, servedModelCount: 2, declaredModelCount: 2 }),
				declaredServer({ state: "error", cause: HTTP_404, expected: true, servedModelCount: 5, declaredModelCount: 2 }),
				declaredServer({
					state: "error",
					cause: HTTP_404,
					expected: true,
					notices: ["expected-failures-nothing-declared"],
				}),
			];
			for (const server of cases) {
				const parts = serverOutcomeParts(server);
				const status = parts.models === undefined ? parts.status : `${parts.status} (${parts.models})`;
				const error = parts.error === undefined ? "" : parts.status === "OK" ? ` - ${parts.error}` : `: ${parts.error}`;
				const notice = parts.notice.map((text) => ` - ${text}`).join("");
				assert.strictEqual(serverOutcomeText(server), `${status}${error}${notice}`);
			}
		});
	});

	describe("zero-model prose", () => {
		test("the localized explanation names hidden groups first, then the empty listings", () => {
			// The one sentence the bar tooltip, the toasts, and the draft probe share (English-bundle wording pinned
			// here once).
			assert.strictEqual(
				zeroModelExplanation(1, 0),
				"1 server is hidden and serves no models: it was removed here, or its entry now points at another URL. The dashboard's server list shows which."
			);
			assert.strictEqual(
				zeroModelExplanation(2, 1),
				"2 servers are hidden and serve no models: they were removed here, or their entries now point at other URLs. The dashboard's server list shows which. The remaining servers answered but listed no models."
			);
			assert.strictEqual(zeroModelExplanation(0, 1), "The server answered but listed no models.");
			assert.strictEqual(zeroModelExplanation(0, 2), "Your servers answered but listed no models.");
		});

		test("the English detail mirrors the same causes for logs and pasted reports", () => {
			assert.strictEqual(zeroModelEnglishDetail(0, 1), "answered with an empty listing");
			assert.strictEqual(zeroModelEnglishDetail(1, 0), "1 hidden by the user's configuration");
			assert.strictEqual(
				zeroModelEnglishDetail(2, 1),
				"2 hidden by the user's configuration; 1 answered with an empty listing"
			);
		});
	});

	describe("latestCheckedMs", () => {
		test("undefined while nothing was checked; otherwise the most recent timestamp", () => {
			assert.strictEqual(latestCheckedMs([]), undefined);
			assert.strictEqual(latestCheckedMs([{ lastChecked: undefined }]), undefined);
			const older = new Date("2026-07-26T01:02:03.000Z").getTime();
			const newer = new Date("2026-07-27T05:06:07.000Z").getTime();
			assert.strictEqual(
				latestCheckedMs([{ lastChecked: older }, { lastChecked: undefined }, { lastChecked: newer }]),
				newer
			);
		});
	});

	describe("capability vocabulary", () => {
		test("capabilityField reads own properties only, so prototype-named open fields cannot leak members", () => {
			const bag: Readonly<Record<string, CapabilityJsonValue | undefined>> = { toString: "own" };
			assert.strictEqual(capabilityField(bag, "toString"), "own");
			assert.strictEqual(capabilityField(bag, "constructor"), undefined);
			assert.strictEqual(capabilityField(bag, "__proto__"), undefined);
		});
	});
});

describe("dashboard/presenters number-unit grammars", () => {
	test("a setting's draft parse refuses a fraction with its own grammar's or the spec's message, never rounds it", () => {
		// The integer-only fact has one source, the spec's `integer` flag, so a new integer setting cannot ship a unit
		// whose input commits values the host would refuse. Total over NumberSettingId: a new setting states its message.
		const between = (id: NumberSettingId) =>
			`${id} must be a whole number between ${NUMBER_SETTING_SPECS[id].minimum} and ${NUMBER_SETTING_SPECS[id].maximum}.`;
		const refusalOf15: Record<NumberSettingId, string> = {
			"chat.timeout": between("chat.timeout"),
			"chat.maxToolsPerRequest": between("chat.maxToolsPerRequest"),
			"discovery.timeout": between("discovery.timeout"),
			"discovery.cacheTtl": between("discovery.cacheTtl"),
			"discovery.staleServeWindow": between("discovery.staleServeWindow"),
			"usage.pollInterval":
				"usage.pollInterval must be a whole number between 30000 and 2147483647, or 0 to turn it off.",
			"usage.initialRefreshDelay": between("usage.initialRefreshDelay"),
			"usage.serversChangeRefreshDelay": between("usage.serversChangeRefreshDelay"),
			"usage.pollingOffFreshnessWindow": between("usage.pollingOffFreshnessWindow"),
		};
		for (const id of Object.keys(NUMBER_SETTING_SPECS) as NumberSettingId[]) {
			assert.deepStrictEqual(
				parseNumberDraft(id, "1.5"),
				{ kind: "invalid", problem: refusalOf15[id] },
				`${id}: the draft parse of "1.5"`
			);
		}
	});
});
