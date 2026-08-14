import * as l10n from "@vscode/l10n";
import { useEffect, useId, useState } from "react";
import { latestCheckedMs } from "../../dashboard/presenters";
import { sectionFailureText } from "../../dashboard/serverForm";
import type {
	DashboardServer,
	DashboardUsage,
	ExternalDashboardServer,
	HiddenGroup,
	InactiveEntryNotice,
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
import { DocsLink, Help, HoverTip } from "./help";
import { helpServersSection } from "./helpText";
import { useIntentOutcome } from "./hooks";
import { IconAdd } from "./icons";
import { troubleshootingLink } from "./serverEditPage";
import { relativeTime } from "./time";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { barPresentation, formatPercent, formatUsd } from "./usage";
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
 * How much a problem costs the reader, which is the only thing that should
 * decide how loud it looks.
 *
 * "blocking" means this server serves nothing until someone acts. "degraded"
 * means it serves, but less than it should, or part of its configuration is
 * not reaching it. "advisory" means nothing is wrong - the configuration
 * applies as written and we are only naming something the reader may not
 * remember setting up - and these must stay quiet, or they train the reader to
 * ignore the loud ones.
 *
 * The tiers are what the summary line counts, so a tier is a promise about
 * whether someone has to act, not a volume knob. Anything the reader must do
 * something about is degraded at the least, however calmly it reads.
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
	/** The server's own words, when it had any. English by policy - it lands in issue reports. */
	readonly detail?: string | undefined;
	readonly actions: readonly DiagnosticAction[];
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
			detail: server.problems?.join("; "),
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
	if (error !== undefined && server.origin !== "misconfigured") {
		const declared = server.declaredModelCount ?? 0;
		const expected = server.expected === true;
		const headline = statusErrorHeadline(error);
		if (!expected) {
			// A live group whose sync failed keeps serving what it already had, so
			// it is degraded rather than blocking; one that has nothing serves
			// nothing.
			const serving = server.state === "ok" || server.modelCount > 0;
			found.push({
				key: "discovery-error",
				severity: serving ? "degraded" : "blocking",
				headline: serving
					? l10n.t("{0} is serving its last known models; the newest sync failed: {1}", server.label, headline)
					: l10n.t("{0} is serving no models: {1}", server.label, headline),
				detail: statusErrorDetail(error),
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
								// form, writing exactly the category the headline names.
								...declareActions("modelListing"),
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
			// fact the reader may not remember configuring.
			found.push({
				key: "expected-serving",
				severity: "advisory",
				headline:
					declared === 1
						? l10n.t("{0} serves 1 declared model; discovery is expected to fail here: {1}", server.label, headline)
						: l10n.t(
								"{0} serves {1} declared models; discovery is expected to fail here: {2}",
								server.label,
								declared,
								headline
							),
				detail: statusErrorDetail(error),
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
				detail: statusErrorDetail(error),
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
	if (
		server.state === "ok" &&
		server.modelInfoUnsupported !== undefined &&
		server.origin === "declared" &&
		// An inactive entry cannot receive the declaration until its group is
		// recreated; that row's entry-inactive line already owns the fix.
		server.notices?.includes("entry-capabilities-inactive") !== true
	) {
		// The quiet tier on purpose: the models serve and the configuration
		// applies as written - the declaration marks the failing probe as normal
		// (single attempt, info-level log, no hint). It does NOT shorten the
		// probe's wait: a hanging endpoint still spends one discovery timeout
		// per sync, and only a lower discovery.timeout shortens that - so the
		// copy promises the marking, never speed.
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
			// English by policy, like every detail: the exact endpoints and the
			// declaration the action writes.
			detail:
				server.modelInfoUnsupported === "timeout"
					? 'GET /model/info times out; GET /models succeeds. The action writes "expectedFailures": ["modelInfo"] on this entry.'
					: 'GET /model/info answers HTTP 404/405; GET /models succeeds. The action writes "expectedFailures": ["modelInfo"] on this entry.',
			actions: [...declareActions("modelInfo"), openAiCompatibleGuide],
		});
	}
	const inactive = INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true);
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
			detail: l10n.t(
				"The provider group serving this entry may not carry the entry's labeled identity. Delete the group's object from the models file (chatLanguageModels.json), reload the window, then run Sync models - or save the entry under a new label instead."
			),
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
	return [...found].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
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
			{diagnostic.detail !== undefined ? <p className="row-diagnostic-detail">{diagnostic.detail}</p> : null}
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

/** The row's plain-language verdict and the tip that expands it; the tone comes from pillTone. */
function pillVerdict(server: DashboardServer): { readonly word: string; readonly tip?: string | undefined } {
	if (server.origin === "misconfigured") {
		// Origin outranks state: the entry never reaches discovery, so whatever
		// state rides the row, the verdict is the invalid entry itself.
		return {
			word: l10n.t("Misconfigured"),
			tip: l10n.t(
				"This entry in the servers setting is invalid and is not used until fixed; the line under this row lists the problems."
			),
		};
	}
	if (server.state === "ok") {
		if (server.error !== undefined) {
			return {
				word: l10n.t("Sync issue"),
				tip: l10n.t(
					"The server answered, but its last settings sync reported a problem; the line under this row has the details."
				),
			};
		}
		return { word: l10n.t("Connected") };
	}
	if (server.state === "error") {
		if (server.expected === true) {
			const declared = server.declaredModelCount ?? 0;
			// One state, one name across tabs: a row still serving declared models
			// reads Connected here exactly as the Diagnostics grid reads it OK.
			return declared > 0
				? {
						word: l10n.t("Connected"),
						tip: l10n.t(
							"Discovery failed in a category this entry expects; its declared models keep serving. The line under this row has the details."
						),
					}
				: {
						word: l10n.t("Expected failure"),
						tip: l10n.t(
							"Discovery failed in a category this entry expects. Nothing is declared, so no models are served; add IDs to the entry's discovery.declared."
						),
					};
		}
		return { word: l10n.t("Error") };
	}
	return {
		word: l10n.t("Not checked"),
		tip: l10n.t("Declared in settings; no discovery pass has seen it yet. Run Sync models to check it now."),
	};
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
	const { word, tip } = pillVerdict(server);
	const pill = (
		<span className={`pill tone-${pillTone(server, worst)}`}>
			<span className="dot" />
			{word}
			{time}
		</span>
	);
	// Native title attributes do not render in the webview host, so anything the
	// pill wants to add rides the hover tip instead.
	return tip === undefined ? pill : <HoverTip tip={tip}>{pill}</HoverTip>;
}

/** The DashboardServer origins as their own types; Extract keeps them in step with the protocol union. */

/**
 * The external badge's hover tip, from the row's provenance classification.
 * The copy lives here (classifications cross the boundary, words do not):
 * a removed entry's leftover names the removed label, a rename leftover names
 * both labels, and a row without provenance gets the honest default - added
 * outside this extension, or predating the tracking. Deletion instructions
 * name the models file: VS Code offers extensions no group removal, so the
 * file (or VS Code's own UI) is where deleting actually lives.
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
 * The row's spend-at-a-glance, from the same pushed usage snapshot the Usage
 * tab renders: the spend percentage with the Usage tab's severity tone when a
 * budget exists, the plain spend when none does, and nothing at all for a
 * server without usage data (an empty cell, not an "unknown" marker).
 */
function UsageCell({ usage, thresholds }: { usage: UsageServerView | undefined; thresholds: readonly number[] }) {
	if (usage?.spend === undefined) {
		return null;
	}
	// The number says what it is only to someone who remembers the column header
	// that no longer exists. "42%" beside a model count could be uptime or cache
	// hits; the accessible name says which, and the tip says it to everyone
	// else. The count cell earned its header's removal by naming itself; this
	// one cannot, because a percentage has no noun.
	// The noun goes in hidden text rather than an aria-label: a plain span has
	// no role that supports one, so a label there is simply ignored and would
	// have looked like a fix without being one.
	if (usage.spentFraction !== undefined) {
		return (
			<HoverTip tip={l10n.t("Spend against this server's budget")}>
				<span className={`usage-cell tone-${barPresentation(usage.spentFraction, thresholds).tone}`}>
					<span className="visually-hidden">{l10n.t("Budget spent:")} </span>
					{formatPercent(usage.spentFraction)}
				</span>
			</HoverTip>
		);
	}
	return (
		<HoverTip tip={l10n.t("Spend so far; this server has no budget to measure it against")}>
			<span className="usage-cell">
				<span className="visually-hidden">{l10n.t("Spent:")} </span>
				{formatUsd(usage.spend)}
			</span>
		</HoverTip>
	);
}

/**
 * The row's URL, split so a narrow pane can stop PAINTING the part every reader
 * already assumes without ever dropping it from the row.
 *
 * Eight characters of "https://" is a quarter of the line the URL gets in a
 * narrow pane, and it is spent at the FRONT, so the ellipsis eats the host -
 * the part that says which server this is. At narrow the scheme goes
 * visually-hidden rather than away: the text stays in the DOM, so the accessible
 * name, a copy of the line and a find-in-page all still carry the exact URL the
 * setting holds, and only the paint changes. An http:// URL keeps its scheme
 * visible at every width for the opposite reason - plaintext to a proxy holding
 * an API key is worth a reader's attention.
 */
function urlParts(baseUrl: string): { readonly scheme: string; readonly rest: string; readonly quiet: boolean } {
	const secure = "https://";
	// Case-insensitively, because a URL's scheme is: "HTTPS://host" is the same
	// address, and a case-sensitive test would have kept its scheme painted at
	// narrow while its neighbours dropped theirs.
	const marked = baseUrl.slice(0, secure.length).toLowerCase() === secure;
	const rest = marked ? baseUrl.slice(secure.length) : baseUrl;
	// A scheme with nothing after it stays visible: "https://" alone is a value
	// someone has to fix, and hiding it at narrow would render the row's URL as
	// an empty space - blank at exactly the width where being told is useful.
	return marked && rest.length > 0
		? { scheme: baseUrl.slice(0, secure.length), rest, quiet: true }
		: { scheme: marked ? baseUrl : "", rest: marked ? "" : baseUrl, quiet: false };
}

function ServerRow({
	server,
	usage,
	usageThresholds,
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
}: {
	server: DashboardServer;
	/** The server's usage snapshot entry, when its proxy serves usage data. */
	usage: UsageServerView | undefined;
	/** The usage snapshot's alert thresholds; the cell's severity tone reads them. */
	usageThresholds: readonly number[];
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
	const diagnostics = serverDiagnostics(server, {
		onEdit,
		onRetry,
		retrying,
		syncBusy,
		...(server.origin === "declared"
			? { onDeclareExpected, armedDeclare, onArmDeclare: setArmedDeclare, declaring }
			: {}),
	});
	const url = urlParts(server.baseUrl);
	return (
		// One line per server, its problems indented underneath. The actions are
		// revealed by hover AND focus-within: hover alone would put Remove out of
		// reach of the keyboard entirely, and focus-within is what makes tabbing
		// into the row show the same thing pointing at it does.
		<li className="server-item">
			<div className="server-row">
				<span className="server-name">
					<span className="server-label-text">{server.label}</span>
					{server.origin === "misconfigured" ? <span className="server-tag">{l10n.t("not in use")}</span> : null}
				</span>
				<span className="server-status">
					<StatusPill server={server} worst={diagnostics[0]?.severity} now={now} />
				</span>
				{/* The row's second line once the pane is narrow, and nothing at all
				    while it is wide: `display: contents` hands these five straight to
				    the row's grid, so one markup carries both shapes. Their order here
				    is the order they are wanted in - what it holds, then what it
				    costs, then how it authenticates - and the columns they land in
				    are named by the stylesheet, not by this order. */}
				<span className="server-meta">
					<span className="server-url">
						{/* One text run, two treatments: the scheme is its own element so a
						    narrow pane can hide it from the paint alone. */}
						{url.scheme.length > 0 ? (
							<span className={url.quiet ? "url-scheme quiet" : "url-scheme"}>{url.scheme}</span>
						) : null}
						{url.rest}
					</span>
					<span className="server-count">
						{/* The count carries its own noun, so the row needs no column header
					    to say what the number is. The whole phrase is the link, not just
					    the digit: a bare "models" fragment beside a number cannot be
					    translated (measure words and word order move), and one word is a
					    poor click target. Clicking opens the Models destination scoped to
					    this server; a zero stays plain text, since an empty scoped list
					    has nothing to show. */}
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
						) : (
							<span className="count-plain">
								{server.modelCount === 1 ? l10n.t("1 model") : l10n.t("{0} models", server.modelCount)}
							</span>
						)}
					</span>
					<span className="server-usage">
						<UsageCell usage={usage} thresholds={usageThresholds} />
					</span>
					<span className="server-badges">
						{/* The credential kind is the information, so it is the visible
					    text; a generic "auth" badge would hide it in a hover tip. */}
						{server.hasApiKey || server.hasOAuth ? (
							<Badge>{server.hasOAuth ? "OAuth" : l10n.t("API key")}</Badge>
						) : null}
						{server.origin === "external" ? (
							<HoverTip tip={externalTip(server)}>
								<Badge>{l10n.t("external")}</Badge>
							</HoverTip>
						) : null}
					</span>
				</span>
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

export function ServersSection({
	servers,
	hidden = [],
	usage,
	now,
	onShowModels,
	onEditServer,
	onAdoptServer,
	onAddServer,
}: {
	servers: readonly DashboardServer[];
	/** Groups hidden by an explicit removal; rendered as the collapsed hidden-groups line. */
	hidden?: readonly HiddenGroup[];
	/** The pushed usage snapshot (the Usage tab's source); the rows' Usage cells read it. */
	usage?: DashboardUsage | undefined;
	/** The shared clock tick (one useNow in App), so a hidden panel does not run its own interval. */
	now: number;
	/** Scope the models section below to one server; absent, the count cells stay plain text. */
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
	// How many rows are carrying something worth acting on. Read through the
	// same classifier the rows render, never a second predicate beside it: two
	// definitions of "needs attention" would drift, and the summary would start
	// counting rows that look fine (or miss ones that do not). Advisories are
	// excluded on purpose - the configuration applies as written, so counting
	// them here would call a healthy fleet unhealthy.
	const attentionCount = servers.filter((server) =>
		serverDiagnostics(server, { onEdit: () => {}, onRetry: () => {} }).some(
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

	// Usage is tracked per declared entry and keyed by its label (the usage
	// store's documented join key back to the server rows), so only declared
	// rows look it up; a URL spelling difference must not break the join.
	// Forbidden-usage cards carry no numbers, so they stay out of the join
	// and their rows show an empty cell; the Usage tab renders their story.
	const usageByLabel = new Map(
		(usage?.servers ?? []).flatMap((view) => (view.kind === "usage" ? [[view.label, view] as const] : []))
	);

	// Named once: the heading shows it and the help glyph's accessible name
	// repeats it, and two l10n.t calls for one word is a place they can drift.
	const serversTitle = l10n.t("Servers");

	return (
		<section>
			{/* The glyph and the anchor are the heading's siblings, so the h2's
			    accessible name is "Servers" and not three button labels. The 8px
			    below comes from .section-head, which is the same 8px the zeroed
			    heading gives up. */}
			<div className="section-head">
				<h2 className="m-0">{serversTitle}</h2>
				<Help text={helpServersSection()} name={l10n.t("Help: {0}", serversTitle)} below />
				<DocsLink href={DOCS_LINK_SERVERS} label={l10n.t("Open the servers guide")} />
			</div>
			{/* First run shows the guided card alone; a strip of mostly disabled
			    controls above it would put dead buttons before the guidance. */}
			{!noServers ? (
				<div className="toolbar">
					<Button onClick={onAddServer}>
						<IconAdd /> {l10n.t("Add server")}
					</Button>
				</div>
			) : null}
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
					{/* One quiet line, not a banner: it says how much is wrong without
					    competing with the rows that say WHAT is wrong. Absent when
					    nothing needs attention, because a permanent "0 problems" is
					    furniture that trains the eye to skip the spot. */}
					{/* The verdict for the whole list, and the only live region on it.
					    The retired banners carried role="alert", so without this a
					    screen-reader user got no announcement at all when a sync
					    landed and rows changed underneath them. Polite, not assertive:
					    it reports a result the reader asked for, it does not interrupt.
					    One region for the page rather than one per row, because five
					    rows announcing themselves on every push is noise, not news. */}
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
					{attentionCount > 0 ? (
						<p className="server-summary" aria-hidden="true">
							{attentionCount === 1
								? l10n.t("1 server needs attention")
								: l10n.t("{0} servers need attention", attentionCount)}
						</p>
					) : null}
					<ul className="server-list">
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
								usage={server.origin === "declared" ? usageByLabel.get(server.label) : undefined}
								usageThresholds={usage?.thresholds ?? []}
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
							/>
						))}
					</ul>
				</>
			)}
			<HiddenGroupsLine hidden={hidden} />
		</section>
	);
}
