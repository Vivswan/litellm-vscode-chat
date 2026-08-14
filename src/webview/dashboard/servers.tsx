import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { Fragment, useEffect, useId, useState } from "react";
import { latestCheckedMs } from "../../dashboard/presenters";
import { sectionFailureText } from "../../dashboard/serverForm";
import type {
	DashboardServer,
	DashboardUsage,
	ExternalDashboardServer,
	HiddenGroup,
	InactiveEntryNotice,
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
import { IconAdd, IconChevronRight } from "./icons";
import { troubleshootingLink } from "./serverEditPage";
import { barPresentation, formatMoney, formatPercent, TONE_FILL, TONE_TEXT } from "./spendFormat";
import { relativeTime } from "./time";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Section } from "./ui/section";
import { sendRequest } from "./vscodeApi";

/**
 * Every inactive notice's user-facing phrase in one table, so a new notice
 * cannot ship half-wired (the satisfies clause fails to compile until the
 * table names it). Zero-arg functions, so the strings resolve after the l10n
 * bootstrap.
 *
 * Each notice used to carry three renderings - a row badge, a hover tip, and a
 * phrase for the merged banner - which was three places to say one thing and
 * two of them appeared side by side. The row's advisory line says it once, so
 * the phrase is all that survives.
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
		// The consequence rides this phrase because it is specific to this
		// surface - the others simply do not apply, this one silently falls back
		// to a different rule - and it lived only in the retired badge's tip.
		surface: () => l10n.t("per-server API version overrides (requests use the auto rule)"),
	},
} as const satisfies Record<InactiveEntryNotice, { surface: () => string }>;

const INACTIVE_NOTICES = Object.keys(INACTIVE_NOTICE_PRESENTATION) as readonly InactiveEntryNotice[];

/**
 * How much a problem costs the server's PURPOSE - serving its models with the
 * configuration it was given - which is the only thing that should decide how
 * loud it looks.
 *
 * "blocking" means this server serves nothing until someone acts. "degraded"
 * means someone has to act even though models may still serve: part of the
 * configuration is not reaching the server, a budget the reader configured is
 * running out, or - the one user-ruled carve-out - the entry's key is refused
 * permission to read its own usage. A refused key reads calmly, but only a
 * human can change a permission, so it counts. "advisory" means nobody has to
 * act - the configuration applies as written, and the line names either a
 * fact the reader may not remember setting up or a transient miss that clears
 * itself. An advisory still renders whole (headline, English detail, its fix
 * action); only the tint and the attention count are reduced, or the quiet
 * tier would train the reader to ignore the loud ones.
 *
 * The tiers are what the summary line counts, so a tier is a promise about
 * whether someone has to act, not a volume knob.
 */
type DiagnosticSeverity = "blocking" | "degraded" | "advisory";

/** Loudest first: the row's problems are read top to bottom in the order they cost you something. */
const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = { blocking: 0, degraded: 1, advisory: 2 };

/**
 * One action offered beside a problem. Almost every one of them REVEALS the
 * place a human fixes the problem - the setting, the entry's form, the models
 * file - or asks the extension to try again, because this is their settings
 * file and a button that silently edited it would be a worse bug than the one
 * it fixed. The one exception is the declare-expected action: behind an
 * explicit confirm it appends one closed-vocabulary token
 * (discovery.expectedFailures) to the entry - nothing free-typed, nothing
 * removed, and the row's diagnostic named exactly what will be written.
 */
