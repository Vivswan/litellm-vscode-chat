/**
 * A server row's diagnostics: the health verdict, the inactive-surface notices, the per-row and usage-derived problem
 * lines with their actions and absence reasons, and the drawer notices.
 */
import * as l10n from "@vscode/l10n";
import { servedModelsBreakdown } from "../../dashboard/presenters";
import { formatMoney, spendTone, stalenessText } from "../../dashboard/spendFormat";
import type { UsageEndpointId } from "../../dashboard/usageEndpoints";
import { USAGE_ENDPOINT_PATHS } from "../../dashboard/usageEndpoints";
import type {
	DashboardServer,
	InactiveEntryNotice,
	UsageEndpointStandingView,
	UsageServerCardView,
	UsageServerView,
} from "../../dashboard/viewModels";
import { failureClassification, failureTexts } from "../../shared/failureCause";
import type { ExpectedFailureCategory } from "../../shared/serverEntry";
import type { DocsUrl } from "./docsLinks";
import { DOCS_LINK_AUTHENTICATION, DOCS_LINK_OPENAI_COMPATIBLE, DOCS_LINK_PARAMS_INACTIVE } from "./docsLinks";
import { DocsLink } from "./help";
import { IconWarning } from "./icons";
import { ProblemBand } from "./problemBand";
import { troubleshootingLink } from "./serverEditPage";
import { type DiagnosticSeverity, SEVERITY_ORDER, severityLabel } from "./severity";
import { TONE_TEXT } from "./spendTones";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { sendRequest } from "./vscodeApi";

/** Zero-arg functions, so strings resolve after the l10n bootstrap. */
const INACTIVE_NOTICE_PRESENTATION = {
	"entry-params-inactive": {
		surface: () => l10n.t("per-server model parameters"),
	},
	"entry-capabilities-inactive": {
		surface: () => l10n.t("per-server model capabilities, declared models, expected failures, and included modes"),
	},
	"entry-headers-inactive": {
		surface: () => l10n.t("per-server custom headers"),
	},
	"entry-api-version-inactive": {
		// The consequence rides the phrase: uniquely here, the surface silently falls back to a different rule rather
		// than simply not applying.
		surface: () => l10n.t("per-server API version overrides (requests use the auto rule)"),
	},
} as const satisfies Record<InactiveEntryNotice, { surface: () => string }>;

const INACTIVE_NOTICES = Object.keys(INACTIVE_NOTICE_PRESENTATION) as readonly InactiveEntryNotice[];

/*
 *   This page's reading of ./severity.ts -> ranked by what a problem costs the server's purpose
 *
 *   "blocking" -> serves nothing until someone acts
 *   "degraded" -> needs a human even if models serve (a refused usage key counts - user-ruled)
 *   "advisory" -> still renders whole, only tint and attention count reduced
 *
 *   The tiers -> are what the summary line counts
 */

/**
 * One action offered beside a problem: it REVEALS where a human fixes it, or retries - never a silent settings edit.
 * The one exception, declare-expected, appends one closed-vocabulary token (discovery.expectedFailures) behind an
 * explicit confirm that named what it writes.
 */
type DiagnosticAction =
	| {
			readonly kind: "button";
			/**
			 * Stable across renders and independent of the label: keying by text rebuilds the node the instant its
			 * wording changes, throwing away the reader's focus.
			 */
			readonly id: string;
			readonly label: string;
			readonly ariaLabel: string;
			/** In flight: the control states that it is working and refuses a second click. */
			readonly disabled?: boolean | undefined;
			readonly busy?: boolean | undefined;
			/** The accent rank, for the one action of an armed pair that commits; everything else stays secondary. */
			readonly emphasized?: boolean | undefined;
			readonly onClick: () => void;
	  }
	| {
			readonly kind: "docs";
			readonly id: string;
			readonly label: string;
			readonly href: DocsUrl;
			readonly ariaLabel: string;
	  };

interface DiagnosticBase {
	/** Stable within a row, so React keeps focus on an action button across pushes. */
	readonly key: string;
	readonly severity: DiagnosticSeverity;
	/** Names the server and leads with the consequence, not the mechanism. */
	readonly headline: string;
	/** One paragraph per line. English by policy - these land in issue reports. */
	readonly details?: readonly string[] | undefined;
	readonly actions: readonly DiagnosticAction[];
}

/** The default seat: a banded line under the collapsed row, tinted by its severity alone. */
interface CollapsedDiagnostic extends DiagnosticBase {
	readonly placement?: undefined;
	readonly tone?: undefined;
}

