import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { Fragment, useEffect, useId, useState } from "react";
import { latestCheckedMs } from "../../dashboard/presenters";
import { parseCapabilityGroups, parseGroups, toGroups } from "../../dashboard/recordDraft";
import { sectionFailureText, serverFormFieldLabel } from "../../dashboard/serverForm";
import { barPresentation, formatMoney, formatPercent, spendTone, worstSpendTone } from "../../dashboard/spendFormat";
import type { UsageEndpointId } from "../../dashboard/usageEndpoints";
import { USAGE_ENDPOINT_PATHS } from "../../dashboard/usageEndpoints";
import type {
	DashboardServer,
	DashboardUsage,
	ExternalDashboardServer,
	HiddenGroup,
	InactiveEntryNotice,
	UsageEndpointStandingView,
	UsageForbiddenServerView,
	UsageServerCardView,
	UsageServerView,
} from "../../dashboard/viewModels";
import type { ExpectedFailureCategory } from "../../shared/serverEntry";
import { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";
import type { DocsUrl } from "./docsLinks";
import {
	DOCS_LINK_AUTHENTICATION,
	DOCS_LINK_OPENAI_COMPATIBLE,
	DOCS_LINK_PARAMS_INACTIVE,
	DOCS_LINK_SERVERS,
} from "./docsLinks";
import { FailureText } from "./failureText";
import { DocsLink } from "./help";
import { helpServersSection } from "./helpText";
import { useIntentOutcome } from "./hooks";
import { IconAdd, IconWarning } from "./icons";
import { ProblemBand } from "./problemBand";
import { capabilityIssueViews, type GroupIssueView, paramIssueViews, RecordMatcherTable } from "./recordEditors";
import { troubleshootingLink } from "./serverEditPage";
import { type DiagnosticSeverity, SEVERITY_ORDER, severityLabel } from "./severity";
import { TONE_FILL, TONE_TEXT } from "./spendTones";
import { relativeTime } from "./time";
import { AbsentDatum } from "./ui/absent";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { DisclosureChevron } from "./ui/disclosureChevron";
import { Section } from "./ui/section";
import { sendRequest } from "./vscodeApi";

/**
 * Every inactive notice's user-facing phrase; the satisfies clause fails to compile until a
 * new notice is named here. Zero-arg functions, so strings resolve after the l10n bootstrap.
 */
const INACTIVE_NOTICE_PRESENTATION = {
	"entry-params-inactive": {
		surface: () => l10n.t("per-server model parameters"),
	},
	"entry-capabilities-inactive": {
		surface: () => l10n.t("per-server model capabilities, declared models, and expected failures"),
	},
	"entry-headers-inactive": {
		surface: () => l10n.t("per-server custom headers"),
	},
	"entry-api-version-inactive": {
		// The consequence rides the phrase: uniquely here, the surface silently falls back to
		// a different rule rather than simply not applying.
		surface: () => l10n.t("per-server API version overrides (requests use the auto rule)"),
	},
} as const satisfies Record<InactiveEntryNotice, { surface: () => string }>;

const INACTIVE_NOTICES = Object.keys(INACTIVE_NOTICE_PRESENTATION) as readonly InactiveEntryNotice[];

/*
 * This page's reading of ./severity.ts, ranked by what a problem costs the server's purpose:
 * "blocking" serves nothing until someone acts; "degraded" needs a human even if models serve
 * (a refused usage key counts - user-ruled); "advisory" needs nobody and still renders whole,
 * only tint and attention count reduced. The tiers are what the summary line counts, so a
 * tier is a promise about whether someone has to act, not a volume knob.
 */

/**
 * One action offered beside a problem: it REVEALS where a human fixes it, or retries - never
 * a silent settings edit. The one exception, declare-expected, appends one closed-vocabulary
 * token (discovery.expectedFailures) behind an explicit confirm that named what it writes.
 */
type DiagnosticAction =
	/**
	 * `ariaLabel` names the server (the buttons repeat down the page); the visible label stays
	 * the short verb and stays inside the accessible name, as Label in Name requires.
	 */
	| {
			readonly kind: "button";
			/**
			 * Stable across renders and independent of the label: keying by text rebuilds the
			 * node the instant its wording changes, throwing away the reader's focus.
			 */
			readonly id: string;
			readonly label: string;
			readonly ariaLabel: string;
			/** In flight: the control states that it is working and refuses a second click. */
			readonly disabled?: boolean | undefined;
			/** In flight: the spinner beside the label, so a minute-long pass shows motion. */
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

/** What a problem line carries wherever it sits; the seat arms below add the seat's own fields. */
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
 * A banded line whose paint tier comes from the user's usage.alertThresholds rather than the
 * severity ladder alone: past the error threshold (or past the budget) the tone lifts the
 * band to the error tier, USER-RULED (2026-08-17: error-tier money problems wear error
 * colour everywhere they render). Paint only - the severity keeps the ranking, the pill,
 * and the hidden tier word. Degraded by construction: a blocking line is already error-tier,
 * and an advisory means nothing is wrong, so neither has a tone to lift.
 */
interface SpendErrorDiagnostic extends DiagnosticBase {
	readonly severity: "degraded";
	readonly tone: "error";
	readonly placement?: undefined;
}

/**
 * The drawer seat, USER-RULED (2026-08-16) for the sub-error budget-pressure line: the tinted
 * meter already signals it. The diagnostic still ranks the pill and the attention count either
 * way. Warn-tier by construction - the tone field can only be absent here, so nothing can ask
 * the notice for a hue its triangle and its text do not have.
 */
interface DrawerNotice extends DiagnosticBase {
	readonly placement: "drawer";
	readonly tone?: undefined;
}

/** The two banded seats, which ServerDiagnosticLine renders. */
type BandedDiagnostic = CollapsedDiagnostic | SpendErrorDiagnostic;

type RowDiagnostic = BandedDiagnostic | DrawerNotice;

/** A single optional detail as the details list: [] renders nothing, exactly like the old absent field. */
function detailLines(...lines: readonly (string | undefined)[]): readonly string[] {
	return lines.filter((line): line is string => line !== undefined);
}

/** What one row's diagnostics need to rank spend problems; all of it rides the pushed usage snapshot. */
interface SpendContext {
	readonly thresholds: readonly number[];
	readonly currencySymbol: string;
	/** Background polling is off (usage.pollInterval 0); retry copy names Refresh now instead of the automatic retry. */
	readonly pollingOff: boolean;
	/** The effective discovery.timeout; the timeout detail line prints it. */
	readonly discoveryTimeoutMs: number;
}

/** The two usage endpoints whose standings turn into English detail lines. */
type UsageEndpoint = Extract<UsageEndpointId, "keyInfo" | "dailyActivity">;

/** One row's problems plus the usage endpoints whose detail line a diagnostic carries. */
interface RowDiagnostics {
	/** Every problem the server has, worst first. */
	readonly lines: readonly RowDiagnostic[];
	/** The drawer's inventory prints only the endpoint details NOT in this set, so a line never doubles or drops. */
	readonly usageDetailsCarried: ReadonlySet<UsageEndpoint>;
}

/** Every problem one server has, attached to the row that owns it. */
function serverDiagnostics(
	server: DashboardServer,
	/** The row's usage card (denied cards included); its problems rank beside the discovery ones. */
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
	// The two-step declare control: the plain button arms, the armed pair
	// confirms or cancels (the Remove idiom). Only rows wired with the
	// callbacks - declared entries - get any of it.
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
					// The committing half of the armed pair leads; Cancel stays quiet.
					emphasized: true,
					// The pair stays armed through the round trip so this button can
					// state "Declaring..."; the row disarms when the outcome lands.
					onClick: () => onDeclareExpected(category),
				},
				{
					kind: "button",
					id: `declare-cancel-${category}`,
					label: l10n.t("Cancel"),
					ariaLabel: l10n.t("Cancel declaring the expected failure for {0}", server.label),
					// A posted write cannot be cancelled; an enabled Cancel beside
					// "Declaring..." would claim otherwise. It only ever disarms.
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
	// The endpoint-declaration diagnostics' shared guide link (the new
	// troubleshooting section covering Ollama/vLLM/plain-OpenAI servers).
	const openAiCompatibleGuide: DiagnosticAction = {
		kind: "docs",
		id: "openai-compatible-guide",
		href: DOCS_LINK_OPENAI_COMPATIBLE,
		label: l10n.t("Learn more"),
		ariaLabel: l10n.t("Learn more: the OpenAI-compatible servers guide"),
	};
	// A discovery pass can take tens of seconds (the per-request timeouts sum), so the
	// in-flight Retry relabels and spins. Only the asking row SAYS it is checking, but every
	// Retry disables while a pass runs: the command is fleet-wide, so no row may queue another.
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
			// The consequence first: the entry is not merely invalid, it is switched
			// off, and no amount of retrying changes that.
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
	const error = server.error;
	const inactive = INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true);
	// The one health walk: this branch's severity and the pill's word read the same verdict.
	const verdict = serverHealth(server);
	if (error !== undefined && server.origin !== "misconfigured") {
		const headline = statusErrorHeadline(error);
		if (verdict === "degraded" || verdict === "blocking") {
			// A live group whose sync failed keeps serving what it had (degraded);
			// one that has nothing serves nothing (blocking).
			const serving = verdict === "degraded";
			// Where the declare action is withheld, the identity fix rides the details - unless
			// the entry-inactive line below renders and says the same sentence itself.
			const declareWithheld =
				server.origin === "declared" &&
				server.classification?.unsupportedEndpoint === "modelListing" &&
				server.entryFieldsInactive === true;
			// The declaration-suggesting transport string is atomic (toasts show it whole) and
			// leads with the remediation, so the swap happens here: a short consequence clause
			// takes the headline's slot and the advice rides the detail lines.
			const declarationAdvice = server.classification?.unsupportedEndpoint === "modelListing";
			const cause = declarationAdvice ? l10n.t("the server answers, but its models listing fails.") : headline;
			found.push({
				key: "discovery-error",
				severity: verdict,
				headline: serving
					? l10n.t("{0} is serving its last known models; the newest sync failed: {1}", server.label, cause)
					: l10n.t("{0} is serving no models: {1}", server.label, cause),
				details: detailLines(
					declarationAdvice ? headline : undefined,
					statusErrorDetail(error),
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
					...(server.origin === "declared" && server.classification?.unsupportedEndpoint === "modelListing"
						? [
								// The error's declaration advice (riding the detail lines,
								// transport proved the shape) already spells the fix; this is
								// its one-click form, writing exactly the category the advice
								// names - withheld when the group did not join by the entry's
								// identity (the details then carry the identity fix), because
								// the written declaration may not reach it (the same
								// classification the advisory tier keys on).
								...(declareWithheld ? [] : declareActions("modelListing")),
								openAiCompatibleGuide,
							]
						: []),
					...(server.classification?.setupHint !== undefined
						? [
								{
									kind: "docs" as const,
									id: "troubleshoot",
									// The helper's `label` is a whole sentence for surfaces that
									// SHOW it; here the visible text is the short verb, so the
									// accessible name must lead with that verb (Label in Name)
									// and the helper's `topic` supplies the distinguishing tail.
									// Do not spread the helper over these - it carries its own
									// `label` and would put the long sentence on screen.
									href: troubleshootingLink(server.classification.setupHint).href,
									label: l10n.t("Troubleshoot"),
									ariaLabel: l10n.t("Troubleshoot: {0}", troubleshootingLink(server.classification.setupHint).topic),
								},
							]
						: []),
				],
			});
		} else if (verdict === "expected") {
			// Quiet tier: the entry declared this failure and something still serves
			// through it - its declared models, or the stale window's last known
			// list. The server's own words ride the detail lines, not the headline
			// (colon chaining).
			const declared = server.declaredModelCount ?? 0;
			found.push({
				key: "expected-serving",
				severity: "advisory",
				headline:
					declared === 1
						? l10n.t("{0} serves 1 declared model; discovery fails only where this entry expects it to.", server.label)
						: declared > 1
							? l10n.t(
									"{0} serves {1} declared models; discovery fails only where this entry expects it to.",
									server.label,
									declared
								)
							: l10n.t(
									"{0} serves its last known models; discovery fails only where this entry expects it to.",
									server.label
								),
				details: detailLines(headline, statusErrorDetail(error)),
				actions: [],
			});
		} else {
			found.push({
				// Serves nothing at all: blocking. The expected category makes the CAUSE
				// unsurprising; it does not put any models in the picker.
				key: "expected-nothing-declared",
				severity: "blocking",
				headline: l10n.t(
					"{0} serves no models: discovery fails in a category this entry expects ({1}), and nothing is declared.",
					server.label,
					headline
				),
				details: detailLines(statusErrorDetail(error)),
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
		// Quiet tier: the models serve and the config applies. Declaring marks the failing
		// probe as normal (single attempt, info log) - it does NOT shorten the probe's wait,
		// so the copy promises the marking, never speed. The one-click write is withheld when
		// the group did not join by the entry's identity; the details then carry the fix.
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
			// English by policy for the endpoint facts; the identity fix rides
			// localized, like the entry-inactive line it comes from.
			details: detailLines(
				server.modelInfoUnsupported === "timeout"
					? 'GET /model/info times out; GET /models succeeds. The action writes "expectedFailures": ["modelInfo"] on this entry.'
					: 'GET /model/info answers HTTP 404/405; GET /models succeeds. The action writes "expectedFailures": ["modelInfo"] on this entry.',
				withheld && inactive.length === 0 ? entryInactiveFixText() : undefined
			),
			actions: [...(withheld ? [] : declareActions("modelInfo")), openAiCompatibleGuide],
		});
	}
	if (inactive.length > 0) {
		// One line for every inactive surface: cause and fix are identical for all. Degraded,
		// not advisory - the group may be serving WITHOUT settings the user wrote, and
		// advisory would keep these rows out of the summary count.
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
					// Docs accessible names LEAD with the visible verb (Label in Name), with the
					// destination as the distinguishing tail.
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
 * The row's spend and usage problems, ranked by the same tiers as everything else on it: one
 * classifier, so the summary count can never disagree with what a row renders. Every English
 * endpoint detail a diagnostic carries is recorded through `carry`, so the drawer's remainder
 * derives from the emissions themselves rather than a hand-copied predicate.
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
	// Attaching an endpoint's detail to a diagnostic and marking it consumed are one move;
	// an absent detail marks nothing, so "carried" always means "a diagnostic prints it".
	const carry = (endpoint: UsageEndpoint, detail: string | undefined): string | undefined => {
		if (detail !== undefined) {
			carried.add(endpoint);
		}
		return detail;
	};
	// The fix every usage problem shares: the fleet-wide refreshUsage intent. Disabled during
	// ANY pass (one serialized engine); the busy label only for an explicit one.
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
		// USER RULING (2026-08-14): a denied usage key is DEGRADED, not advisory - nothing
		// here clears itself; only a human can change the key's permission.
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
		// The same user-ruled tier as the whole-card denial: a permission only a human can
		// fix, so it counts.
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
		// ADVISORY STILL RENDERS IN FULL - the tier's contract: headline, English detail, and
		// Refresh now render exactly as a degraded line's would; only tint and count reduce.
		// With polling off nothing retries, so the headline names the manual path.
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
		// Degraded per the tier contract: the reader set the budget to be told before it runs
		// out. The line says how far past or how much is left; no action fixes a budget.
		// The shared map owns the whole tone decision - past the whole budget it is error even
		// with an empty threshold list - so line, meter fill, and status bar cannot split. The
		// tone also picks the seat: warn waits in the drawer (the tinted meter already signals
		// it), error stays banded on the collapsed row in the error hue.
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
			const line = {
				key: overBudget ? "over-budget" : "budget-pressure",
				severity: "degraded",
				// The meter's freshness rule, the same `fresh` field: a non-fresh number
				// still shows, but never unqualified.
				headline: card.fresh ? figures : `${figures} ${l10n.t("The spend number is stale and may be out of date.")}`,
				actions: [],
			} as const;
			found.push(tone === "warn" ? { ...line, placement: "drawer" } : { ...line, tone: "error" });
		}
	}
	return { lines: found, usageDetailsCarried: carried };
}

/** A diagnostic's action cluster, one embodiment for the banded lines and the drawer notices. */
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
						// aria-disabled, not disabled: the attribute drops focus to the body and a
						// changed accessible name is announced only on the FOCUSED element, so this
						// keeps the node focused; the handler refuses the click instead.
						aria-disabled={action.disabled === true}
						onClick={() => {
							if (action.disabled !== true) {
								action.onClick();
							}
						}}
					>
						{/* Motion beside the reworded label: a static "Checking..." on a
						    minute-long pass reads as a stuck page. */}
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

/**
 * One problem, indented under the row that owns it, through the one band pipeline: the
 * severity ranks it, the spend tone may lift its paint tier, and ProblemBand turns that
 * pair into the band's bar, hue, and headline text.
 */
function ServerDiagnosticLine({ diagnostic }: { diagnostic: BandedDiagnostic }) {
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
 * A drawer-placed diagnostic as the inventory's leading row: the warn triangle beside the
 * toned sentence, in the facts' own register - no band, no rule, no box (USER-RULED
 * 2026-08-17: a banner nested in the drawer card read as a card inside a card, and its
 * trailing seat left dead padding under the facts). The warn tier rides the glyph's SHAPE and
 * the text colour; the hidden tier word still leads, exactly like the banded lines.
 */
function DrawerNoticeLine({ diagnostic }: { diagnostic: DrawerNotice }) {
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

/** The row's inactive surfaces as one localized phrase, resolved at call time. */
function inactiveSurfacesText(server: DashboardServer): string {
	return INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true)
		.map((notice) => INACTIVE_NOTICE_PRESENTATION[notice].surface())
		.join(", ");
}

/**
 * The identity fix, spelled once: reused by every diagnostic that withholds a one-click
 * entry write because the group may not carry the entry's labeled identity.
 */
function entryInactiveFixText(): string {
	return l10n.t(
		"The provider group serving this entry may not carry the entry's labeled identity. Delete the group's object from the models file (chatLanguageModels.json), reload the window, then run Sync models - or save the entry under a new label instead."
	);
}

/**
 * The row's discovery health, classified ONCE: the pill's word, the discovery diagnostic's
 * severity, and (through the ranked diagnostics) the dot's tone all render from this verdict,
 * so a second state walk can never put "Error" beside a warn dot again.
 */
type ServerHealthVerdict =
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

function serverHealth(server: DashboardServer): ServerHealthVerdict {
	if (server.origin === "misconfigured") {
		// Origin outranks state: the entry never reaches discovery.
		return "misconfigured";
	}
	switch (server.state) {
		case "unchecked":
			return "unchecked";
		case "ok":
			return server.error === undefined ? "serving" : "degraded";
		case "error":
			if (server.expected === true) {
				// Serving through the declared-normal failure (declared models or the
				// stale window) is the quiet expected state; alarming would contradict
				// the aggregate, which never counts expected failures as failures.
				return server.servedModelCount > 0 ? "expected" : "expected-blocking";
			}
			// A group whose sync failed keeps serving what it had (servedModelCount
			// counts the stale-window and declared models); one with nothing serves nothing.
			return server.servedModelCount > 0 ? "degraded" : "blocking";
	}
}

/**
 * The dot's tone, derived from the row's WORST diagnostic - one classifier, never a second
 * computed beside it. An advisory-only row stays plain "ok": an advisory means nothing is
 * wrong, and tinting the dot for one would be the false alarm the tier itself refuses.
 */
function pillTone(
	verdict: ServerHealthVerdict,
	worst: DiagnosticSeverity | undefined
): "ok" | "warn" | "error" | "muted" {
	if (verdict === "unchecked") {
		// No verdict to tone yet - and no diagnostic either, which would read as health.
		return "muted";
	}
	switch (worst) {
		case "blocking":
			return "error";
		case "degraded":
			return "warn";
		default:
			return "ok";
	}
}

/**
 * The verdict said in words. Words only, no hover tips: the pill sits inside the
 * disclosure button, and a focusable tip wrapper inside a button is a nesting fault.
 */
function pillVerdict(verdict: ServerHealthVerdict): string {
	switch (verdict) {
		case "misconfigured":
			return l10n.t("Misconfigured");
		case "unchecked":
			return l10n.t("Not checked");
		case "serving":
			return l10n.t("Connected");
		case "degraded":
			// Serving through a failed sync, whichever state carries it - the same
			// degraded rank the row's diagnostic holds, so word and dot agree.
			return l10n.t("Sync issue");
		case "blocking":
			return l10n.t("Error");
		case "expected":
			// One state, one name across tabs: still-serving reads Connected here exactly as
			// the Diagnostics grid reads it OK.
			return l10n.t("Connected");
		case "expected-blocking":
			return l10n.t("Expected failure");
	}
}

/**
 * The row's status pill: tone dot, verdict, and discovery age. Word and tone read the same
 * classifiers the row's diagnostics rank by, so the pill can never drift from the lines.
 */
function StatusPill({
	server,
	worst,
	now,
}: {
	server: DashboardServer;
	/** The row's worst diagnostic severity; absent when the row has no problems. */
	worst: DiagnosticSeverity | undefined;
	now: number;
}) {
	const verdict = serverHealth(server);
	const checked = server.lastChecked === undefined ? undefined : relativeTime(server.lastChecked, now);
	// An unchecked row has no time to show, and "just now" would be a lie.
	const time = checked === undefined || verdict === "unchecked" ? null : <span className="pill-time">{checked}</span>;
	return (
		<span className={`pill tone-${pillTone(verdict, worst)}`}>
			<span className="dot" />
			{pillVerdict(verdict)}
			{time}
		</span>
	);
}

/**
 * The external row's provenance, the drawer's Origin fact; the copy lives here because
 * classifications cross the boundary, words do not. Deletion instructions name the models
 * file: VS Code offers extensions no group removal, so the file is where deleting lives.
 */
function externalTip(server: ExternalDashboardServer): string {
	const provenance = server.provenance;
	if (provenance?.kind === "removed-entry-leftover") {
		return l10n.t(
			'Leftover of the removed entry "{0}". Remove hides its models; deleting its object from the models file erases it.',
			provenance.removedLabel
		);
	}
	if (provenance?.kind === "rename-leftover") {
		return l10n.t(
			'Leftover of renaming "{0}" to "{1}". Its models show under both names until its object is deleted from the models file.',
			provenance.oldLabel,
			provenance.newLabel
		);
	}
	return l10n.t(
		"No entry in the servers setting: added outside this extension, or predates its tracking. Edit adopts it."
	);
}

/**
 * The row's spend-at-a-glance: the budget percentage over the meter, the plain amount when
 * no budget gives a percentage meaning, nothing for a server without usage data (an empty
 * cell, not an "unknown" marker). The glance is the fraction; the drawer is the figures.
 */
function SpendUnit({
	usage,
	thresholds,
	currencySymbol,
}: {
	usage: UsageServerView | undefined;
	thresholds: readonly number[];
	currencySymbol: string;
}) {
	if (usage?.spend === undefined) {
		return null;
	}
	// EVERY non-fresh number wears the qualifier, whatever the cause (the header's "worst
	// budget use" excludes stale rows, so an unmarked 112% would contradict it). It leads the
	// figure ON ITS LINE, never a line of its own: the mark lands asynchronously, and a third
	// line moved every row below it (the .server-usage floor absorbs the word's width).
	const note = usage.fresh ? null : (
		<span className="spend-note font-sans text-[0.92em] text-warn">{l10n.t("stale")} </span>
	);
	// The hidden noun says what the number is to a screen reader; hidden text rather than an
	// aria-label because a plain span has no role that supports one.
	if (usage.spentFraction !== undefined) {
		const bar = barPresentation(usage.spentFraction, thresholds);
		return (
			<span className="spend-unit">
				<span className={cn("font-mono text-[0.92em] tabular-nums", TONE_TEXT[bar.tone])}>
					<span className="visually-hidden">{l10n.t("Budget spent:")} </span>
					{note}
					{formatPercent(usage.spentFraction)}
				</span>
				{/* A baseline, not a track: a track colour cannot clear 3:1 against both page and
				    fill at once (measured on Light Modern), so the extent is a 1px axis and the
				    fill keeps its saturated tones. Content-box sizing (no preflight): h-[3px]
				    plus the border is a 4px meter. The fill names its forced-colors colour at
				    the call site - backgrounds flatten to Canvas while the axis border forces to
				    CanvasText, and an unhandled fill would read as a measured zero, the exact
				    reading the axis-less no-budget branch exists to avoid. */}
				<span className="spend-meter h-[3px] overflow-hidden rounded-xs border-axis border-b" aria-hidden="true">
					<span
						className={cn("block h-full forced-colors:bg-[Highlight]", TONE_FILL[bar.tone])}
						style={{ width: `${bar.widthPercent}%` }}
					/>
				</span>
			</span>
		);
	}
	return (
		<span className="spend-unit">
			<span className="font-mono text-[0.92em] tabular-nums">
				<span className="visually-hidden">{l10n.t("Spent:")} </span>
				{note}
				{formatMoney(usage.spend, currencySymbol)}
			</span>
		</span>
	);
}

/**
 * Why a server has never reported spend, per the /key/info standing. Reasons are lowercase
 * clauses across the whole drawer - they annotate a dash, they are not sentences.
 */
function neverUpdatedText(standing: UsageEndpointStandingView): string {
	if (standing.kind === "unavailable") {
		return standing.reason === "forbidden"
			? l10n.t("this key isn't allowed to read its spend")
			: l10n.t("this server doesn't report spend");
	}
	return l10n.t("spend hasn't loaded for this server yet");
}

/**
 * What is wrong with a non-fresh age, in the row annotation's own words so marker and drawer
 * never name the state differently: the state has ONE term ("stale", the row marker's word),
 * and the drawer adds the cause instead where one is known. Undefined while the data is fresh.
 */
function stalenessText(server: UsageServerView): string | undefined {
	if (server.fresh) {
		return undefined;
	}
	if (server.keyInfo.kind === "error") {
		return l10n.t("last refresh failed");
	}
	if (server.keyInfo.kind === "unavailable" && server.keyInfo.reason === "forbidden") {
		return l10n.t("usage access denied");
	}
	// Merely old (laptop asleep, polling off): the plain history marker, the row's own word.
	return l10n.t("stale");
}

/**
 * The Spend fact's reason when /key/info gave no spend number, keyed by the standing: the ONE
 * map for both drawers (reporting and denied), so the wording cannot fork again. The dash
 * beside it already says the number is missing, and the remedy lives in the row's diagnostic,
 * so no branch restates either.
 */
function spendMissingReason(standing: UsageEndpointStandingView, pollingOff: boolean): string {
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
 * The one English template for a forbidden endpoint standing, so pasted issue reports stay
 * uniform; the fix and re-probe live in the surrounding diagnostic, refusal alone here.
 */
function forbiddenLine(path: UsageEndpointPath, status: number | undefined): string {
	return `LiteLLM ${path}:${status !== undefined ? ` HTTP ${status} -` : ""} this key may not read usage data`;
}

/** forbiddenLine's unsupported twin: one template for an endpoint this server does not serve. */
function notServedLine(path: UsageEndpointPath, status: number | undefined): string {
	return `LiteLLM ${path}: not served on this server${status !== undefined ? ` (HTTP ${status})` : ""}`;
}

/**
 * The /key/info technical detail, undefined when nothing is wrong. English by policy (pasted
 * into issue reports), built from closed enums and numbers only - response text never exists
 * here. The advisory headline already says whether a retry is automatic; no branch repeats it.
 */
function keyInfoDetail(server: UsageServerView, discoveryTimeoutMs: number): string | undefined {
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
function activityDetail(server: UsageServerView): string | undefined {
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
 * The Requests fact's reason when /user/daily/activity has no retained window, keyed by the
 * standing: the one map for both drawers. The Refresh now remedy for a denied key lives in
 * the row's diagnostic, not here.
 */
function requestsMissingReason(standing: UsageEndpointStandingView): string {
	if (standing.kind === "unavailable") {
		return standing.reason === "forbidden"
			? l10n.t("this key isn't allowed to read request statistics on this server")
			: l10n.t("this server does not serve /user/daily/activity (a normal shape on some setups)");
	}
	return l10n.t("couldn't be fetched yet - retries on the next refresh");
}

/**
 * The English detail line for one denied endpoint standing (a mixed 404-plus-403 server
 * states both facts); same English-by-policy, closed-enums-only rules as keyInfoDetail.
 * Takes the endpoint id so the printed path can only come from the shared table.
 */
function forbiddenRowDetail(endpoint: UsageEndpoint, standing: UsageEndpointStandingView): string | undefined {
	if (standing.kind !== "unavailable") {
		return undefined;
	}
	const path = USAGE_ENDPOINT_PATHS[endpoint];
	return standing.reason === "forbidden" ? forbiddenLine(path, standing.status) : notServedLine(path, standing.status);
}

/** One fact row: every fact has the same shape, so a half-reported server reads like a full one. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground @max-[560px]/pane:text-[0.92em]">{label}</dt>
			<dd className="m-0 font-mono text-[0.92em] tabular-nums @max-[560px]/pane:mb-1">{children}</dd>
		</>
	);
}

/**
 * A number this server did not report (ui/absent.tsx owns the dash-plus-words contract); a
 * fact with a reason of its own says it visibly, as a Why in place.
 */
function Absent({ reason }: { reason?: string | undefined }) {
	return (
		<AbsentDatum className="text-muted-foreground">
			{reason === undefined ? undefined : <Why text={reason} />}
		</AbsentDatum>
	);
}

/** The prose annotation beside a fact: provenance for a value, the cause for an absence. */
function Why({ text }: { text: string }) {
	return <span className="ml-2.5 font-sans text-[0.92em] text-muted-foreground">{text}</span>;
}

/** The budget fact's provenance, so a number that came from the key never reads as one the user set. */
function BudgetFact({ server, currencySymbol }: { server: UsageServerView; currencySymbol: string }) {
	if (server.effectiveBudget === undefined) {
		return (
			<Fact label={l10n.t("Budget")}>
				{/* The reason states what to do, not what the reader can see: the
				    empty spend meter beside the row already says nothing is measured
				    against, so this line does not repeat it. */}
				<Absent
					reason={l10n.t("neither this entry nor the key sets one; set one with Edit, or on the key in LiteLLM")}
				/>
			</Fact>
		);
	}
	const alsoKey =
		server.budgetSource === "entry" && server.keyBudget !== undefined && server.keyBudget !== server.effectiveBudget;
	return (
		<Fact label={l10n.t("Budget")}>
			{formatMoney(server.effectiveBudget, currencySymbol)}
			{alsoKey ? (
				<Why
					text={l10n.t("set on this entry - the key reports {0}", formatMoney(server.keyBudget ?? 0, currencySymbol))}
				/>
			) : (
				<Why text={server.budgetSource === "entry" ? l10n.t("set on this entry") : l10n.t("reported by the key")} />
			)}
		</Fact>
	);
}

/**
 * The request-statistics facts. A missing window has exactly ONE cause, stated once on the
 * Requests fact; the computed rates show bare dashes (visually-hidden "not reported" intact). The
 * present-window branch keeps per-dash reasons - there the denominators miss independently.
 */
function RequestFacts({ server }: { server: UsageServerView }) {
	// Retained statistics from a failing endpoint must not read as current: spend freshness
	// says nothing about the activity window. "unknown" stays unmarked - nothing failed yet.
	const outdated = server.dailyActivity.kind === "error" || server.dailyActivity.kind === "unavailable";
	const requests = server.requests;
	if (requests === undefined) {
		return (
			<>
				<Fact label={l10n.t("Requests, 30 days")}>
					<Absent reason={requestsMissingReason(server.dailyActivity)} />
				</Fact>
				<Fact label={l10n.t("Success rate")}>
					<Absent />
				</Fact>
				<Fact label={l10n.t("Cache hit rate")}>
					<Absent />
				</Fact>
			</>
		);
	}
	return (
		<>
			<Fact label={l10n.t("Requests, 30 days")}>
				{requests.total.toLocaleString()}
				{outdated ? <Why text={l10n.t("may be outdated: the last statistics fetch failed")} /> : null}
			</Fact>
			<Fact label={l10n.t("Success rate")}>
				{requests.successRate !== undefined ? (
					formatPercent(requests.successRate)
				) : (
					<Absent reason={l10n.t("no requests in the window to compute it from")} />
				)}
			</Fact>
			<Fact label={l10n.t("Cache hit rate")}>
				{requests.cacheHitRate !== undefined ? (
					formatPercent(requests.cacheHitRate)
				) : (
					<Absent reason={l10n.t("the window reports no prompt tokens")} />
				)}
			</Fact>
		</>
	);
}

/** The usage half of the drawer's inventory: every spend fact, present or stated missing. */
function UsageFacts({
	server,
	pollingOff,
	now,
	currencySymbol,
}: {
	server: UsageServerView;
	pollingOff: boolean;
	now: number;
	currencySymbol: string;
}) {
	const staleness = stalenessText(server);
	const spendReason = server.spend === undefined ? spendMissingReason(server.keyInfo, pollingOff) : undefined;
	// On a never-fetched server both facts would answer with the same sentence; the second
	// drops its reason rather than repeating the first word for word.
	const neverUpdated = neverUpdatedText(server.keyInfo);
	return (
		<>
			<Fact label={l10n.t("Spend")}>
				{server.spend !== undefined ? formatMoney(server.spend, currencySymbol) : <Absent reason={spendReason} />}
			</Fact>
			<BudgetFact server={server} currencySymbol={currencySymbol} />
			<Fact label={l10n.t("Next reset")}>
				{server.budgetResetAt !== undefined ? (
					new Date(server.budgetResetAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
				) : (
					<Absent reason={l10n.t("the key does not report a reset date")} />
				)}
			</Fact>
			<RequestFacts server={server} />
			<Fact label={l10n.t("Spend last updated")}>
				{server.lastUpdatedAt === undefined ? (
					<Absent reason={neverUpdated === spendReason ? undefined : neverUpdated} />
				) : (
					<span className={server.fresh ? undefined : "text-warn"}>
						{relativeTime(new Date(server.lastUpdatedAt).toISOString(), now) ?? l10n.t("just now")}
						{staleness !== undefined ? <Why text={staleness} /> : null}
					</span>
				)}
			</Fact>
		</>
	);
}

/**
 * The usage facts a denied key left without numbers: the SAME rows as a reporting server's,
 * dashed, so a denied drawer does not look like a shorter kind of server. Reasons come from
 * the same per-fact maps the reporting drawer reads, one per refused endpoint, on the fact
 * that owns it; the remedy lives in the row's diagnostic.
 */
function DeniedUsageFacts({ card, pollingOff }: { card: UsageForbiddenServerView; pollingOff: boolean }) {
	return (
		<>
			<Fact label={l10n.t("Spend")}>
				<Absent reason={spendMissingReason(card.keyInfo, pollingOff)} />
			</Fact>
			<Fact label={l10n.t("Budget")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Next reset")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Requests, 30 days")}>
				<Absent reason={requestsMissingReason(card.dailyActivity)} />
			</Fact>
			<Fact label={l10n.t("Success rate")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Cache hit rate")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Spend last updated")}>
				<Absent />
			</Fact>
		</>
	);
}

/**
 * The row's detail drawer, one labelled inventory in the Fact/Absent vocabulary. Usage is
 * per SERVER, never per model, and every field can be missing (a normal shape, not a
 * failure), so absence is designed and a missing number is never a zero; only a server the
 * snapshot does not cover gets the entry facts alone (seven identical dashes would be noise).
 */
function ServerDrawer({
	server,
	usage,
	notices,
	carriedDetails,
	pollingOff,
	discoveryTimeoutMs,
	now,
	currencySymbol,
	onShowModels,
}: {
	server: DashboardServer;
	/** The row's usage card, denied cards included; absent for servers the snapshot does not cover. */
	usage: UsageServerCardView | undefined;
	/** The row's drawer-placed diagnostics (the warn-tier budget line); rendered as the inventory's leading rows. */
	notices: readonly DrawerNotice[];
	/** The endpoint details the row's diagnostics already carry; the inventory prints only the remainder. */
	carriedDetails: ReadonlySet<UsageEndpoint>;
	pollingOff: boolean;
	discoveryTimeoutMs: number;
	now: number;
	currencySymbol: string;
	onShowModels: ((label: string) => void) | undefined;
}) {
	const numbers = usage?.kind === "usage" ? usage : undefined;
	// The endpoint standings' English lines, minus the ones a diagnostic under this row
	// already carries: the drawer is the inventory, not a second copy of the row's problems.
	const details =
		numbers === undefined
			? []
			: detailLines(
					carriedDetails.has("keyInfo") ? undefined : keyInfoDetail(numbers, discoveryTimeoutMs),
					carriedDetails.has("dailyActivity") ? undefined : activityDetail(numbers)
				);
	return (
		<>
			{/* The drawer-placed diagnostics LEAD the inventory (user-ruled): the sentence is
			    what the row's tinted meter sent the reader in here for, and the trailing seat
			    left dead padding under the facts. */}
			{notices.map((notice) => (
				<DrawerNoticeLine key={notice.key} diagnostic={notice} />
			))}
			{/* Two columns until the pane cannot hold both: the 11rem label column plus an
			    unshrinkable longest word overflows under about 560px of pane, which the floor
			    promises never scrolls sideways. Stacked, the dd's own bottom margin keeps the
			    next label from joining the value above it. */}
			<dl className="server-facts m-0 grid max-w-[46rem] grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[0.95em] @max-[560px]/pane:grid-cols-[minmax(0,1fr)] @max-[560px]/pane:gap-y-0">
				{/* "Base URL", the same name the server form gives this field. */}
				<Fact label={l10n.t("Base URL")}>
					<span className="fact-url">
						<UrlBreaks text={server.baseUrl} />
					</span>
				</Fact>
				<Fact label={l10n.t("Authentication")}>
					{/* The credential KIND, never a value; OAuth stays English by policy. */}
					{server.hasOAuth ? "OAuth" : server.hasApiKey ? l10n.t("API key") : l10n.t("none")}
				</Fact>
				<Fact label={l10n.t("Models")}>
					{/* The whole phrase is the link: a bare "models" fragment cannot be translated
					    (measure words and word order move). It lives here, not on the row - the row
					    is one disclosure button, and a button cannot contain a button. A zero stays
					    plain text, since an empty scoped list has nothing to show. */}
					{onShowModels !== undefined && server.servedModelCount > 0 ? (
						<Button
							variant="secondary"
							size="compact"
							className="count-link [--btn-mx:-0.25rem] px-1 py-0"
							aria-label={l10n.t("Show models from {0}", server.label)}
							onClick={() => onShowModels(server.label)}
						>
							{server.servedModelCount === 1 ? l10n.t("1 model") : l10n.t("{0} models", server.servedModelCount)}
						</Button>
					) : server.servedModelCount === 1 ? (
						l10n.t("1 model")
					) : (
						l10n.t("{0} models", server.servedModelCount)
					)}
				</Fact>
				<Fact label={l10n.t("Discovery last checked")}>
					{server.lastChecked !== undefined && server.state !== "unchecked" ? (
						(relativeTime(server.lastChecked, now) ?? l10n.t("just now"))
					) : (
						<Absent reason={l10n.t("no discovery pass has seen it yet - run Sync models to check it now")} />
					)}
				</Fact>
				{server.origin === "external" ? (
					<Fact label={l10n.t("Origin")}>
						{l10n.t("external")}
						<Why text={externalTip(server)} />
					</Fact>
				) : null}
				{numbers !== undefined ? (
					<UsageFacts server={numbers} pollingOff={pollingOff} now={now} currencySymbol={currencySymbol} />
				) : usage?.kind === "forbidden" ? (
					<DeniedUsageFacts card={usage} pollingOff={pollingOff} />
				) : null}
			</dl>
			{details.map((detail) => (
				<p key={detail} className="usage-detail mt-2 mb-0 font-mono text-[0.85em] text-muted-foreground">
					{detail}
				</p>
			))}
			{server.origin === "declared" ? (
				<>
					<DrawerRecords kind="params" value={server.config.modelParameters} server={server} />
					<DrawerRecords kind="caps" value={server.config.modelCapabilities} server={server} />
				</>
			) : null}
		</>
	);
}

/**
 * The entry's model records in the drawer, in the settings editors' vocabulary. Read-only on
 * purpose: the setting and the edit page are the two write surfaces. An entry without
 * records renders nothing - per-push static state, not a transient, so no reservation.
 */
function DrawerRecords({
	kind,
	value,
	server,
}: {
	kind: "params" | "caps";
	value: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
	server: DashboardServer;
}) {
	if (value === undefined || Object.keys(value).length === 0) {
		return null;
	}
	const groups = toGroups(value);
	// Judged with the same parses the editors use, so an invalid stored FIELD wears the same
	// chip mark as in the edit page (matcher-level problems stay the edit page's job); the
	// capability hints read this entry's own observed /model/info vocabulary, like the form.
	let issues: GroupIssueView[];
	if (kind === "params") {
		const parse = parseGroups(groups);
		issues = paramIssueViews(groups, parse.ok ? [] : parse.problems, parse.hints);
	} else {
		const observed = server.observedModelInfoKeys;
		const parse = parseCapabilityGroups(groups, observed === undefined ? undefined : new Set(observed));
		issues = capabilityIssueViews(groups, parse.issues);
	}
	return (
		<div className="drawer-records mt-3">
			<h5 className="m-0 mb-1 font-semibold text-[0.92em] text-muted-foreground">
				{serverFormFieldLabel(kind === "params" ? "modelParameters" : "modelCapabilities")}
				{/* The caveat on the table it qualifies: the row's degraded line renders AFTER
				    this drawer, so the mark is the qualifier alone; the sentence stays with the
				    fix. */}
				{server.notices?.includes(kind === "params" ? "entry-params-inactive" : "entry-capabilities-inactive") ===
				true ? (
					<Why
						text={l10n.t({
							message: "may not be applied",
							comment: [
								"Mark on the heading of a read-only table of per-server settings, when those settings may not be reaching the server.",
							],
						})}
					/>
				) : null}
			</h5>
			<RecordMatcherTable kind={kind} groups={groups} issues={issues} readOnly />
		</div>
	);
}

/**
 * The row's URL, split so the https:// scheme can go visually-hidden rather than away: the
 * text stays in the DOM, so the accessible name, a copy, and find-in-page still carry the
 * exact URL. An http:// URL keeps its scheme visible - plaintext to a proxy holding an API
 * key is worth a reader's attention.
 */
function urlParts(baseUrl: string): { readonly scheme: string; readonly rest: string; readonly quiet: boolean } {
	const secure = "https://";
	// Case-insensitive: "HTTPS://host" is the same address.
	const marked = baseUrl.slice(0, secure.length).toLowerCase() === secure;
	const rest = marked ? baseUrl.slice(secure.length) : baseUrl;
	// A scheme with nothing after it stays visible: "https://" alone is a value someone has
	// to fix, and hiding it would render the row's URL as an empty space.
	return marked && rest.length > 0
		? { scheme: baseUrl.slice(0, secure.length), rest, quiet: true }
		: { scheme: marked ? baseUrl : "", rest: marked ? "" : baseUrl, quiet: false };
}

/**
 * A URL with a break opportunity BEFORE each dot, slash, or colon, so a wrapping host divides
 * at its labels. <wbr> adds nothing to the text (copy, find-in-page, and screen readers get
 * the exact string); overflow-wrap's anywhere stays beneath it as the backstop.
 */
function UrlBreaks({ text }: { text: string }) {
	return (
		<>
			{text.split(/(?=[./:])/).map((part, index) =>
				index === 0 ? (
					part
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: the segments are not reorderable items - the whole run re-renders with its string
					<Fragment key={index}>
						<wbr />
						{part}
					</Fragment>
				)
			)}
		</>
	);
}

function ServerRow({
	server,
	usage,
	spend,
	now,
	armed,
	onEdit,
	onArmRemove,
	onHideExternal,
	onShowModels,
	retrying,
	syncBusy,
	onRetry,
	onDeclareExpected,
	declaring,
	refreshing,
	refreshingExplicitly,
}: {
	server: DashboardServer;
	/** The server's usage card, denied cards included; absent when the proxy serves no usage data. */
	usage: UsageServerCardView | undefined;
	/** The snapshot-wide spend inputs (thresholds, currency, polling, timeout). */
	spend: SpendContext;
	now: number;
	armed: boolean;
	onEdit: () => void;
	onArmRemove: (armed: boolean) => void;
	/** Posts the hideExternalServer intent for this row; the section owns the requestId and the follow-up notice. */
	onHideExternal: (server: ExternalDashboardServer) => void;
	onShowModels: ((label: string) => void) | undefined;
	/** A sync this row asked for is in flight; the section clears it on the next push. */
	retrying: boolean;
	/** A sync is in flight for some row; the command is fleet-wide, so none may start another. */
	syncBusy: boolean;
	onRetry: () => void;
	/** Posts the declareExpectedFailure intent for this declared row; the section owns the requestId. */
	onDeclareExpected: (category: ExpectedFailureCategory) => void;
	/** This row's declare intent is unanswered. */
	declaring: boolean;
	/** A usage refresh is in flight; every Refresh now states it and refuses a second post. */
	refreshing: boolean;
	/** That pass was explicitly requested; only then does a Refresh now wear its busy label. */
	refreshingExplicitly: boolean;
}) {
	const confirmRemove = () => {
		sendRequest("removeServerSetting", { label: server.label });
		onArmRemove(false);
	};
	// The declare control's confirm step, per row (row identity is keyed, so a push cannot
	// re-associate the armed state). The pair survives the post - that is where
	// "Declaring..." renders - and disarms when the round trip ends, either answer.
	const [armedDeclare, setArmedDeclare] = useState<ExpectedFailureCategory | undefined>(undefined);
	useEffect(() => {
		if (!declaring) {
			setArmedDeclare(undefined);
		}
	}, [declaring]);
	// Local state on purpose: a push that reorders rows keeps each drawer with its keyed
	// row, and a closed dashboard forgets, exactly like the model rows.
	const [open, setOpen] = useState(false);
	const drawerId = useId();
	const { lines: diagnostics, usageDetailsCarried } = serverDiagnostics(server, usage, spend, {
		onEdit,
		onRetry,
		retrying,
		syncBusy,
		refreshing,
		refreshingExplicitly,
		onRefreshUsage: () => sendRequest("refreshUsage", null),
		...(server.origin === "declared"
			? { onDeclareExpected, armedDeclare, onArmDeclare: setArmedDeclare, declaring }
			: {}),
	});
	// The pill and the attention count read the FULL ranked list; only the lines split by
	// placement, so a drawer-deferred warning still signals.
	const rowDiagnostics = diagnostics.filter((diagnostic) => diagnostic.placement !== "drawer");
	const drawerDiagnostics = diagnostics.filter((diagnostic) => diagnostic.placement === "drawer");
	const url = urlParts(server.baseUrl);
	const usageNumbers = usage?.kind === "usage" ? usage : undefined;
	return (
		// The actions are revealed by hover AND focus-within: hover alone would put Remove out
		// of the keyboard's reach entirely.
		<li className="server-item">
			<div className="server-row">
				{/* One disclosure button for the whole readable block, actions as its sibling
				    (a button cannot contain a button); the chevron is decoration, aria-expanded
				    announces. border-control-outline: transparent in ordinary themes (no
				    preflight, so a bare button wears the UA's box), the contrast border under
				    high contrast. The hover/open wash lives on the WRAPPER row (:has rules):
				    the button stops short of the actions column, and a wash that stopped with
				    it cut the row into two boxes. */}
				<button
					type="button"
					className="server-line rounded-sm border border-control-outline text-left focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset-inset) focus-visible:outline-ring focus-visible:outline-solid"
					aria-expanded={open}
					// Only while the drawer exists: aria-controls at an unmounted id dangles.
					aria-controls={open ? drawerId : undefined}
					onClick={() => setOpen(!open)}
				>
					<DisclosureChevron className="server-chevron" />
					<span className="server-name">
						<span className="server-label-text">{server.label}</span>
						{server.origin === "misconfigured" ? <span className="server-tag">{l10n.t("not in use")}</span> : null}
					</span>
					<span className="server-status">
						<StatusPill server={server} worst={diagnostics[0]?.severity} now={now} />
					</span>
					{/* The row's second line when narrow, nothing when wide: display: contents
					    hands these four straight to the button's grid, so one markup carries both
					    shapes; the stylesheet names the columns, not this order. */}
					<span className="server-meta">
						<span className="server-url">
							{/* The scheme is its own element so the stylesheet can hide it from the
							    paint alone. */}
							{url.scheme.length > 0 ? (
								<span className={url.quiet ? "url-scheme visually-hidden" : "url-scheme"}>{url.scheme}</span>
							) : null}
							<UrlBreaks text={url.rest} />
						</span>
						<span className="server-count">
							{/* The count carries its own noun. Plain text here (a button cannot contain
							    a button); the link into the scoped Models list lives in the drawer. */}
							<span className="count-plain">
								{server.servedModelCount === 1 ? l10n.t("1 model") : l10n.t("{0} models", server.servedModelCount)}
							</span>
						</span>
						<span className="server-usage">
							<SpendUnit usage={usageNumbers} thresholds={spend.thresholds} currencySymbol={spend.currencySymbol} />
						</span>
						<span className="server-badges">
							{/* The credential kind is the information, so it is the visible text. */}
							{server.hasApiKey || server.hasOAuth ? (
								<Badge>{server.hasOAuth ? "OAuth" : l10n.t("API key")}</Badge>
							) : null}
							{/* Provenance is the drawer's Origin fact; a hover tip here would be a
							    focusable wrapper inside this button. */}
							{server.origin === "external" ? <Badge>{l10n.t("external")}</Badge> : null}
						</span>
					</span>
				</button>
				<span className={armed ? "server-actions armed" : "server-actions"}>
					{armed ? (
						<>
							{/* At the narrowest tier the armed pair covers ALL of the row, so the name
							    the reader is checking against goes inside the cover there, ellipsized;
							    the stylesheet hides it above, where the row's own name still stands.
							    The buttons carry the label in their accessible names at every tier,
							    LEADING with their visible words (Label in Name). */}
							<span className="armed-subject">{server.label}</span>
							<Button
								variant="danger"
								size="compact"
								aria-label={l10n.t("Confirm remove? {0}", server.label)}
								onClick={() => {
									// The same two-step confirm for every origin; only the intent differs
									// (setting removal by label vs. hiding by tombstone).
									if (server.origin === "external") {
										onHideExternal(server);
										onArmRemove(false);
									} else {
										confirmRemove();
									}
								}}
							>
								{l10n.t("Confirm remove?")}
							</Button>
							<Button
								variant="secondary"
								size="compact"
								aria-label={l10n.t("Cancel removing {0}", server.label)}
								onClick={() => onArmRemove(false)}
							>
								{l10n.t("Cancel")}
							</Button>
						</>
					) : (
						<>
							{/* A misconfigured entry has no Edit: it cannot round-trip the form without
							    rewriting what the user typed, and the blocking line beneath the row
							    already carries the fix action (reveal the setting). */}
							{server.origin === "misconfigured" ? null : (
								<Button
									variant="secondary"
									size="compact"
									aria-label={l10n.t("Edit {0}", server.label)}
									onClick={onEdit}
								>
									{l10n.t("Edit")}
								</Button>
							)}
							{/* A legacy-registry external row is not hideable (the registry path would
							    keep serving its models), so it keeps Edit only. */}
							{server.origin === "declared" || server.origin === "misconfigured" || server.hideable ? (
								<Button
									variant="danger"
									size="compact"
									aria-label={l10n.t("Remove {0}", server.label)}
									onClick={() => onArmRemove(true)}
								>
									{l10n.t("Remove")}
								</Button>
							) : null}
						</>
					)}
				</span>
			</div>
			{open ? (
				<div id={drawerId} className="server-drawer">
					<ServerDrawer
						server={server}
						usage={usage}
						notices={drawerDiagnostics}
						carriedDetails={usageDetailsCarried}
						pollingOff={spend.pollingOff}
						discoveryTimeoutMs={spend.discoveryTimeoutMs}
						now={now}
						currencySymbol={spend.currencySymbol}
						onShowModels={onShowModels}
					/>
				</div>
			) : null}
			{/* OUTSIDE the disclosure: an action behind a fold is one most readers never
			    find. */}
			{rowDiagnostics.map((diagnostic) => (
				<ServerDiagnosticLine key={diagnostic.key} diagnostic={diagnostic} />
			))}
			{/* A closed drawer keeps its notices in the ACCESSIBLE tree: the meter's tone is
			    colour, which a screen reader never gets. The open drawer renders the visible
			    line, so the twin stands down with it. */}
			{!open
				? drawerDiagnostics.map((diagnostic) => (
						<div key={diagnostic.key} className="visually-hidden">
							{severityLabel(diagnostic.severity, "server")} {diagnostic.headline}
						</div>
					))
				: null}
		</li>
	);
}

/**
 * The collapsed hidden-groups line. Unhide clears the removal tombstone extension-side; the
 * group's models return on the host's next re-resolution, which the extension triggers.
 */
function HiddenGroupsLine({ hidden }: { hidden: readonly HiddenGroup[] }) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();
	if (hidden.length === 0) {
		return null;
	}
	// One control that states the whole thing. Open drops the count: it is the reason to
	// open the list and says nothing once it is open.
	const label = expanded
		? l10n.t("Hide")
		: hidden.length === 1
			? l10n.t("Show 1 hidden group")
			: l10n.t("Show {0} hidden groups", hidden.length);
	return (
		<div className="hidden-groups">
			<Button
				variant="secondary"
				size="compact"
				aria-expanded={expanded}
				// Only while open: aria-controls at an unmounted id dangles.
				aria-controls={expanded ? listId : undefined}
				onClick={() => setExpanded((value) => !value)}
			>
				{/* The page's disclosure vocabulary; decoration only, aria-expanded announces. */}
				<DisclosureChevron />
				{label}
			</Button>
			{expanded ? (
				<ul id={listId}>
					{hidden.map((group) => (
						// Keyed by the identity pair the unhideServer intent posts.
						<li key={`${group.label}:${group.baseUrl}`}>
							<span className="hidden-label">{group.label}</span> <span className="url">{group.baseUrl}</span>{" "}
							<Button
								variant="secondary"
								size="compact"
								onClick={() =>
									sendRequest("unhideServer", {
										label: group.label,
										baseUrl: group.baseUrl,
									})
								}
							>
								{l10n.t("Unhide")}
							</Button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * The worst FRESH server's spend against its budget - deliberately not a total: two entries
 * sharing a key would count its spend twice. It reads the pushed spentFraction (the host's
 * resolveBudget computed it, never re-divided here) and reduces through the same
 * worstSpendTone as the status bar (docs/usage.md), so the two cannot disagree. A
 * budget-less server contributes nothing.
 */
function worstFreshBudgetFraction(usage: DashboardUsage | undefined): number | undefined {
	const fractions = (usage?.servers ?? []).flatMap((server) =>
		server.kind === "usage" && server.fresh && server.spentFraction !== undefined ? [server.spentFraction] : []
	);
	return worstSpendTone(fractions, usage?.thresholds ?? [])?.worst;
}

/**
 * The header's state summary, every clause a whole sentence fragment so extraction sees
 * literals, not concatenation.
 */
function serversMeta(
	serverCount: number,
	attentionCount: number,
	usage: DashboardUsage | undefined,
	/** A rendered row is showing a stale spend number, so the exclusion is visible and needs its gloss. */
	staleSpendVisible: boolean
): string {
	const clauses = [serverCount === 1 ? l10n.t("1 server") : l10n.t("{0} servers", serverCount)];
	if (attentionCount > 0) {
		clauses.push(attentionCount === 1 ? l10n.t("1 needs attention") : l10n.t("{0} need attention", attentionCount));
	}
	const worst = worstFreshBudgetFraction(usage);
	if (worst !== undefined) {
		// "use", because a bare "budget 87%" reads as budget REMAINING. The freshness gloss
		// appears only when it bites: with no stale spend on the page, it would gloss an
		// exclusion the reader cannot see.
		clauses.push(
			staleSpendVisible
				? l10n.t("worst budget use {0} (stale rows excluded)", formatPercent(worst))
				: l10n.t("worst budget use {0}", formatPercent(worst))
		);
	}
	if (usage?.pollIntervalMs === 0) {
		clauses.push(l10n.t("background polling off (usage.pollInterval 0)"));
	}
	return clauses.join(" - ");
}

export function ServersSection({
	servers,
	hidden = [],
	usage,
	currencySymbol,
	now,
	onShowModels,
	onEditServer,
	onAdoptServer,
	onAddServer,
}: {
	servers: readonly DashboardServer[];
	/** Groups hidden by an explicit removal; rendered as the collapsed hidden-groups line. */
	hidden?: readonly HiddenGroup[];
	/** The pushed usage snapshot; the rows' spend units, drawers, and diagnostics all read it. */
	usage?: DashboardUsage | undefined;
	/** The configured spend prefix (usage.currencySymbol); display only, never a conversion. */
	currencySymbol: string;
	/** The shared clock tick (one useNow in App), so a hidden panel does not run its own interval. */
	now: number;
	/** Scope the models section to one server; absent, the drawers' model counts stay plain text. */
	onShowModels?: ((label: string) => void) | undefined;
	/** A declared row's Edit; the shell opens the edit destination on it. */
	onEditServer: (label: string) => void;
	/** An external row's Edit, which adopts rather than edits; addressed by its opaque handle. */
	onAdoptServer: (handle: string) => void;
	onAddServer: () => void;
}) {
	// One outcome hook per acked method: the failure banners render each hook's latest fail
	// (a later ok retires it), and Dismiss is the hook's reset. Separate hook instances from
	// the open form's own - both see the same envelopes.
	const saveIntent = useIntentOutcome("saveServerSetting");
	const removeIntent = useIntentOutcome("removeServerSetting");
	const adoptIntent = useIntentOutcome("adoptServer");
	const hideIntent = useIntentOutcome("hideExternalServer");
	const unhideIntent = useIntentOutcome("unhideServer");
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	// The row whose Retry is in flight, and the request that will answer it. The id is held,
	// not just the label: useIntentOutcome reports the METHOD's latest envelope whoever
	// posted it, and the rail's Sync button posts the same method.
	const [retrying, setRetrying] = useState<{ readonly label: string; readonly requestId: string } | undefined>(
		undefined
	);
	// Whether the fleet has ever been checked at all: the live region below needs it so a
	// first-run page does not announce a clean bill of health it never took.
	const newestCheck = latestCheckedMs(servers) ?? 0;
	const syncIntent = useIntentOutcome("syncModels");
	const syncOutcome = syncIntent.outcome;
	// Clear on either answer to THIS row's request; the failure is deliberately not rendered
	// here, because runModelSync already reports every outcome as a VS Code toast.
	useEffect(() => {
		setRetrying((current) => (current !== undefined && syncOutcome?.id === current.requestId ? undefined : current));
	}, [syncOutcome]);
	// The row whose declare-expected intent is unanswered, keyed like the retry state: only
	// the answer to THIS request may clear it - either answer, a failed declare is finished.
	const declareIntent = useIntentOutcome("declareExpectedFailure");
	const [pendingDeclare, setPendingDeclare] = useState<
		{ readonly label: string; readonly requestId: string } | undefined
	>(undefined);
	const declareOutcome = declareIntent.outcome;
	useEffect(() => {
		setPendingDeclare((current) =>
			current !== undefined && declareOutcome?.id === current.requestId ? undefined : current
		);
	}, [declareOutcome]);
	// The one-time post-adoption notice: the old host-owned group survives (no removal API),
	// so the user is told plainly why models now appear twice.
	const [adoptNotice, setAdoptNotice] = useState<string | undefined>(undefined);
	// The hide round trip: requestId plus the row's label, so the guidance notice can name
	// the exact group to delete once the ack lands. Only the ack crosses the boundary.
	const [pendingHide, setPendingHide] = useState<{ requestId: string; label: string } | undefined>(undefined);
	const [removedNotice, setRemovedNotice] = useState<string | undefined>(undefined);
	const pendingHideRequestId = pendingHide?.requestId;
	const pendingHideLabel = pendingHide?.label;
	const hideOutcome = hideIntent.outcome;
	useEffect(() => {
		if (pendingHideRequestId !== undefined && hideOutcome?.result === "ok" && hideOutcome.id === pendingHideRequestId) {
			setRemovedNotice(pendingHideLabel);
			setPendingHide(undefined);
		}
	}, [hideOutcome, pendingHideRequestId, pendingHideLabel]);
	const hideExternal = (server: ExternalDashboardServer) => {
		const requestId = hideIntent.send({ baseUrl: server.baseUrl, sourceHandle: server.adoptHandle });
		setPendingHide({ requestId, label: server.label });
	};
	const saveFailure = saveIntent.outcome?.result === "fail" ? saveIntent.outcome : undefined;
	const removeFailure = removeIntent.outcome?.result === "fail" ? removeIntent.outcome : undefined;
	const adoptFailure = adoptIntent.outcome?.result === "fail" ? adoptIntent.outcome : undefined;
	const hideFailure = hideIntent.outcome?.result === "fail" ? hideIntent.outcome : undefined;
	const unhideFailure = unhideIntent.outcome?.result === "fail" ? unhideIntent.outcome : undefined;
	const declareFailure = declareIntent.outcome?.result === "fail" ? declareIntent.outcome : undefined;
	const noServers = servers.length === 0;
	// The snapshot's spend inputs once, read by rows, diagnostics, and header meta alike, so
	// a threshold can never rank a row differently from the line under it.
	const spend: SpendContext = {
		thresholds: usage?.thresholds ?? [],
		currencySymbol,
		pollingOff: usage?.pollIntervalMs === 0,
		discoveryTimeoutMs: usage?.discoveryTimeoutMs ?? 0,
	};
	// Usage is keyed by label (the usage store's documented join key), so only declared rows
	// look it up; a URL spelling difference must not break the join. Denied cards join too -
	// they carry the row's usage-denied diagnostic.
	const usageByLabel = new Map((usage?.servers ?? []).map((view) => [view.label, view] as const));
	const usageFor = (server: DashboardServer) =>
		server.origin === "declared" ? usageByLabel.get(server.label) : undefined;
	// Rows carrying something worth acting on, read through the same classifier the rows
	// render - a second predicate would drift. Advisories excluded on purpose; a denied
	// usage key counts, per the tier contract's user-ruled carve-out.
	const attentionCount = servers.filter((server) =>
		serverDiagnostics(server, usageFor(server), spend, { onEdit: () => {}, onRetry: () => {} }).lines.some(
			(diagnostic) => diagnostic.severity !== "advisory"
		)
	).length;
	// Whether any rendered row shows a stale spend number - the same join the rows use, so
	// the header's staleness gloss appears exactly when a "stale"-marked figure is on page.
	const staleSpendVisible = servers.some((server) => {
		const card = usageFor(server);
		return card?.kind === "usage" && !card.fresh && card.spend !== undefined;
	});

	// The edit page owns the adopt round trip and leaves on its own ack; this hook sees the
	// same envelope, which is what lets the notice belong to the list, not the page that left.
	const adoptOutcome = adoptIntent.outcome;
	const adoptedId = adoptOutcome?.result === "ok" ? adoptOutcome.id : undefined;
	const adoptedCaveat = adoptOutcome?.result === "ok" ? adoptOutcome.message : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the acked id so one ack raises one notice; the caveat is read at fire time
	useEffect(() => {
		if (adoptedId === undefined) {
			return;
		}
		const base = l10n.t(
			"Adopted into the servers setting. Models appear twice until the original group's object is deleted: open the models file, remove it, reload the window."
		);
		setAdoptNotice(adoptedCaveat !== undefined ? `${base} ${adoptedCaveat}` : base);
	}, [adoptedId]);

	return (
		<Section
			id="servers"
			title={l10n.t("Servers")}
			help={helpServersSection()}
			// The trigger sits near the top of the document, where a tip above it clips.
			helpBelow
			docs={{ href: DOCS_LINK_SERVERS, label: l10n.t("Open the servers guide") }}
			meta={noServers ? undefined : serversMeta(servers.length, attentionCount, usage, staleSpendVisible)}
			// First run shows the guided card alone, not a header of dead disabled buttons.
			actions={
				noServers ? undefined : (
					<>
						<Button onClick={onAddServer}>
							<IconAdd /> {l10n.t("Add server")}
						</Button>
						{/* Fleet-wide usage re-fetch. Disabled during ANY pass (one serialized
						    engine); the busy label only for an EXPLICIT one - a spinner on every
						    scheduled poll read as the app acting unasked. Both labels stay mounted
						    in one grid cell, the hidden one holding the width, so the swap cannot
						    resize the button; check-geometry's servers-refresh-busy pair holds that. */}
						<Button
							variant="secondary"
							className="refresh-usage"
							disabled={usage?.refreshing === true || noServers}
							onClick={() => sendRequest("refreshUsage", null)}
						>
							<span className="grid">
								<span
									className={cn(
										"refresh-busy-label col-start-1 row-start-1 inline-flex items-center justify-center gap-1",
										usage?.refreshingExplicitly === true ? undefined : "invisible"
									)}
									aria-hidden={usage?.refreshingExplicitly === true ? undefined : true}
								>
									<span className="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
								</span>
								<span
									className={cn(
										"refresh-idle-label col-start-1 row-start-1 inline-flex items-center justify-center",
										usage?.refreshingExplicitly === true && "invisible"
									)}
									aria-hidden={usage?.refreshingExplicitly === true ? true : undefined}
								>
									{l10n.t("Refresh now")}
								</span>
							</span>
						</Button>
					</>
				)
			}
		>
			{removedNotice !== undefined ? (
				<div className="notice" role="status">
					<p>
						{l10n.t(
							'Hid "{0}" and its models. VS Code still keeps a provider group named "{0}". To delete it for good:',
							removedNotice
						)}
					</p>
					<ol className="notice-steps">
						<li>{l10n.t('Open the models file and remove the "{0}" object from the JSON array.', removedNotice)}</li>
						<li>{l10n.t('Reload the window (Ctrl+Shift+P, "Developer: Reload Window") or restart VS Code.')}</li>
						<li>{l10n.t("Run Sync models.")}</li>
					</ol>
					<div className="toolbar">
						<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openGroupsFile" })}>
							{l10n.t("Open models file")}
						</Button>
						<Button variant="secondary" size="compact" onClick={() => setRemovedNotice(undefined)}>
							{l10n.t("Dismiss")}
						</Button>
					</div>
				</div>
			) : null}
			{adoptNotice !== undefined ? (
				<div className="notice" role="status">
					<p>{adoptNotice}</p>
					<div className="toolbar">
						<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openGroupsFile" })}>
							{l10n.t("Open models file")}
						</Button>
						<Button variant="secondary" size="compact" onClick={() => setAdoptNotice(undefined)}>
							{l10n.t("Dismiss")}
						</Button>
					</div>
				</div>
			) : null}
			{adoptFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={adoptFailure.message}
							{...(adoptFailure.failureKind === "operation"
								? {}
								: { frame: (headline: string) => sectionFailureText(l10n.t("Adopting the server failed:"), headline) })}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={adoptIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{saveFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={saveFailure.message}
							{...(saveFailure.failureKind === "operation"
								? {}
								: { frame: (headline: string) => sectionFailureText(l10n.t("Saving the server failed:"), headline) })}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={saveIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{removeFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={removeFailure.message}
							frame={(headline) => sectionFailureText(l10n.t("Removing failed:"), headline)}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={removeIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{hideFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={hideFailure.message}
							frame={(headline) => sectionFailureText(l10n.t("Hiding the group failed:"), headline)}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={hideIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{unhideFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={unhideFailure.message}
							frame={(headline) => sectionFailureText(l10n.t("Unhiding the group failed:"), headline)}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={unhideIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{declareFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={declareFailure.message}
							frame={(headline) => sectionFailureText(l10n.t("Declaring the expected failure failed:"), headline)}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={declareIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{noServers ? (
				<div className="empty-start">
					<h3>{l10n.t("Connect LiteLLM to Copilot Chat")}</h3>
					<p className="hint">
						{l10n.t("Point the extension at your LiteLLM server and its models appear in Copilot Chat's model picker.")}
					</p>
					<ol>
						<li>{l10n.t("Enter the server's URL - for a local proxy that is usually http://localhost:4000.")}</li>
						<li>{l10n.t("Paste its API key if it needs one; it can stay in VS Code's encrypted secret storage.")}</li>
						<li>{l10n.t("Save. Models sync automatically and show up on this page.")}</li>
					</ol>
					<Button onClick={onAddServer}>{l10n.t("Add your first server")}</Button>
				</div>
			) : (
				<>
					{/* The list's verdict region: polite, one region for the page (per-row
					    announcements on every push are noise). The sighted reader's copy of the
					    count is the header's meta line. */}
					<p className="visually-hidden" role="status" aria-live="polite">
						{attentionCount > 0
							? attentionCount === 1
								? l10n.t("1 server needs attention")
								: l10n.t("{0} servers need attention", attentionCount)
							: newestCheck > 0
								? l10n.t("All servers are healthy")
								: // No verdict yet: "All servers are healthy" would assert a clean bill of
									// health the page has never taken.
									l10n.t("No servers have been checked yet")}
					</p>
					{/* The list's ONE in-flight announcement: a changed accessible name is
					    announced only on the FOCUSED element, and a mouse user's focus never sits
					    on the button they pressed. One region, not per cluster - status regions
					    are atomic, and a fleet-wide flag flips every label at once. */}
					<p className="visually-hidden" role="status" aria-live="polite">
						{[
							retrying !== undefined ? l10n.t("Checking {0}", retrying.label) : undefined,
							pendingDeclare !== undefined
								? l10n.t("Declaring the expected failure for {0}", pendingDeclare.label)
								: undefined,
							usage?.refreshingExplicitly === true ? l10n.t("Refreshing usage data") : undefined,
						]
							.filter((line): line is string => line !== undefined)
							.join("; ")}
					</p>
					<ul className="server-list">
						{servers.map((server) => (
							// Keyed identity (origin plus opaque handle or setting-unique label) so an
							// async push cannot re-associate another server's row with the user's focus.
							<ServerRow
								key={`${server.origin}:${server.adoptHandle ?? server.label}`}
								server={server}
								usage={usageFor(server)}
								spend={spend}
								now={now}
								armed={armedRemove === server.label}
								onEdit={() => {
									// The one place the destination's purpose is decided: a declared row
									// edits, an external row adopts; the misconfigured guard (no Edit
									// renders) keeps the narrowing honest.
									if (server.origin === "misconfigured") {
										return;
									}
									if (server.origin === "declared") {
										onEditServer(server.label);
										return;
									}
									onAdoptServer(server.adoptHandle);
								}}
								onArmRemove={(armed) => setArmedRemove(armed ? server.label : undefined)}
								onHideExternal={hideExternal}
								onShowModels={onShowModels}
								retrying={retrying?.label === server.label}
								syncBusy={retrying !== undefined}
								onRetry={() => {
									setRetrying({ label: server.label, requestId: syncIntent.send(null) });
								}}
								onDeclareExpected={(category) => {
									setPendingDeclare({
										label: server.label,
										requestId: declareIntent.send({ label: server.label, category }),
									});
								}}
								declaring={pendingDeclare?.label === server.label}
								refreshing={usage?.refreshing === true}
								refreshingExplicitly={usage?.refreshingExplicitly === true}
							/>
						))}
					</ul>
				</>
			)}
			<HiddenGroupsLine hidden={hidden} />
		</Section>
	);
}