type DiagnosticAction =
	/**
	 * `ariaLabel` names the server, because these buttons repeat down the page:
	 * a screen-reader user listing controls otherwise hears "Retry" three times
	 * with nothing to tell them apart. The visible label stays the short verb
	 * and stays inside the accessible name, as Label in Name requires.
	 */
	| {
			readonly kind: "button";
			/**
			 * Stable across renders and independent of the label. React keys are
			 * identity, and keying these by their text destroyed and rebuilt the
			 * node the instant its wording changed - which is precisely when the
			 * reader was holding it, so pressing Retry threw away their own focus.
			 */
			readonly id: string;
			readonly label: string;
			readonly ariaLabel: string;
			/** In flight: the control states that it is working and refuses a second click. */
			readonly disabled?: boolean | undefined;
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

interface RowDiagnostic {
	/** Stable within a row, so React keeps focus on an action button across pushes. */
	readonly key: string;
	readonly severity: DiagnosticSeverity;
	/**
	 * What it costs, in a sentence that names the server and leads with the
	 * consequence rather than the mechanism: a reader who stops after the first
	 * clause should still know what is not working.
	 */
	readonly headline: string;
	/**
	 * The server's own words, when it had any - one paragraph per line, so a
	 * denial spanning two endpoints states both. English by policy - these land
	 * in issue reports.
	 */
	readonly details?: readonly string[] | undefined;
	readonly actions: readonly DiagnosticAction[];
}

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

/**
 * Every problem one server has, worst first.
 *
 * These used to be five separate banner stacks under the table, each one
 * looping over every server and joining its entries with semicolons. That
 * shape made the reader do the join: a sentence beginning "prod-eu:" sat
 * inches below the row it was about, and a row in trouble looked exactly like
 * a healthy one until you read the bottom of the page. Same facts, attached
 * to the row that owns them.
 */
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
	}
): readonly RowDiagnostic[] {
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
		ariaLabel: l10n.t("Open the OpenAI-compatible servers guide"),
	};
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
					ariaLabel: l10n.t("Open the authentication guide"),
				},
			],
		});
	}
	const error = server.error;
	const inactive = INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true);
	if (error !== undefined && server.origin !== "misconfigured") {
		const declared = server.declaredModelCount ?? 0;
		const expected = server.expected === true;
		const headline = statusErrorHeadline(error);
		if (!expected) {
			// A live group whose sync failed keeps serving what it already had, so
			// it is degraded rather than blocking; one that has nothing serves
			// nothing.
			const serving = server.state === "ok" || server.modelCount > 0;
			// The headline's declaration advice with no one-click form beside it
			// needs the why: the identity fix rides the details wherever the
			// declare action is withheld - unless the entry-inactive line below
			// renders and says the same sentence itself.
			const declareWithheld =
				server.origin === "declared" &&
				server.classification?.unsupportedEndpoint === "modelListing" &&
				server.entryFieldsInactive === true;
			found.push({
				key: "discovery-error",
				severity: serving ? "degraded" : "blocking",
				headline: serving
					? l10n.t("{0} is serving its last known models; the newest sync failed: {1}", server.label, headline)
					: l10n.t("{0} is serving no models: {1}", server.label, headline),
				details: detailLines(
					statusErrorDetail(error),
					declareWithheld && inactive.length === 0 ? entryInactiveFixText() : undefined
				),
				actions: [
					{
						kind: "button",
						id: "retry",
						// A discovery pass can take tens of seconds - the timeouts are
						// per request and they sum - so a button that looked identical
						// before and after the click invited the double-click-until-
						// something-happens trap.
						label: actions.retrying === true ? l10n.t("Checking...") : l10n.t("Retry"),
						ariaLabel:
							actions.retrying === true
								? l10n.t("Checking {0}", server.label)
								: l10n.t("Retry discovery for {0}", server.label),
						// Only the row that asked SAYS it is checking, because that is
						// where the reader is looking - but every Retry is disabled while
						// a pass runs, because the command is fleet-wide. Leaving the
						// others live would let one impatient reader queue several full
						// passes from different rows, each one costing every server a
						// round trip.
						disabled: actions.retrying === true || actions.syncBusy === true,
						onClick: actions.onRetry,
					},
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
								// The error's own headline already carries the declaration
								// advice (transport proved the shape); this is its one-click
								// form, writing exactly the category the headline names -
								// withheld when the group did not join by the entry's identity
								// (the details then carry the identity fix), because the
								// written declaration may not reach it (the same
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
									// The helper's `label` is the accessible name (it names the
									// specific guide); the visible text is the short verb. Do
									// not spread the helper over these - it carries its own
									// `label` and would put the long sentence on screen.
									href: troubleshootingLink(server.classification.setupHint).href,
									label: l10n.t("Troubleshoot"),
									ariaLabel: troubleshootingLink(server.classification.setupHint).label,
								},
							]
						: []),
				],
			});
		} else if (declared > 0) {
			// The entry declared this failure category and named models to serve
			// through it, so nothing is wrong: this is the quiet tier, stating a
			// fact the reader may not remember configuring. The server's own
			// words ride the detail lines rather than the headline - interpolated
			// there they chained a second colon onto the sentence's own.
			found.push({
				key: "expected-serving",
				severity: "advisory",
				headline:
					declared === 1
						? l10n.t("{0} serves 1 declared model; discovery fails only where this entry expects it to.", server.label)
						: l10n.t(
								"{0} serves {1} declared models; discovery fails only where this entry expects it to.",
								server.label,
								declared
							),
				details: detailLines(headline, statusErrorDetail(error)),
				actions: [],
			});
		} else {
			found.push({
				// Serves nothing at all, which is the definition of blocking. The
				// entry expecting the failure category makes the CAUSE unsurprising;
				// it does not put any models in the picker.
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
					{
						kind: "button",
						id: "retry",
						// A discovery pass can take tens of seconds - the timeouts are
						// per request and they sum - so a button that looked identical
						// before and after the click invited the double-click-until-
						// something-happens trap.
						label: actions.retrying === true ? l10n.t("Checking...") : l10n.t("Retry"),
						ariaLabel:
							actions.retrying === true
								? l10n.t("Checking {0}", server.label)
								: l10n.t("Retry discovery for {0}", server.label),
						// Only the row that asked SAYS it is checking, because that is
						// where the reader is looking - but every Retry is disabled while
						// a pass runs, because the command is fleet-wide. Leaving the
						// others live would let one impatient reader queue several full
						// passes from different rows, each one costing every server a
						// round trip.
						disabled: actions.retrying === true || actions.syncBusy === true,
						onClick: actions.onRetry,
					},
				],
			});
		}
	}
	if (server.state === "ok" && server.modelInfoUnsupported !== undefined && server.origin === "declared") {
		// The quiet tier on purpose: the models serve and the configuration
		// applies as written - the declaration marks the failing probe as normal
		// (single attempt, info-level log, no hint). It does NOT shorten the
		// probe's wait: a hanging endpoint still spends one discovery timeout
		// per sync, and only a lower discovery.timeout shortens that - so the
		// copy promises the marking, never speed.
		//
		// The diagnosis renders whatever the join pass said - the probe's cost
		// is real either way - but the one-click write is withheld when the
		// group did not join by the entry's identity (the classification
		// itself, not the inactive notices: those exist only for the field
		// families the entry happens to configure). The withheld case says why
		// in its details with the identity fix, unless the entry-inactive line
		// below renders and says the same sentence itself.
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
		// One line for every inactive surface on this row: the cause and the fix
		// are identical for all of them, so per-surface twins would only repeat
		// themselves. Degraded rather than advisory: the group may be serving
		// this entry WITHOUT settings the user wrote, and only they can decide
		// whether that matters. Advisory would also have kept these rows out of
		// the summary count, quietly telling a reader whose parameters may not
		// be applied that nothing needs attention.
		found.push({
			key: "entry-inactive",
			severity: "degraded",
			headline: l10n.t("{0} may not be applying its {1}.", server.label, inactiveSurfacesText(server)),
			// The retired banner spelled the remedy out as numbered steps, and was
			// the only place these facts were written: which file, and that saving
			// under a new label works instead. They ride the line rather than dying
			// with it, behind a cause sentence the headline no longer carries.
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
	if (usage !== undefined) {
		found.push(...usageDiagnostics(server.label, usage, spend, actions));
	}
	return [...found].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * The row's spend and usage problems, ranked by the same tiers as everything
 * else on it. The Usage destination used to classify these for its own rows
 * (a tail fact plus a needs-attention predicate plus a forbidden panel, three
 * partial copies); merged onto the server row there is one classifier, and
 * the summary count can never disagree with what a row renders.
 */
function usageDiagnostics(
	label: string,
	card: UsageServerCardView,
	spend: SpendContext,
	actions: { readonly onRefreshUsage?: () => void; readonly refreshing?: boolean }
): readonly RowDiagnostic[] {
	// The fix every usage problem shares: an immediate fleet-wide re-fetch and
	// re-probe (the refreshUsage intent, the same one the section header posts).
	const refreshNow = (id: string): DiagnosticAction[] =>
		actions.onRefreshUsage === undefined
			? []
			: [
					{
						kind: "button",
						id,
						label: actions.refreshing === true ? l10n.t("Refreshing...") : l10n.t("Refresh now"),
						ariaLabel:
							actions.refreshing === true
								? l10n.t("Refreshing usage data")
								: l10n.t("Refresh usage data for {0}", label),
						disabled: actions.refreshing === true,
						onClick: actions.onRefreshUsage,
					},
				];
	if (card.kind === "forbidden") {
		// USER RULING (2026-08-14): a denied usage key is DEGRADED - counted in
		// the attention summary and warn-tinted - not the advisory tier its calm
		// wording might suggest. Nothing here clears itself: only a human can
		// change the key's permission, so the row carries something to act on
		// even though its models keep serving.
		return [
			{
				key: "usage-denied",
				severity: "degraded",
				headline: l10n.t(
					"Usage is unavailable for {0}: this key isn't allowed to read its usage. Ask whoever issued the key to allow it, then use Refresh now - the extension won't re-check on its own.",
					label
				),
				details: detailLines(
					forbiddenRowDetail("/key/info", card.keyInfo),
					forbiddenRowDetail("/user/daily/activity", card.dailyActivity)
				),
				actions: refreshNow("usage-denied-refresh"),
			},
		];
	}
	const found: RowDiagnostic[] = [];
	if (card.keyInfo.kind === "unavailable" && card.keyInfo.reason === "forbidden") {
		// The same user-ruled tier as the whole-card denial: one endpoint
		// refused while the other serves is still a permission only a human can
		// fix, so it counts.
		found.push({
			key: "spend-denied",
			severity: "degraded",
			headline: l10n.t(
				"{0} can't read its spend: this key isn't allowed to. Ask whoever issued the key to allow /key/info, then use Refresh now - the extension won't re-check on its own.",
				label
			),
			details: detailLines(forbiddenRowDetail("/key/info", card.keyInfo)),
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
			details: detailLines(forbiddenRowDetail("/user/daily/activity", card.dailyActivity)),
			actions: refreshNow("statistics-denied-refresh"),
		});
	}
	if (card.keyInfo.kind === "error") {
		// ADVISORY STILL RENDERS IN FULL - that is this tier's contract, not an
		// implementation detail: the headline, the English endpoint detail, and
		// the Refresh now action all render exactly as a degraded line's would,
		// and only the tint and the attention count are reduced. It is advisory
		// because a transient miss clears itself on the next poll; with polling
		// off nothing retries, so the headline names the manual path instead.
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
			details: detailLines(keyInfoDetail(card, spend.discoveryTimeoutMs)),
			actions: refreshNow("usage-refresh-failed-refresh"),
		});
	}
	if (card.spend !== undefined && card.effectiveBudget !== undefined && card.spentFraction !== undefined) {
		// Budget pressure is degraded per the tier contract: the reader set the
		// budget to be told before it runs out, so a crossed threshold is theirs
		// to act on. The line says what the percentage on the row cannot - how
		// far past, or how much is left - and offers no action, because nothing
		// here fixes a budget.
		if (card.spentFraction > 1) {
			found.push({
				key: "over-budget",
				severity: "degraded",
				headline: l10n.t(
					"{0} is over its budget by {1}.",
					label,
					formatMoney(card.spend - card.effectiveBudget, spend.currencySymbol)
				),
				actions: [],
			});
		} else if (barPresentation(card.spentFraction, spend.thresholds).tone !== "ok") {
			found.push({
				key: "budget-pressure",
				severity: "degraded",
				headline: l10n.t(
					"{0} is close to its budget: {1} left.",
					label,
					formatMoney(card.effectiveBudget - card.spend, spend.currencySymbol)
				),
				actions: [],
			});
		}
	}
	return found;
}

/**
 * One problem, indented under the row that owns it, behind a severity rule.
 *
 * The rule's colour and the tint carry the severity together. Colour alone
 * would be the only signal for a reader who cannot separate red from amber,
 * and a tint alone is too weak to rank three levels, so blocking and advisory
 * differ in both.
 */
function ServerDiagnosticLine({ diagnostic }: { diagnostic: RowDiagnostic }) {
	return (
		<div className={`row-diagnostic sev-${diagnostic.severity}`}>
			<p className="row-diagnostic-headline">{diagnostic.headline}</p>
			{(diagnostic.details ?? []).map((detail) => (
				<p key={detail} className="row-diagnostic-detail">
					{detail}
				</p>
			))}
			{diagnostic.actions.length > 0 ? (
				<div className="row-diagnostic-actions">
					{diagnostic.actions.map((action) =>
						action.kind === "button" ? (
							<Button
								key={action.id}
								variant={action.emphasized === true ? undefined : "secondary"}
								size="compact"
								aria-label={action.ariaLabel}
								// aria-disabled, not disabled: the `disabled` attribute drops
								// focus to the body, so pressing Retry threw the keyboard
								// user back to the top of the document at the exact moment
								// they acted - and took the announcement with them, since a
								// changed accessible name is announced on the FOCUSED
								// element. This keeps the node focused, keeps it in the tab
								// order, and lets "Checking Prod" be spoken; the handler
								// refuses the click instead of the attribute doing it.
								aria-disabled={action.disabled === true}
								onClick={() => {
									if (action.disabled !== true) {
										action.onClick();
									}
								}}
							>
								{action.label}
							</Button>
						) : (
							<DocsLink key={action.id} href={action.href} label={action.ariaLabel}>
								{action.label}
							</DocsLink>
						)
					)}
				</div>
			) : null}
		</div>
	);
}

/**
 * The inactive surfaces one noticed row names, as a short localized phrase
 * ("per-server model parameters, per-server custom headers"). Resolved at
 * call time (no module-level localized constants).
 */
function inactiveSurfacesText(server: DashboardServer): string {
	return INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true)
		.map((notice) => INACTIVE_NOTICE_PRESENTATION[notice].surface())
		.join(", ");
}