/**
 * A banded line whose paint tier comes from the user's usage.alertThresholds rather than the severity ladder alone:
 * past the error threshold (or past the budget) the tone lifts the band to the error tier, USER-RULED (2026-08-17:
 * error-tier money problems wear error colour everywhere they render). Paint only - the severity keeps the ranking,
 * the pill, and the hidden tier word.
 *
 *   a blocking line is already error-tier -> Degraded by construction
 */
interface SpendErrorDiagnostic extends DiagnosticBase {
	readonly severity: "degraded";
	readonly tone: "error";
	readonly placement?: undefined;
}

/**
 * The drawer seat, USER-RULED (2026-08-16) for the sub-error budget-pressure line: the tinted meter already signals
 * it. The diagnostic still ranks the pill and the attention count either way.
 *
 *   Warn-tier by construction              -> the tone field can only be absent here
 *   the tone field can only be absent here -> nothing can ask the notice for a hue its triangle and its text do not
 *                                             have
 */
export interface DrawerNotice extends DiagnosticBase {
	readonly placement: "drawer";
	readonly tone?: undefined;
}

type BandedDiagnostic = CollapsedDiagnostic | SpendErrorDiagnostic;

type RowDiagnostic = BandedDiagnostic | DrawerNotice;

export function detailLines(...lines: readonly (string | undefined)[]): readonly string[] {
	return lines.filter((line): line is string => line !== undefined);
}

export interface SpendContext {
	readonly thresholds: readonly number[];
	readonly currencySymbol: string;
	/**
	 * Background polling is off (usage.pollInterval 0); retry copy names Refresh now instead of the automatic retry.
	 */
	readonly pollingOff: boolean;
	/** The effective discovery.timeout; the timeout detail line prints it. */
	readonly discoveryTimeoutMs: number;
}

/** The two usage endpoints whose standings turn into English detail lines. */
export type UsageEndpoint = Extract<UsageEndpointId, "keyInfo" | "dailyActivity">;

interface RowDiagnostics {
	/** Every problem the server has, worst first. */
	readonly lines: readonly RowDiagnostic[];
	/** The drawer's inventory prints only the endpoint details NOT in this set, so a line never doubles or drops. */
	readonly usageDetailsCarried: ReadonlySet<UsageEndpoint>;
}