/**
 * The identity fix, spelled once: the entry-inactive line's detail sentence,
 * reused by every diagnostic that withholds a one-click entry write because
 * the group may not carry the entry's labeled identity - the words that
 * explain the missing button are the words that fix its cause.
 */
function entryInactiveFixText(): string {
	return l10n.t(
		"The provider group serving this entry may not carry the entry's labeled identity. Delete the group's object from the models file (chatLanguageModels.json), reload the window, then run Sync models - or save the entry under a new label instead."
	);
}

/**
 * The dot's tone, derived from the row's WORST diagnostic rather than computed
 * a second time from the same inputs.
 *
 * The pill used to classify the row itself, which meant two classifiers over
 * one server, and they disagreed in public: an entry serving its declared
 * models through an expected failure wore an amber dot beside the word
 * "Connected" while the line under it was the quiet grey tier, and an entry
 * whose parameters were being ignored wore a green dot over an amber one. The
 * loudest mark on the row contradicted the sentence beneath it. One classifier,
 * one output: whatever the diagnostics say the row costs you, the dot says the
 * same.
 *
 * A row with nothing wrong, and a row whose only note is advisory, are both
 * plain "ok" - an advisory means nothing is wrong, so tinting the dot for one
 * would be the same false alarm the tier itself refuses.
 */