export function serverDiagnostics(
	server: DashboardServer,
	usage: UsageServerCardView | undefined,
	spend: SpendContext,
	actions: {
		readonly onEdit: () => void;
		readonly onRetry: () => void;
		/** This row is the one that asked for the sync, so it reports the state. */
		readonly retrying?: boolean;
		/** A sync is in flight somewhere, so no row may start a second one. */
		readonly syncBusy?: boolean;
		/** Post the declareExpectedFailure intent for this row; only a declared row wires it. */
		readonly onDeclareExpected?: (category: ExpectedFailureCategory) => void;
		/** The category whose confirm step is showing, armed by the declare button. */
		readonly armedDeclare?: ExpectedFailureCategory | undefined;
		readonly onArmDeclare?: (category: ExpectedFailureCategory | undefined) => void;
		/** This row's declare intent is unanswered; its buttons state that and refuse a second post. */
		readonly declaring?: boolean;
		/** Post the refreshUsage intent; wired on rows whose usage problems offer Refresh now. */
		readonly onRefreshUsage?: () => void;
		/** A usage refresh is in flight; every Refresh now states it and refuses a second post. */
		readonly refreshing?: boolean;
		/** That pass was explicitly requested; only then does a Refresh now wear its busy label. */
		readonly refreshingExplicitly?: boolean;
	}
): RowDiagnostics {
	// The two-step declare control: the plain button arms, the armed pair confirms or cancels (the Remove idiom).
	const declareActions = (category: ExpectedFailureCategory): DiagnosticAction[] => {
		const { onDeclareExpected, onArmDeclare } = actions;
		if (onDeclareExpected === undefined || onArmDeclare === undefined) {
			return [];
		}
		if (actions.armedDeclare === category) {
			return [
				{
					kind: "button",
					id: `declare-confirm-${category}`,
					label: actions.declaring === true ? l10n.t("Declaring...") : l10n.t("Confirm declaration?"),
					ariaLabel:
						actions.declaring === true
							? l10n.t("Declaring the expected failure for {0}", server.label)
							: l10n.t("Confirm declaring the expected failure for {0}", server.label),
					disabled: actions.declaring === true,
					busy: actions.declaring === true,
					emphasized: true,
					// The pair stays armed through the round trip so this button can state "Declaring..."; the row
					// disarms when the outcome lands.
					onClick: () => onDeclareExpected(category),
				},
				{
					kind: "button",
					id: `declare-cancel-${category}`,
					label: l10n.t("Cancel"),
					ariaLabel: l10n.t("Cancel declaring the expected failure for {0}", server.label),
					// A posted write cannot be cancelled; an enabled Cancel beside "Declaring..." would claim
					// otherwise.
					disabled: actions.declaring === true,
					onClick: () => onArmDeclare(undefined),
				},
			];
		}
		return [
			{
				kind: "button",
				id: `declare-expected-${category}`,
				label: l10n.t("Declare expected failure"),
				ariaLabel: l10n.t("Declare the {0} failure expected for {1}", category, server.label),
				disabled: actions.declaring === true,
				onClick: () => onArmDeclare(category),
			},
		];
	};
	const openAiCompatibleGuide: DiagnosticAction = {
		kind: "docs",
		id: "openai-compatible-guide",
		href: DOCS_LINK_OPENAI_COMPATIBLE,
		label: l10n.t("Learn more"),
		ariaLabel: l10n.t("Learn more: the OpenAI-compatible servers guide"),
	};
	// A discovery pass can take tens of seconds (the per-request timeouts sum), so the in-flight Retry relabels and
	// spins.
	//
	//   Only the asking row -> SAYS it is checking
	const retryAction = (): DiagnosticAction => ({
		kind: "button",
		id: "retry",
		label: actions.retrying === true ? l10n.t("Checking...") : l10n.t("Retry"),
		ariaLabel:
			actions.retrying === true
				? l10n.t("Checking {0}", server.label)
				: l10n.t("Retry discovery for {0}", server.label),
		disabled: actions.retrying === true || actions.syncBusy === true,
		busy: actions.retrying === true,
		onClick: actions.onRetry,
	});
	const found: RowDiagnostic[] = [];
	if (server.origin === "misconfigured") {
		found.push({
			key: "misconfigured",
			severity: "blocking",
			// The consequence first: the entry is not merely invalid, it is switched off, and no amount of retrying
			// changes that.
			headline: l10n.t("{0} is switched off until this entry is fixed.", server.label),
			// The parser's structural reports stay English by policy.
			details: server.problems,
			actions: [
				{
					kind: "button",
					id: "fix-settings",
					label: l10n.t("Fix in settings.json"),
					ariaLabel: l10n.t("Fix {0} in settings.json", server.label),
					onClick: () => sendRequest("revealSetting", { setting: "servers" }),
				},
				{
					kind: "docs",
					id: "learn-more",
					label: l10n.t("Learn more"),
					href: DOCS_LINK_AUTHENTICATION,
					ariaLabel: l10n.t("Learn more: the authentication guide"),
				},
			],
		});
	}
	const error = server.state === "error" ? failureTexts(server.cause, server.baseUrl).display : undefined;
	const classification = server.state === "error" ? failureClassification(server.cause) : undefined;
	const inactive = INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true);
	// The one health walk: this branch's severity and the pill's word read the same verdict.
	const verdict = serverHealth(server);
	if (error !== undefined && server.origin !== "misconfigured") {
		const headline = error;
		if (verdict === "degraded" || verdict === "blocking") {
			const serving = verdict === "degraded";
			// Where the declare action is withheld, the identity fix rides the details - unless the entry-inactive line
			// below renders and says the same sentence itself.
			const declareWithheld =
				server.origin === "declared" &&
				classification?.unsupportedEndpoint === "modelListing" &&
				server.entryFieldsInactive === true;
			// The declaration-suggesting transport string is atomic (toasts show it whole) and leads with the
			// remediation, so the swap happens here: a short consequence clause takes the headline's slot and the
			// advice rides the detail lines.
			const declarationAdvice = classification?.unsupportedEndpoint === "modelListing";
			const cause = declarationAdvice ? l10n.t("the server answers, but its models listing fails.") : headline;
			found.push({
				key: "discovery-error",
				severity: verdict,
				headline: serving
					? l10n.t("{0} is serving its last known models; the newest sync failed: {1}", server.label, cause)
					: l10n.t("{0} is serving no models: {1}", server.label, cause),
				details: detailLines(
					declarationAdvice ? headline : undefined,
					declareWithheld && inactive.length === 0 ? entryInactiveFixText() : undefined
				),
				actions: [
					retryAction(),
					...(server.origin === "declared"
						? [
								{
									kind: "button" as const,
									id: "open-entry",
									label: l10n.t("Open entry"),
									ariaLabel: l10n.t("Open the entry for {0}", server.label),
									onClick: actions.onEdit,
								},
							]
						: []),
					...(server.origin === "declared" && classification?.unsupportedEndpoint === "modelListing"
						? [
								// The error's declaration advice (riding the detail lines, transport proved the shape)
								// already spells the fix; this is its one-click form, writing exactly the category the
								// advice names - withheld when the group did not join by the entry's identity (the
								// details then carry the identity fix), because the written declaration may not reach
								// it (the same classification the advisory tier keys on).
								...(declareWithheld ? [] : declareActions("modelListing")),
								openAiCompatibleGuide,
							]
						: []),
					...(classification?.setupHint !== undefined
						? [
								{
									kind: "docs" as const,
									id: "troubleshoot",
									// The helper's `label` is a whole sentence for surfaces that SHOW it; here the
									// visible text is the short verb, so the accessible name must lead with that verb
									// (Label in Name) and the helper's `topic` supplies the distinguishing tail. Do not
									// spread the helper over these - it carries its own `label` and would put the long
									// sentence on screen.
									href: troubleshootingLink(classification.setupHint).href,
									label: l10n.t("Troubleshoot"),
									ariaLabel: l10n.t("Troubleshoot: {0}", troubleshootingLink(classification.setupHint).topic),
								},
							]
						: []),
				],
			});
		} else if (verdict === "expected") {
			// The server's own words ride the detail lines, not the headline (colon chaining).
			//
			//   The count vocabulary -> is the shared breakdown the English outcome line renders too
			const breakdown = servedModelsBreakdown(server.servedModelCount, server.declaredModelCount ?? 0);
			found.push({
				key: "expected-serving",
				severity: "advisory",
				headline:
					breakdown.kind === "declared"
						? breakdown.declared === 1
							? l10n.t(
									"{0} serves 1 declared model; discovery fails only where this entry expects it to.",
									server.label
								)
							: l10n.t(
									"{0} serves {1} declared models; discovery fails only where this entry expects it to.",
									server.label,
									breakdown.declared
								)
						: breakdown.kind === "mixed"
							? l10n.t(
									"{0} serves {1} models, {2} declared; discovery fails only where this entry expects it to.",
									server.label,
									breakdown.served,
									breakdown.declared
								)
							: l10n.t(
									"{0} serves its last known models; discovery fails only where this entry expects it to.",
									server.label
								),
				details: detailLines(headline),
				actions: [],
			});
		} else {
			found.push({
				// The expected category makes the CAUSE unsurprising; it does not put any models in the picker.
				key: "expected-nothing-declared",
				severity: "blocking",
				headline: l10n.t(
					"{0} serves no models: discovery fails in a category this entry expects ({1}), and nothing is declared.",
					server.label,
					headline
				),
				details: [],
				actions: [
					...(server.origin === "declared"
						? [
								{
									kind: "button" as const,
									id: "declare-models",
									label: l10n.t("Declare models"),
									ariaLabel: l10n.t("Declare models for {0}", server.label),
									onClick: actions.onEdit,
								},
							]
						: []),
					retryAction(),
				],
			});
		}
	}
	if (server.state === "ok" && server.modelInfoUnsupported !== undefined && server.origin === "declared") {
		// Declaring marks the failing probe as normal (single attempt, info log) - it does NOT shorten the probe's
		// wait, so the copy promises the marking, never speed. The one-click write is withheld when the group did not
		// join by the entry's identity; the details then carry the fix.
		const withheld = server.entryFieldsInactive === true;
		found.push({
			key: "model-info-unsupported",
			severity: "advisory",
			headline:
				server.modelInfoUnsupported === "timeout"
					? l10n.t(
							"{0} serves its models, but its model-info probe never answers and waits out the discovery timeout on every sync. Declaring the failure expected marks that as normal for this server.",
							server.label
						)
					: l10n.t(
							"{0} serves its models without LiteLLM's model-info endpoint (capability and pricing metadata). Declaring the failure expected marks that as normal for this server.",
							server.label
						),
			// English by policy for the endpoint facts; the identity fix rides localized, like the entry-inactive line
			// it comes from.
			details: detailLines(
				server.modelInfoUnsupported === "timeout"
					? 'GET /model/info times out; GET /models succeeds. The action writes "expectedFailures": ["modelInfo"] on this entry.'
					: 'GET /model/info answers HTTP 404/405; GET /models succeeds. The action writes "expectedFailures": ["modelInfo"] on this entry.',
				withheld && inactive.length === 0 ? entryInactiveFixText() : undefined
			),
			actions: [...(withheld ? [] : declareActions("modelInfo")), openAiCompatibleGuide],
		});
	}
	if (server.origin === "declared" && server.notices?.includes("non-chat-modes-skipped") === true) {
		// The counts are classifications (mode tokens from the closed vocabulary), so they ride the English details
		// line like the other protocol facts.
		//
		//   The skip counts              -> are the one cause the row can name
		//   blocked or malformed entries -> may have dropped the rest
		const dropped = Object.entries(server.skippedModeCounts ?? {})
			.map(([mode, count]) => `${mode}: ${count}`)
			.join(", ");
		const withheld = server.entryFieldsInactive === true;
		found.push({
			key: "non-chat-modes-skipped",
			severity: "blocking",
			headline: l10n.t(
				"{0} serves no models, and discovery skipped models whose mode this extension drops by default.",
				server.label
			),
			details: detailLines(
				withheld
					? `Skipped by mode: ${dropped}. Once the group carries this entry's identity, tick the modes to include under Discovery, or set "discovery": { "includeModes": [...] } on this entry.`
					: `Skipped by mode: ${dropped}. Tick the modes to include under Discovery, or set "discovery": { "includeModes": [...] } on this entry.`,
				withheld && inactive.length === 0 ? entryInactiveFixText() : undefined
			),
			actions: [
				...(withheld
					? []
					: [
							{
								kind: "button" as const,
								id: "include-modes",
								label: l10n.t("Include modes"),
								ariaLabel: l10n.t("Include skipped modes for {0}", server.label),
								onClick: actions.onEdit,
							},
						]),
				retryAction(),
			],
		});
	}
	if (inactive.length > 0) {
		// One line for every inactive surface: cause and fix are identical for all. Degraded, not advisory - the group
		// may be serving WITHOUT settings the user wrote, and advisory would keep these rows out of the summary count.
		found.push({
			key: "entry-inactive",
			severity: "degraded",
			headline: l10n.t("{0} may not be applying its {1}.", server.label, inactiveSurfacesText(server)),
			details: [entryInactiveFixText()],
			actions: [
				{
					kind: "button",
					id: "open-models-file",
					label: l10n.t("Open models file"),
					ariaLabel: l10n.t("Open the models file to fix {0}", server.label),
					onClick: () => sendRequest("executeCommand", { command: "openGroupsFile" }),
				},
				{
					kind: "docs",
					id: "learn-more",
					label: l10n.t("Learn more"),
					href: DOCS_LINK_PARAMS_INACTIVE,
					ariaLabel: l10n.t("Learn more in the troubleshooting guide"),
				},
			],
		});
	}
	let usageDetailsCarried: ReadonlySet<UsageEndpoint> = new Set();
	if (usage !== undefined) {
		const problems = usageDiagnostics(server.label, usage, spend, actions);
		found.push(...problems.lines);
		usageDetailsCarried = problems.usageDetailsCarried;
	}
	return {
		lines: [...found].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
		usageDetailsCarried,
	};
}

/**
 * The row's spend and usage problems, ranked by the same tiers as everything else on it: one classifier, so the
 * summary count can never disagree with what a row renders. Every English endpoint detail a diagnostic carries is
 * recorded through `carry`, so the drawer's remainder derives from the emissions themselves rather than a hand-copied
 * predicate.
 */
function usageDiagnostics(
	label: string,
	card: UsageServerCardView,
	spend: SpendContext,
	actions: {
		readonly onRefreshUsage?: () => void;
		readonly refreshing?: boolean;
		readonly refreshingExplicitly?: boolean;
	}
): RowDiagnostics {
	const carried = new Set<UsageEndpoint>();
	// Attaching an endpoint's detail to a diagnostic and marking it consumed are one move; an absent detail marks
	// nothing, so "carried" always means "a diagnostic prints it".
	const carry = (endpoint: UsageEndpoint, detail: string | undefined): string | undefined => {
		if (detail !== undefined) {
			carried.add(endpoint);
		}
		return detail;
	};
	// Disabled during ANY pass (one serialized engine); the busy label only for an explicit one.
	const refreshNow = (id: string): DiagnosticAction[] =>
		actions.onRefreshUsage === undefined
			? []
			: [
					{
						kind: "button",
						id,
						label: actions.refreshingExplicitly === true ? l10n.t("Refreshing...") : l10n.t("Refresh now"),
						ariaLabel:
							actions.refreshingExplicitly === true
								? l10n.t("Refreshing usage data")
								: l10n.t("Refresh usage data for {0}", label),
						disabled: actions.refreshing === true,
						busy: actions.refreshingExplicitly === true,
						onClick: actions.onRefreshUsage,
					},
				];
	if (card.kind === "forbidden") {
		// USER RULING (2026-08-14): a denied usage key is DEGRADED, not advisory - nothing here clears itself; only a
		// human can change the key's permission.
		return {
			lines: [
				{
					key: "usage-denied",
					severity: "degraded",
					headline: l10n.t(
						"Usage is unavailable for {0}: this key isn't allowed to read its usage. Ask whoever issued the key to allow it, then use Refresh now - the extension won't re-check on its own.",
						label
					),
					details: detailLines(
						carry("keyInfo", forbiddenRowDetail("keyInfo", card.keyInfo)),
						carry("dailyActivity", forbiddenRowDetail("dailyActivity", card.dailyActivity))
					),
					actions: refreshNow("usage-denied-refresh"),
				},
			],
			usageDetailsCarried: carried,
		};
	}
	const found: RowDiagnostic[] = [];
	if (card.keyInfo.kind === "unavailable" && card.keyInfo.reason === "forbidden") {
		// The same user-ruled tier as the whole-card denial: a permission only a human can fix, so it counts.
		found.push({
			key: "spend-denied",
			severity: "degraded",
			headline: l10n.t(
				"{0} can't read its spend: this key isn't allowed to. Ask whoever issued the key to allow /key/info, then use Refresh now - the extension won't re-check on its own.",
				label
			),
			details: detailLines(carry("keyInfo", forbiddenRowDetail("keyInfo", card.keyInfo))),
			actions: refreshNow("spend-denied-refresh"),
		});
	}
	if (card.dailyActivity.kind === "unavailable" && card.dailyActivity.reason === "forbidden") {
		found.push({
			key: "statistics-denied",
			severity: "degraded",
			headline: l10n.t(
				"{0} can't read request statistics: this key isn't allowed to. After the key's permissions change, use Refresh now to re-check.",
				label
			),
			details: detailLines(carry("dailyActivity", forbiddenRowDetail("dailyActivity", card.dailyActivity))),
			actions: refreshNow("statistics-denied-refresh"),
		});
	}
	if (card.keyInfo.kind === "error") {
		found.push({
			key: "usage-refresh-failed",
			severity: "advisory",
			headline: spend.pollingOff
				? l10n.t(
						"{0}'s spend numbers didn't refresh: the last check failed, and background polling is off - use Refresh now to try again.",
						label
					)
				: l10n.t(
						"{0}'s spend numbers didn't refresh: the last check failed; it retries automatically with increasing delay.",
						label
					),
			details: detailLines(carry("keyInfo", keyInfoDetail(card, spend.discoveryTimeoutMs))),
			actions: refreshNow("usage-refresh-failed-refresh"),
		});
	}
	if (card.spend !== undefined && card.effectiveBudget !== undefined && card.spentFraction !== undefined) {
		// Degraded per the tier contract: the reader set the budget to be told before it runs out. The line says how
		// far past or how much is left; no action fixes a budget.
		//
		//   The shared map owns the whole tone decision -> line, meter fill, and status bar cannot split
		//   past the whole budget                       -> it is error even with an empty threshold list
		const tone = spendTone(card.spentFraction, spend.thresholds);
		if (tone !== "ok") {
			const overBudget = card.spentFraction > 1;
			const figures = overBudget
				? l10n.t(
						"{0} is over its budget by {1}.",
						label,
						formatMoney(card.spend - card.effectiveBudget, spend.currencySymbol)
					)
				: l10n.t(
						"{0} is close to its budget: {1} left.",
						label,
						formatMoney(card.effectiveBudget - card.spend, spend.currencySymbol)
					);
			// The row's one staleness vocabulary, cause and all: the band qualifies a non-fresh figure with
			// stalenessText verbatim, so it can never name the state differently than the drawer's fact.
			const staleness = stalenessText(card.fresh, card.keyInfo);
			const line = {
				key: overBudget ? "over-budget" : "budget-pressure",
				severity: "degraded",
				headline: staleness === undefined ? figures : l10n.t("{0} Spend figure: {1}.", figures, staleness),
				actions: [],
			} as const;
			found.push(tone === "warn" ? { ...line, placement: "drawer" } : { ...line, tone: "error" });
		}
	}
	return { lines: found, usageDetailsCarried: carried };
}