function pillTone(server: DashboardServer, worst: DiagnosticSeverity | undefined): "ok" | "warn" | "error" | "muted" {
	if (server.origin !== "misconfigured" && server.state === "unchecked") {
		// Nothing has looked at it yet, so there is no verdict to tone - and no
		// diagnostic either, which would otherwise read as health.
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
 * The row's plain-language verdict; the tone comes from pillTone. Words only,
 * no hover tips: the pill sits inside the row's disclosure button now, and a
 * focusable tip wrapper inside a button is the same nesting fault as a button
 * in a button. Everything the tips used to say lives where a click reaches it
 * instead - each verdict's story is the diagnostic line under the row, and the
 * unchecked row's next step is its drawer's Discovery last checked fact.
 */
function pillVerdict(server: DashboardServer): string {
	if (server.origin === "misconfigured") {
		// Origin outranks state: the entry never reaches discovery, so whatever
		// state rides the row, the verdict is the invalid entry itself.
		return l10n.t("Misconfigured");
	}
	if (server.state === "ok") {
		return server.error !== undefined ? l10n.t("Sync issue") : l10n.t("Connected");
	}
	if (server.state === "error") {
		if (server.expected === true) {
			// One state, one name across tabs: a row still serving declared models
			// reads Connected here exactly as the Diagnostics grid reads it OK.
			return (server.declaredModelCount ?? 0) > 0 ? l10n.t("Connected") : l10n.t("Expected failure");
		}
		return l10n.t("Error");
	}
	return l10n.t("Not checked");
}

/**
 * The row's status pill: tone dot, plain-language verdict, and how long ago
 * discovery last looked. The word says what state the row is in; the tone says
 * what that state costs, and comes from the row's diagnostics so the two can
 * never drift apart.
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
	const checked = server.lastChecked === undefined ? undefined : relativeTime(server.lastChecked, now);
	// An unchecked row has no time to show, and "just now" would be a lie.
	const time =
		checked === undefined || server.state === "unchecked" ? null : <span className="pill-time">{checked}</span>;
	return (
		<span className={`pill tone-${pillTone(server, worst)}`}>
			<span className="dot" />
			{pillVerdict(server)}
			{time}
		</span>
	);
}

/** The DashboardServer origins as their own types; Extract keeps them in step with the protocol union. */

/**
 * The external row's provenance, the drawer's Origin fact. The copy lives here
 * (classifications cross the boundary, words do not): a removed entry's
 * leftover names the removed label, a rename leftover names both labels, and a
 * row without provenance gets the honest default - added outside this
 * extension, or predating the tracking. Deletion instructions name the models
 * file: VS Code offers extensions no group removal, so the file (or VS Code's
 * own UI) is where deleting actually lives.
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
 * The row's spend-at-a-glance: the budget percentage in the shared severity
 * tone with the 3px meter as a rule beneath it, the plain amount when no
 * budget gives a percentage meaning, and nothing at all for a server without
 * usage data (an empty cell, not an "unknown" marker). The money-against-
 * budget pair lives in the drawer now: the glance is the fraction, the drawer
 * is the figures.
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
	// EVERY non-fresh number wears the one-word qualifier, whatever the cause:
	// the header's "worst fresh budget" clause excludes stale rows from its
	// maximum, and an unmarked 112% right beneath it read as the header
	// contradicting the page. The word is a unit qualifier, not the story -
	// the cause (a failed refresh, a denied key, mere age) lives in the
	// diagnostic line or the drawer's Spend last updated fact.
	const note = usage.fresh ? null : <span className="spend-note text-warn text-[0.85em]">{l10n.t("stale")}</span>;
	// The number says what it is only to someone who can read the meter under
	// it; the hidden noun says it to a screen reader. In hidden text rather
	// than an aria-label, because a plain span has no role that supports one -
	// a label there is simply ignored and would have looked like a fix without
	// being one.
	if (usage.spentFraction !== undefined) {
		const bar = barPresentation(usage.spentFraction, thresholds);
		return (
			<span className="spend-unit">
				<span className={cn("font-mono text-[0.92em] tabular-nums", TONE_TEXT[bar.tone])}>
					<span className="visually-hidden">{l10n.t("Budget spent:")} </span>
					{formatPercent(usage.spentFraction)}
				</span>
				{/* A baseline, not a track. The unfilled remainder used to be a
				    background the fill sat ON, and that made the two contrasts fight:
				    lifting the track off the page pushes the fill toward it - measured
				    on Light Modern, no track colour lets both relationships clear 3:1
				    at once. Decoupled, both are free: the extent is a 1px axis under
				    the bar, the fill sits on the page above it and keeps its saturated
				    tones (ok/warn/err measured 3.8/5.6/6.0 light, 8.2/7.1/4.9 dark).
				    Fill carries the magnitude, axis carries the extent, and the
				    percentage above them carries the precision.
				    Box sizing is content-box (no preflight), so h-[3px] plus the
				    border is a 4px meter with a 3px fill area.
				    The fill names its forced-colors colour at the CALL SITE, beside
				    the tone it overrides: backgrounds flatten to Canvas there while
				    border-color forces to CanvasText, so an unhandled fill leaves the
				    axis standing alone - an empty meter, which is a measured zero on a
				    row that has spend. That is the same reading the no-budget branch
				    must not produce, which is why it renders no axis at all. */}
				<span className="spend-meter h-[3px] overflow-hidden rounded-xs border-axis border-b" aria-hidden="true">
					<span
						className={cn("block h-full forced-colors:bg-[Highlight]", TONE_FILL[bar.tone])}
						style={{ width: `${bar.widthPercent}%` }}
					/>
				</span>
				{note}
			</span>
		);
	}
	return (
		<span className="spend-unit">
			<span className="font-mono text-[0.92em] tabular-nums">
				<span className="visually-hidden">{l10n.t("Spent:")} </span>
				{formatMoney(usage.spend, currencySymbol)}
			</span>
			{note}
		</span>
	);
}

/**
 * Why a server has never reported spend at all, per the /key/info standing:
 * the reason the "Spend last updated" fact carries in place of an age. Reasons are
 * lowercase clauses across the whole drawer - they annotate a dash, they are
 * not sentences of their own.
 */
function neverUpdatedText(server: UsageServerView): string {
	if (server.keyInfo.kind === "unavailable") {
		return server.keyInfo.reason === "forbidden"
			? l10n.t("this key isn't allowed to read its spend")
			: l10n.t("this server doesn't report spend");
	}
	return l10n.t("spend hasn't loaded for this server yet");
}

/**
 * What is wrong with an age that is not fresh, in the same words the row's
 * annotation uses, so a row's marker and its drawer never name the state
 * differently. Undefined while the data is fresh.
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
	// Merely old (laptop asleep, polling off): the plain history marker.
	return l10n.t("possibly stale");
}

/**
 * The spend fact's reason when /key/info gave no spend number: why, and what
 * unblocks it, branched on the standing (a forbidden key, a transient
 * failure, and a server that simply omits the field must not read
 * identically). The dash beside it already says the number is missing, so no
 * branch restates that.
 */