function DiagnosticActions({ actions }: { actions: readonly DiagnosticAction[] }) {
	if (actions.length === 0) {
		return null;
	}
	return (
		// No live-region role here: role="status" is atomic, so a per-cluster region would
		// read every unrelated label when a fleet-wide flag flips them all together;
		// ServersSection's single text-only status region announces in-flight relabels.
		<div className="row-diagnostic-actions">
			{actions.map((action) =>
				action.kind === "button" ? (
					<Button
						key={action.id}
						variant={action.emphasized === true ? undefined : "secondary"}
						size="compact"
						aria-label={action.ariaLabel}
						// aria-disabled, not disabled: the attribute drops focus to the body and a changed accessible
						// name is announced only on the FOCUSED element, so this keeps the node focused; the handler
						// refuses the click instead.
						aria-disabled={action.disabled === true}
						onClick={() => {
							if (action.disabled !== true) {
								action.onClick();
							}
						}}
					>
						{/* Motion beside the reworded label: a static "Checking..." on a minute-long pass reads as
						    a stuck page. */}
						{action.busy === true ? <span className="spinner" aria-hidden="true" /> : null}
						{action.label}
					</Button>
				) : (
					<DocsLink key={action.id} href={action.href} label={action.ariaLabel}>
						{action.label}
					</DocsLink>
				)
			)}
		</div>
	);
}

export function ServerDiagnosticLine({ diagnostic }: { diagnostic: BandedDiagnostic }) {
	return (
		<ProblemBand
			severity={diagnostic.severity}
			subject="server"
			tone={diagnostic.tone}
			headline={diagnostic.headline}
			details={diagnostic.details}
			actions={<DiagnosticActions actions={diagnostic.actions} />}
		/>
	);
}

/**
 * A drawer-placed diagnostic as the inventory's leading row: the warn triangle beside the toned sentence, in the
 * facts' own register - no band, no rule, no box (USER-RULED 2026-08-17: a banner nested in the drawer card read as a
 * card inside a card, and its trailing seat left dead padding under the facts). The warn tier rides the glyph's SHAPE
 * and the text colour; the hidden tier word still leads, exactly like the banded lines.
 */
export function DrawerNoticeLine({ diagnostic }: { diagnostic: DrawerNotice }) {
	return (
		<div className={cn("drawer-notice", TONE_TEXT.warn)}>
			<IconWarning />
			<div className="drawer-notice-body">
				<p className="drawer-notice-text">
					<span className="visually-hidden">{severityLabel(diagnostic.severity, "server")} </span>
					{diagnostic.headline}
				</p>
				{(diagnostic.details ?? []).map((detail) => (
					<p key={detail} className="row-diagnostic-detail">
						{detail}
					</p>
				))}
				<DiagnosticActions actions={diagnostic.actions} />
			</div>
		</div>
	);
}