function spendUnknownText(server: UsageServerView, pollingOff: boolean): string {
	switch (server.keyInfo.kind) {
		case "unavailable":
			return server.keyInfo.reason === "forbidden"
				? l10n.t("this key can't read its own spend - ask whoever issued it to allow /key/info, then use Refresh now")
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

/**
 * The one English template for a forbidden endpoint standing; every row
 * prints this same line so pasted issue reports stay uniform. The fix and the
 * re-probe live in the surrounding diagnostic (its headline and its Refresh
 * now action), so the template states the refusal alone - repeating the
 * remedy here said the block's one fact three times.
 */
function forbiddenLine(path: string, status: number | undefined): string {
	return `LiteLLM ${path}:${status !== undefined ? ` HTTP ${status} -` : ""} this key may not read usage data`;
}

/**
 * The compact technical detail for the /key/info standing, undefined when
 * there is nothing wrong (or the data is merely old). English by policy:
 * users paste these lines into issue reports, and every term is protocol
 * vocabulary - endpoint path, HTTP status, setting ID. Built from closed
 * enums and numbers only; response text never exists here by construction.
 *
 * A failed standing reaches a reader only under the advisory headline (the
 * drawer drops this line for an error, since the row's diagnostic carries
 * it), and that headline already says whether a retry is automatic - so no
 * branch here states the retry story a second time.
 */
function keyInfoDetail(server: UsageServerView, discoveryTimeoutMs: number): string | undefined {
	const standing = server.keyInfo;
	switch (standing.kind) {
		case "ok":
			return server.spend === undefined ? "LiteLLM /key/info: OK, no spend field" : undefined;
		case "unknown":
			return server.spend === undefined ? "LiteLLM /key/info: waiting on the first fetch" : undefined;
		case "unavailable":
			return standing.reason === "forbidden"
				? forbiddenLine("/key/info", standing.status)
				: `LiteLLM /key/info: not served on this server${
						standing.status !== undefined ? ` (HTTP ${standing.status})` : ""
					}; request stats still update`;
		case "error": {
			if (standing.classification === "timeout") {
				return `LiteLLM /key/info: timed out after ${discoveryTimeoutMs}ms (whole-call bound incl. retries). If the server is just slow, raise the discovery.timeout setting.`;
			}
			const how =
				standing.status !== undefined
					? `HTTP ${standing.status}`
					: standing.classification === "network"
						? "network error"
						: "request failed";
			return `LiteLLM /key/info: ${how} on the last attempt`;
		}
	}
}

/** The /user/daily/activity detail line, same English-template rules as keyInfoDetail. */
function activityDetail(server: UsageServerView): string | undefined {
	const standing = server.dailyActivity;
	switch (standing.kind) {
		case "ok":
		case "unknown":
			return undefined;
		case "unavailable":
			// Unsupported needs no detail: the fact's own reason covers it.
			return standing.reason === "forbidden" ? forbiddenLine("/user/daily/activity", standing.status) : undefined;
		case "error": {
			const how =
				standing.status !== undefined
					? `HTTP ${standing.status}`
					: standing.classification === "timeout"
						? "timed out"
						: standing.classification === "network"
							? "network error"
							: "request failed";
			return `LiteLLM /user/daily/activity: ${how}`;
		}
	}
}

/**
 * The requests fact's reason when /user/daily/activity has no retained
 * window: the permanent shapes keep their own clauses (unsupported stays the
 * documented normal-shape note, forbidden names the block), and everything
 * else is the transient couldn't-fetch-yet line. The Refresh-now remedy for a
 * denied key lives in the row's diagnostic, not here.
 */
function requestsMissingText(server: UsageServerView): string {
	if (server.dailyActivity.kind === "unavailable") {
		return server.dailyActivity.reason === "forbidden"
			? l10n.t("this key isn't allowed to read request statistics on this server")
			: l10n.t("this server does not serve /user/daily/activity (a normal shape on some setups)");
	}
	return l10n.t("couldn't be fetched yet - retries on the next refresh");
}

/**
 * The English detail line for one denied endpoint standing: the shared
 * forbidden template for the refused endpoint, the not-served note for an
 * unsupported partner (so a mixed 404-plus-403 server states both facts),
 * undefined otherwise. Same policy as keyInfoDetail: English protocol
 * vocabulary users paste into issue reports, built from closed enums and the
 * status number only.
 */
function forbiddenRowDetail(path: string, standing: UsageServerCardView["keyInfo"]): string | undefined {
	if (standing.kind !== "unavailable") {
		return undefined;
	}
	return standing.reason === "forbidden"
		? forbiddenLine(path, standing.status)
		: `LiteLLM ${path}: not served on this server${standing.status !== undefined ? ` (HTTP ${standing.status})` : ""}`;
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
 * A number this server did not report: a dim dash plus the reason in place.
 * Never a zero - a zero is a measurement, and no measurement was taken. The
 * dash alone reads as nothing to a screen reader, so a fact with no reason of
 * its own carries the words instead.
 */
function Absent({ reason }: { reason?: string | undefined }) {
	return (
		<span className="text-muted-foreground">
			<span aria-hidden="true">-</span>
			{reason === undefined ? <span className="sr-only">{l10n.t("not reported")}</span> : <Why text={reason} />}
		</span>
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
 * The request-statistics facts: the retained window, or its stated absence.
 * When the whole window is missing there is exactly ONE cause, so it is
 * stated once, on the Requests fact that owns the window - the two computed
 * rates beneath it show bare dashes (their sr-only "not reported" intact),
 * because repeating the same clause in three consecutive cells taught the
 * reader to skip the column. The present-window branch keeps per-dash
 * reasons, since there the two rates' denominators really can be missing
 * independently.
 */
function RequestFacts({ server }: { server: UsageServerView }) {
	// Retained statistics from a failing endpoint must not read as current:
	// spend freshness says nothing about the activity window. "unknown" stays
	// unmarked - a re-probe is pending, nothing failed yet.
	const outdated = server.dailyActivity.kind === "error" || server.dailyActivity.kind === "unavailable";
	const requests = server.requests;
	if (requests === undefined) {
		return (
			<>
				<Fact label={l10n.t("Requests, 30 days")}>
					<Absent reason={requestsMissingText(server)} />
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
	const spendReason = server.spend === undefined ? spendUnknownText(server, pollingOff) : undefined;
	// The two facts answer different questions, but on a server that has never
	// been fetched they answer with the same sentence; the second one drops its
	// reason rather than repeating the first word for word.
	const neverUpdated = neverUpdatedText(server);
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
 * The usage facts for a card a denied key left without numbers: the SAME rows
 * as a reporting server's inventory, dashed - parity between the two partial
 * states, so a denied drawer does not look like a shorter kind of server. One
 * reason per refused endpoint, on the fact that owns it (Spend for /key/info,
 * Requests for /user/daily/activity); the rows computed from those stay bare
 * dashes, and the block's remedy lives in the row's counted diagnostic rather
 * than being restated on every line.
 */
function DeniedUsageFacts({ card }: { card: UsageForbiddenServerView }) {
	const spendReason =
		card.keyInfo.kind === "unavailable" && card.keyInfo.reason === "unsupported"
			? l10n.t("this server doesn't report spend")
			: l10n.t("this key isn't allowed to read its spend");
	const requestsReason =
		card.dailyActivity.kind === "unavailable" && card.dailyActivity.reason === "unsupported"
			? l10n.t("this server does not serve /user/daily/activity (a normal shape on some setups)")
			: l10n.t("this key isn't allowed to read request statistics on this server");
	return (
		<>
			<Fact label={l10n.t("Spend")}>
				<Absent reason={spendReason} />
			</Fact>
			<Fact label={l10n.t("Budget")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Next reset")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Requests, 30 days")}>
				<Absent reason={requestsReason} />
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
 * The row's whole detail drawer: the entry's own facts, then every usage fact
 * the pushed snapshot holds, one labelled inventory in the shared Fact/Absent
 * vocabulary. Usage is per SERVER, never per model, and every field can be
 * missing - a proxy that does not serve the activity endpoint reports no
 * request statistics at all, which is a normal shape rather than a failure -
 * so absence is designed rather than hidden, and a missing number is never a
 * zero. A denied card keeps the same rows, dashed (DeniedUsageFacts); only a
 * server the snapshot does not cover at all gets the entry facts alone, since
 * seven dashes all saying "this proxy tracks no spend" would be noise, and
 * the section help carries that sentence once.
 */
function ServerDrawer({
	server,
	usage,
	pollingOff,
	discoveryTimeoutMs,
	now,
	currencySymbol,
	onShowModels,
}: {
	server: DashboardServer;
	/** The row's usage card, denied cards included; absent for servers the snapshot does not cover. */
	usage: UsageServerCardView | undefined;
	pollingOff: boolean;
	discoveryTimeoutMs: number;
	now: number;
	currencySymbol: string;
	onShowModels: ((label: string) => void) | undefined;
}) {
	const numbers = usage?.kind === "usage" ? usage : undefined;
	// The endpoint standings' English lines, minus the ones a diagnostic under
	// this row already carries (a denied endpoint, a failed spend fetch): the
	// drawer is the inventory, not a second copy of the row's problems.
	const details =
		numbers === undefined
			? []
			: detailLines(
					numbers.keyInfo.kind === "error" ||
						(numbers.keyInfo.kind === "unavailable" && numbers.keyInfo.reason === "forbidden")
						? undefined
						: keyInfoDetail(numbers, discoveryTimeoutMs),
					numbers.dailyActivity.kind === "unavailable" && numbers.dailyActivity.reason === "forbidden"
						? undefined
						: activityDetail(numbers)
				);
	return (
		<>
			{/* Two columns until the pane cannot hold both. The label column is a
			    fixed 11rem and a value cannot shrink below its longest word, so
			    under about 560px of pane the pair asked for more room than the
			    pane had and the page paid for it by scrolling sideways - which
			    the floor promises does not happen. Stacked, each fact reads as
			    its label and then its value, and the dd's own bottom margin is
			    what keeps the next label from joining the value above it. */}
			<dl className="server-facts m-0 grid max-w-[46rem] grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[0.95em] @max-[560px]/pane:grid-cols-[minmax(0,1fr)] @max-[560px]/pane:gap-y-0">
				{/* "Base URL", the same name the server form gives this field: the
				    row's own label already says which server this is, so a fact
				    labelled "Server" would restate the line above it and misname
				    the address it carries. */}
				<Fact label={l10n.t("Base URL")}>
					<span className="fact-url">
						<UrlBreaks text={server.baseUrl} />
					</span>
				</Fact>
				<Fact label={l10n.t("Authentication")}>
					{/* The credential KIND, never a value: OAuth is a protocol name and
					    stays English by policy. */}
					{server.hasOAuth ? "OAuth" : server.hasApiKey ? l10n.t("API key") : l10n.t("none")}
				</Fact>
				<Fact label={l10n.t("Models")}>
					{/* The whole phrase is the link, not just the digit: a bare "models"
					    fragment beside a number cannot be translated (measure words and
					    word order move), and one word is a poor click target. It lives
					    here rather than on the row because the row is one disclosure
					    button and a button cannot contain a button; the Models
					    destination's server scope chip is the other route. Clicking
					    opens Models scoped to this server; a zero stays plain text,
					    since an empty scoped list has nothing to show. */}
					{onShowModels !== undefined && server.modelCount > 0 ? (
						<Button
							variant="secondary"
							size="compact"
							className="count-link px-1 py-0"
							aria-label={l10n.t("Show models from {0}", server.label)}
							onClick={() => onShowModels(server.label)}
						>
							{server.modelCount === 1 ? l10n.t("1 model") : l10n.t("{0} models", server.modelCount)}
						</Button>
					) : server.modelCount === 1 ? (
						l10n.t("1 model")
					) : (
						l10n.t("{0} models", server.modelCount)
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
					// The provenance story that used to be the external badge's hover
					// tip; the drawer is where a click reaches it now that the badge
					// sits inside the disclosure button.
					<Fact label={l10n.t("Origin")}>
						{l10n.t("external")}
						<Why text={externalTip(server)} />
					</Fact>
				) : null}
				{numbers !== undefined ? (
					<UsageFacts server={numbers} pollingOff={pollingOff} now={now} currencySymbol={currencySymbol} />
				) : usage?.kind === "forbidden" ? (
					<DeniedUsageFacts card={usage} />
				) : null}
			</dl>
			{details.map((detail) => (
				<p key={detail} className="usage-detail mt-2 mb-0 font-mono text-[0.85em] text-muted-foreground">
					{detail}
				</p>
			))}
		</>
	);
}

/**
 * The row's URL, split so the paint can stop spending on the part every reader
 * already assumes without ever dropping it from the row.
 *
 * Eight characters of "https://" sit at the FRONT of an ellipsizing run, so
 * they are what survives truncation while the host - the part that says which
 * server this is - is what the ellipsis eats. The scheme goes visually-hidden
 * rather than away, at every width: the text stays in the DOM, so the
 * accessible name, a copy of the line and a find-in-page all still carry the
 * exact URL the setting holds, and the drawer's Base URL fact prints the whole
 * address. An http:// URL keeps its scheme visible for the opposite reason -
 * plaintext to a proxy holding an API key is worth a reader's attention.
 */
function urlParts(baseUrl: string): { readonly scheme: string; readonly rest: string; readonly quiet: boolean } {
	const secure = "https://";
	// Case-insensitively, because a URL's scheme is: "HTTPS://host" is the same
	// address, and a case-sensitive test would have kept its scheme painted
	// while its neighbours dropped theirs.
	const marked = baseUrl.slice(0, secure.length).toLowerCase() === secure;
	const rest = marked ? baseUrl.slice(secure.length) : baseUrl;
	// A scheme with nothing after it stays visible: "https://" alone is a value
	// someone has to fix, and hiding it would render the row's URL as an empty
	// space - blank exactly where being told is useful.
	return marked && rest.length > 0
		? { scheme: baseUrl.slice(0, secure.length), rest, quiet: true }
		: { scheme: marked ? baseUrl : "", rest: marked ? "" : baseUrl, quiet: false };
}

/**
 * A URL's text with a break opportunity BEFORE each dot, slash, or colon, so
 * a wrapping host divides at its labels ("litellm.example" over ".com")
 * instead of mid-token ("litellm.example." over "com"). <wbr> adds nothing to
 * the text - a copy, a find-in-page, and a screen reader still get the exact
 * string - and overflow-wrap's anywhere stays beneath it as the backstop for
 * a single segment longer than its line.
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
}) {
	const confirmRemove = () => {
		sendRequest("removeServerSetting", { label: server.label });
		onArmRemove(false);
	};
	// The declare control's confirm step, per row: arming one category shows
	// its confirm pair, and only this row's control (row identity is keyed, so
	// a push cannot re-associate the armed state with another server). The
	// pair survives the post - that is where "Declaring..." renders - and
	// disarms when the round trip ends, either answer.
	const [armedDeclare, setArmedDeclare] = useState<ExpectedFailureCategory | undefined>(undefined);
	useEffect(() => {
		if (!declaring) {
			setArmedDeclare(undefined);
		}
	}, [declaring]);
	// The row's disclosure: the drawer with the full inventory. Local state on
	// purpose - a push that reorders rows keeps each drawer with its keyed row,
	// and a closed dashboard forgets, exactly like the model rows.
	const [open, setOpen] = useState(false);
	const drawerId = useId();
	const diagnostics = serverDiagnostics(server, usage, spend, {
		onEdit,
		onRetry,
		retrying,
		syncBusy,
		refreshing,
		onRefreshUsage: () => sendRequest("refreshUsage", null),
		...(server.origin === "declared"
			? { onDeclareExpected, armedDeclare, onArmDeclare: setArmedDeclare, declaring }
			: {}),
	});
	const url = urlParts(server.baseUrl);
	const usageNumbers = usage?.kind === "usage" ? usage : undefined;
	return (
		// One readable block per server, its problems always visible underneath
		// and its full inventory behind the block's own disclosure. The actions
		// are revealed by hover AND focus-within: hover alone would put Remove
		// out of reach of the keyboard entirely, and focus-within is what makes
		// tabbing into the row show the same thing pointing at it does.
		<li className="server-item">
			<div className="server-row">
				{/* The whole readable block is ONE disclosure button - name, verdict,
				    and the meta facts - with the actions cluster as its sibling in
				    the trailing column, because a button cannot contain a button.
				    The line is the button and the chevron is its state mark, the
				    model rows' idiom: decoration only, since aria-expanded already
				    announces the state, so the button's accessible name stays the
				    row's facts. border-control-outline like every other control:
				    transparent in the ordinary themes (no preflight ships, so a bare
				    button would otherwise wear the UA's own box) and the contrast
				    border under high contrast, where a borderless row stops reading
				    as clickable. The hover and open wash lives on the WRAPPER row
				    (the stylesheet's :has rules), not here: the button stops short
				    of the actions column, and a wash that stopped with it cut the
				    row into two boxes with a bare gutter between them. */}
				<button
					type="button"
					className="server-line rounded-sm border border-control-outline text-left focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
					aria-expanded={open}
					// Only while the drawer exists: an aria-controls pointing at an
					// unmounted id is a dangling reference, and aria-expanded already
					// carries the state.
					aria-controls={open ? drawerId : undefined}
					onClick={() => setOpen(!open)}
				>
					<span className="server-chevron">
						<IconChevronRight />
					</span>
					<span className="server-name">
						<span className="server-label-text">{server.label}</span>
						{server.origin === "misconfigured" ? <span className="server-tag">{l10n.t("not in use")}</span> : null}
					</span>
					<span className="server-status">
						<StatusPill server={server} worst={diagnostics[0]?.severity} now={now} />
					</span>
					{/* The row's second line once the pane is narrow, and nothing at all
					    while it is wide: `display: contents` hands these four straight to
					    the button's grid, so one markup carries both shapes. Their order
					    here is the order they are wanted in - where it is, what it holds,
					    what it costs, how it authenticates - and the columns they land in
					    are named by the stylesheet, not by this order. */}
					<span className="server-meta">
						<span className="server-url">
							{/* One text run, two treatments: the scheme is its own element so
							    the stylesheet can hide it from the paint alone. */}
							{url.scheme.length > 0 ? (
								<span className={url.quiet ? "url-scheme quiet" : "url-scheme"}>{url.scheme}</span>
							) : null}
							<UrlBreaks text={url.rest} />
						</span>
						<span className="server-count">
							{/* The count carries its own noun, so the row needs no column
							    header to say what the number is. Plain text here: the row is
							    one disclosure button and a button cannot contain a button, so
							    the count's link into the scoped Models list lives in the
							    drawer's Models fact instead. */}
							<span className="count-plain">
								{server.modelCount === 1 ? l10n.t("1 model") : l10n.t("{0} models", server.modelCount)}
							</span>
						</span>
						<span className="server-usage">
							<SpendUnit usage={usageNumbers} thresholds={spend.thresholds} currencySymbol={spend.currencySymbol} />
						</span>
						<span className="server-badges">
							{/* The credential kind is the information, so it is the visible
						    text; a generic "auth" badge would hide it in a hover tip. */}
							{server.hasApiKey || server.hasOAuth ? (
								<Badge>{server.hasOAuth ? "OAuth" : l10n.t("API key")}</Badge>
							) : null}
							{/* The provenance story is the drawer's Origin fact; a hover tip
							    here would be a focusable wrapper inside this button. */}
							{server.origin === "external" ? <Badge>{l10n.t("external")}</Badge> : null}
						</span>
					</span>
				</button>
				<span className={armed ? "server-actions armed" : "server-actions"}>
					{armed ? (
						<>
							<Button
								variant="danger"
								size="compact"
								onClick={() => {
									// The same two-step confirm for every origin; only the intent
									// differs (a declared or misconfigured entry is removed from
									// the setting by label, an external group is hidden by
									// tombstone).
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
							<Button variant="secondary" size="compact" onClick={() => onArmRemove(false)}>
								{l10n.t("Cancel")}
							</Button>
						</>
					) : (
						<>
							{/* A misconfigured entry has no Edit here: it cannot round-trip
							    through the form without rewriting what the user typed, and its
							    fix action - reveal the setting - is already the first action of
							    the blocking line directly beneath this row. Two copies of one
							    button, and the row's copy was the expensive one: it is the
							    widest label the column ever holds, so in a narrow pane it wrapped
							    the cluster onto a second line and pushed the row's own facts down
							    past the hole that left. The line below offers the fix AND says
							    why it is needed, which is the better of the two places to keep
							    it. */}
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
							{/* A legacy-registry external row is not hideable (the registry
							    path would keep serving its models), so it keeps Edit only. */}
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
						pollingOff={spend.pollingOff}
						discoveryTimeoutMs={spend.discoveryTimeoutMs}
						now={now}
						currencySymbol={spend.currencySymbol}
						onShowModels={onShowModels}
					/>
				</div>
			) : null}
			{/* OUTSIDE the disclosure, always visible: a problem carries actions,
			    and an action behind a fold is an action most readers never find. */}
			{diagnostics.map((diagnostic) => (
				<ServerDiagnosticLine key={diagnostic.key} diagnostic={diagnostic} />
			))}
		</li>
	);
}

/**
 * The collapsed hidden-groups line: one muted sentence stating the count,
 * expandable to a row per hidden group with its Unhide. Unhide clears the
 * removal tombstone extension-side; the group's models return on the host's
 * next re-resolution, which the extension triggers itself.
 */
function HiddenGroupsLine({ hidden }: { hidden: readonly HiddenGroup[] }) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();
	if (hidden.length === 0) {
		return null;
	}
	// One control that states the whole thing, rather than a sentence with an
	// action embedded in it. "1 hidden group -  show" left a dangling separator
	// and a lowercase fragment whose object was three words behind it; a reader
	// had to assemble the two halves to learn what "show" would show. Saying it
	// once is also fewer words on the page, which is the direction the whole
	// surface is moving.
	// "Hide 1 hidden group" is what saying it symmetrically costs: the count is
	// the reason to open the list and says nothing once it is open, and the rows
	// beneath are their own answer to how many there are.
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
				// Named while it exists: aria-expanded says a control opens something,
				// and without this nothing says WHAT. Only while open, because an
				// aria-controls pointing at an unmounted id is a dangling reference.
				aria-controls={expanded ? listId : undefined}
				onClick={() => setExpanded((value) => !value)}
			>
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
 * The header's spend figure: the worst FRESH server's spend against its
 * budget, as a fraction - deliberately not a total.
 *
 * Spends cannot be summed. Two entries may authenticate with the same key, in
 * which case both report that key's spend and a total counts it twice; stale
 * and never-loaded servers would fold into the sum as though they were current.
 * The status bar already resolves this the same way, taking a maximum and never
 * a sum (docs/usage.md), so this reads the same number the status bar does and
 * the two cannot disagree about the same fleet.
 *
 * A server with spend but no budget has nothing to be a percentage of, so it
 * contributes nothing here; its row's drawer is where its bare spend lives.
 */
function worstFreshBudgetFraction(usage: DashboardUsage | undefined): number | undefined {
	const fractions = (usage?.servers ?? []).flatMap((server) =>
		server.kind === "usage" &&
		server.fresh &&
		server.spend !== undefined &&
		server.effectiveBudget !== undefined &&
		server.effectiveBudget > 0
			? [server.spend / server.effectiveBudget]
			: []
	);
	return fractions.length === 0 ? undefined : Math.max(...fractions);
}

/**
 * The header's state summary: how many servers, how many need attention (the
 * same classifier verdict the rows render), the worst fresh budget fraction,
 * and whether the numbers refresh on their own. Every clause is a whole
 * sentence fragment so extraction sees literals, not concatenation. One line
 * for the one list - its predecessor counted "servers with usage data" while
 * the page header counted every configured server, two totals a hundred
 * pixels apart.
 */
function serversMeta(serverCount: number, attentionCount: number, usage: DashboardUsage | undefined): string {
	const clauses = [serverCount === 1 ? l10n.t("1 server") : l10n.t("{0} servers", serverCount)];
	if (attentionCount > 0) {
		clauses.push(attentionCount === 1 ? l10n.t("1 needs attention") : l10n.t("{0} need attention", attentionCount));
	}
	const worst = worstFreshBudgetFraction(usage);
	if (worst !== undefined) {
		clauses.push(l10n.t("worst fresh budget {0}", formatPercent(worst)));
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
	// The section's own outcome hooks, one per acked method it surfaces: the
	// failure banners render each hook's latest fail outcome (a later ok
	// replaces it, so success retires the banner exactly like the old
	// store-clearing did), and Dismiss is the hook's reset. These are separate
	// hook instances from the open form's own - both see the same envelopes.
	const saveIntent = useIntentOutcome("saveServerSetting");
	const removeIntent = useIntentOutcome("removeServerSetting");
	const adoptIntent = useIntentOutcome("adoptServer");
	const hideIntent = useIntentOutcome("hideExternalServer");
	const unhideIntent = useIntentOutcome("unhideServer");
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	// The row whose Retry is in flight, and the request that will answer it.
	//
	// The sync answers for itself now: syncModels is an acked method, so the
	// round trip that started the work is the one that reports it over. Nothing
	// here watches the page for evidence.
	//
	// The id is held, not just the label. useIntentOutcome hands a consumer the
	// latest envelope for the METHOD whoever posted it, and the rail's Sync
	// button posts the same method - so clearing on presence alone would let
	// the rail's sync switch off a row's spinner while that row's own pass is
	// still running.
	//
	// It used to infer completion instead, and the inference was subtle enough
	// to be worth remembering. A state push is not the signal, however much it
	// looks like one: a sync reconciles the provider groups first and that
	// reconciliation pushes immediately, while the discovery it exists to
	// trigger has not started, so "checking" cleared seconds into a pass that
	// runs for a minute. The workaround watched the fleet's newest lastChecked
	// instead and cleared when it advanced - which meant an unrelated
	// background refresh could clear the reader's spinner, and a sync that
	// failed before reaching discovery moved nothing and stranded it until a
	// two-minute timer gave up. Both of those are gone with the observation.
	const [retrying, setRetrying] = useState<{ readonly label: string; readonly requestId: string } | undefined>(
		undefined
	);
	// A different question from "is a sync running": whether the fleet has ever
	// been checked at all, which the live region below needs so a first-run page
	// does not announce a clean bill of health it never took.
	const newestCheck = latestCheckedMs(servers) ?? 0;
	const syncIntent = useIntentOutcome("syncModels");
	const syncOutcome = syncIntent.outcome;
	// Clear on either answer to THIS row's request. A failed sync is still a
	// finished one as far as the control is concerned, and its failure is
	// deliberately not rendered here: runModelSync reports every outcome of its
	// own as a VS Code toast, and App drops acked-method failures on purpose
	// (they belong to the hook that posted them), so a second notice beside the
	// row would say the same thing twice.
	useEffect(() => {
		setRetrying((current) => (current !== undefined && syncOutcome?.id === current.requestId ? undefined : current));
	}, [syncOutcome]);
	// The row whose declare-expected intent is unanswered, keyed like the
	// retry state: the hook reports the METHOD's latest outcome whoever posted
	// it, so only the answer to THIS request may clear the row's in-flight
	// state - either answer, because a failed declare is a finished one.
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
	// The one-time post-adoption notice: the old host-owned group survives (no
	// removal API), so the user is told plainly why models now appear twice.
	const [adoptNotice, setAdoptNotice] = useState<string | undefined>(undefined);
	// The hide round trip: the posted intent's requestId plus the row's label,
	// so the guidance notice below can name the exact group to delete once the
	// ack lands. Copy is composed here; only the ack crosses the boundary.
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
	// The whole snapshot's spend inputs, once: the rows' units, the diagnostics,
	// and the header meta all read the same object, so a threshold can never
	// rank a row differently from the line under it.
	const spend: SpendContext = {
		thresholds: usage?.thresholds ?? [],
		currencySymbol,
		pollingOff: usage?.pollIntervalMs === 0,
		discoveryTimeoutMs: usage?.discoveryTimeoutMs ?? 0,
	};
	// Usage is tracked per declared entry and keyed by its label (the usage
	// store's documented join key back to the server rows), so only declared
	// rows look it up; a URL spelling difference must not break the join.
	// Denied cards join too: they carry no numbers, but they carry the row's
	// usage-denied diagnostic, which the user ruling counts as needing action.
	const usageByLabel = new Map((usage?.servers ?? []).map((view) => [view.label, view] as const));
	const usageFor = (server: DashboardServer) =>
		server.origin === "declared" ? usageByLabel.get(server.label) : undefined;
	// How many rows are carrying something worth acting on. Read through the
	// same classifier the rows render, never a second predicate beside it: two
	// definitions of "needs attention" would drift, and the summary would start
	// counting rows that look fine (or miss ones that do not). Advisories are
	// excluded on purpose - nothing there needs a hand, so counting them would
	// call a healthy fleet unhealthy - while a denied usage key counts, per the
	// tier contract's user-ruled carve-out.
	const attentionCount = servers.filter((server) =>
		serverDiagnostics(server, usageFor(server), spend, { onEdit: () => {}, onRetry: () => {} }).some(
			(diagnostic) => diagnostic.severity !== "advisory"
		)
	).length;

	// The post-adoption notice: the old host-owned group survives (there is no
	// removal API), so the reader coming back to this list is told plainly why
	// their models now appear twice. The edit page owns the round trip and
	// leaves on its own ack; this hook sees the same envelope, which is what
	// lets the notice belong to the list rather than to the page that left.
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
			// The trigger sits near the top of the document, where a tip placed
			// above it clips.
			helpBelow
			docs={{ href: DOCS_LINK_SERVERS, label: l10n.t("Open the servers guide") }}
			meta={noServers ? undefined : serversMeta(servers.length, attentionCount, usage)}
			// The header line caps at the list's own measure: a rule running
			// 200px past the last row reads as page furniture rather than as
			// this section's header.
			headerClassName="max-w-[64rem]"
			// First run shows the guided card alone; a header full of disabled
			// controls would put dead buttons before the guidance.
			actions={
				noServers ? undefined : (
					<>
						<Button onClick={onAddServer}>
							<IconAdd /> {l10n.t("Add server")}
						</Button>
						{/* The usage re-fetch and availability re-probe, fleet-wide (the
						    same intent the diagnostic lines' Refresh now posts). Native
						    disabled is fine here: the header never collapses to an
						    icon-only control, so the label always explains itself. */}
						<Button
							variant="secondary"
							disabled={usage?.refreshing === true || noServers}
							onClick={() => sendRequest("refreshUsage", null)}
						>
							{usage?.refreshing === true ? (
								<>
									<span className="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
								</>
							) : (
								l10n.t("Refresh now")
							)}
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
					{/* The verdict for the whole list, and the only live region on it.
					    The retired banners carried role="alert", so without this a
					    screen-reader user got no announcement at all when a sync
					    landed and rows changed underneath them. Polite, not assertive:
					    it reports a result the reader asked for, it does not interrupt.
					    One region for the page rather than one per row, because five
					    rows announcing themselves on every push is noise, not news.
					    The sighted reader's copy of the count is the header's meta
					    line; a second visible line here would be the two-counts defect
					    this page just dissolved. */}
					<p className="visually-hidden" role="status" aria-live="polite">
						{attentionCount > 0
							? attentionCount === 1
								? l10n.t("1 server needs attention")
								: l10n.t("{0} servers need attention", attentionCount)
							: newestCheck > 0
								? l10n.t("All servers are healthy")
								: // Nothing has been checked yet, so there is no verdict to
									// give. "All servers are healthy" here would be the page
									// asserting a clean bill of health it has never taken -
									// which is exactly the reassurance a first-run reader
									// would act on.
									l10n.t("No servers have been checked yet")}
					</p>
					<ul className="server-list max-w-[64rem]">
						{servers.map((server) => (
							// Keyed identity (the error banner's idiom: origin plus the
							// external row's opaque handle or the row's unique label -
							// declared labels are setting-unique, misconfigured rows are
							// deduplicated by label extension-side) so an async push that
							// inserts, removes, or reorders entries does not re-associate
							// another server's row with the user's focus.
							<ServerRow
								key={`${server.origin}:${server.adoptHandle ?? server.label}`}
								server={server}
								usage={usageFor(server)}
								spend={spend}
								now={now}
								armed={armedRemove === server.label}
								onEdit={() => {
									// The one place the destination's purpose is decided: a
									// declared row edits, an external row adopts. A
									// misconfigured row renders no Edit at all (its shape
									// cannot round-trip the form); the guard keeps the
									// narrowing honest.
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
							/>
						))}
					</ul>
				</>
			)}
			<HiddenGroupsLine hidden={hidden} />
		</Section>
	);
}