function inactiveSurfacesText(server: DashboardServer): string {
	return INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true)
		.map((notice) => INACTIVE_NOTICE_PRESENTATION[notice].surface())
		.join(", ");
}

function entryInactiveFixText(): string {
	return l10n.t(
		"The provider group serving this entry may not carry the entry's labeled identity. Delete the group's object from the models file (chatLanguageModels.json), reload the window, then run Sync models - or save the entry under a new label instead."
	);
}

/**
 * The row's discovery health, classified ONCE: the pill's word, the discovery diagnostic's severity, and (through the
 * ranked diagnostics) the dot's tone all render from this verdict, so a second state walk can never put "Error" beside
 * a warn dot again.
 */
export type ServerHealthVerdict =
	| "misconfigured"
	| "unchecked"
	/** Discovery is clean. */
	| "serving"
	/** The newest sync failed, but the group keeps serving models. */
	| "degraded"
	/** An unexpected failure, and nothing serves. */
	| "blocking"
	/** Failing only where the entry expects it, declared models serving. */
	| "expected"
	/** The expected category hit, and nothing is declared to serve through it. */
	| "expected-blocking";

export function serverHealth(server: DashboardServer): ServerHealthVerdict {
	if (server.origin === "misconfigured") {
		// Origin outranks state: the entry never reaches discovery.
		return "misconfigured";
	}
	switch (server.state) {
		case "unchecked":
			return "unchecked";
		case "ok":
			// A sync failure never rides an "ok" row: declaredOutcome turns it into an error row that keeps its served
			// count, so serving is unqualified.
			return "serving";
		case "error":
			if (server.expected === true) {
				// Serving through the declared-normal failure (declared models or the stale window) is the quiet
				// expected state; alarming would contradict the aggregate, which never counts expected failures as
				// failures.
				return server.servedModelCount > 0 ? "expected" : "expected-blocking";
			}
			// A group whose sync failed keeps serving what it had (servedModelCount counts the stale-window and
			// declared models); one with nothing serves nothing.
			return server.servedModelCount > 0 ? "degraded" : "blocking";
	}
}

/** Reasons are lowercase clauses across the whole drawer - they annotate a dash, they are not sentences. */
export function neverUpdatedText(standing: UsageEndpointStandingView): string {
	if (standing.kind === "unavailable") {
		return standing.reason === "forbidden"
			? l10n.t("this key isn't allowed to read its spend")
			: l10n.t("this server doesn't report spend");
	}
	return l10n.t("spend hasn't loaded for this server yet");
}

/**
 * The Spend fact's reason when /key/info gave no spend number, keyed by the standing: the ONE map for both drawers
 * (reporting and denied), so the wording cannot fork again.
 *
 *   The dash beside it -> already says the number is missing
 */
export function spendMissingReason(standing: UsageEndpointStandingView, pollingOff: boolean): string {
	switch (standing.kind) {
		case "unavailable":
			return standing.reason === "forbidden"
				? l10n.t("this key isn't allowed to read its spend")
				: l10n.t("this server doesn't report spend for this key");
		case "ok":
			return l10n.t("this server doesn't report spend for this key");
		case "unknown":
			return l10n.t("spend hasn't loaded for this server yet");
		case "error":
			return pollingOff
				? l10n.t("the last check failed; use Refresh now to try again")
				: l10n.t("the last check failed; it retries automatically with increasing delay");
	}
}

/** The path a detail line may print: only the shared table's strings ever reach a template. */
type UsageEndpointPath = (typeof USAGE_ENDPOINT_PATHS)[UsageEndpoint];

/**
 * The one English template for a forbidden endpoint standing, so pasted issue reports stay uniform; the fix and
 * re-probe live in the surrounding diagnostic, refusal alone here.
 */
function forbiddenLine(path: UsageEndpointPath, status: number | undefined): string {
	return `LiteLLM ${path}:${status !== undefined ? ` HTTP ${status} -` : ""} this key may not read usage data`;
}

function notServedLine(path: UsageEndpointPath, status: number | undefined): string {
	return `LiteLLM ${path}: not served on this server${status !== undefined ? ` (HTTP ${status})` : ""}`;
}

/**
 * English by policy (pasted into issue reports), built from closed enums and numbers only - response text never exists
 * here. The advisory headline already says whether a retry is automatic; no branch repeats it.
 */
export function keyInfoDetail(server: UsageServerView, discoveryTimeoutMs: number): string | undefined {
	const standing = server.keyInfo;
	const path = USAGE_ENDPOINT_PATHS.keyInfo;
	switch (standing.kind) {
		case "ok":
			return server.spend === undefined ? `LiteLLM ${path}: OK, no spend field` : undefined;
		case "unknown":
			return server.spend === undefined ? `LiteLLM ${path}: waiting on the first fetch` : undefined;
		case "unavailable":
			return standing.reason === "forbidden"
				? forbiddenLine(path, standing.status)
				: `${notServedLine(path, standing.status)}; request stats still update`;
		case "error": {
			if (standing.classification === "timeout") {
				return `LiteLLM ${path}: timed out after ${discoveryTimeoutMs}ms (whole-call bound incl. retries). If the server is just slow, raise the discovery.timeout setting.`;
			}
			const how =
				standing.status !== undefined
					? `HTTP ${standing.status}`
					: standing.classification === "network"
						? "network error"
						: "request failed";
			return `LiteLLM ${path}: ${how} on the last attempt`;
		}
	}
}

/** The /user/daily/activity detail line, same English-template rules as keyInfoDetail. */
export function activityDetail(server: UsageServerView): string | undefined {
	const standing = server.dailyActivity;
	const path = USAGE_ENDPOINT_PATHS.dailyActivity;
	switch (standing.kind) {
		case "ok":
		case "unknown":
			return undefined;
		case "unavailable":
			// Unsupported needs no detail: the fact's own reason covers it.
			return standing.reason === "forbidden" ? forbiddenLine(path, standing.status) : undefined;
		case "error": {
			const how =
				standing.status !== undefined
					? `HTTP ${standing.status}`
					: standing.classification === "timeout"
						? "timed out"
						: standing.classification === "network"
							? "network error"
							: "request failed";
			return `LiteLLM ${path}: ${how}`;
		}
	}
}

/**
 * The Requests fact's reason when /user/daily/activity has no retained window, keyed by the standing: the one map for
 * both drawers. The Refresh now remedy for a denied key lives in the row's diagnostic, not here.
 */
export function requestsMissingReason(standing: UsageEndpointStandingView): string {
	if (standing.kind === "unavailable") {
		return standing.reason === "forbidden"
			? l10n.t("this key isn't allowed to read request statistics on this server")
			: l10n.t("this server does not serve /user/daily/activity (a normal shape on some setups)");
	}
	return l10n.t("couldn't be fetched yet - retries on the next refresh");
}

/**
 * The English detail line for one denied endpoint standing (a mixed 404-plus-403 server states both facts); same
 * English-by-policy, closed-enums-only rules as keyInfoDetail. Takes the endpoint id so the printed path can only come
 * from the shared table.
 */
function forbiddenRowDetail(endpoint: UsageEndpoint, standing: UsageEndpointStandingView): string | undefined {
	if (standing.kind !== "unavailable") {
		return undefined;
	}
	const path = USAGE_ENDPOINT_PATHS[endpoint];
	return standing.reason === "forbidden" ? forbiddenLine(path, standing.status) : notServedLine(path, standing.status);
}
