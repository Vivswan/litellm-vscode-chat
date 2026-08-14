/**
 * The Diagnostics destination: what is wrong with the configuration, how the
 * record model resolved, and the ways out. litellm.showDiagnostics deep-links
 * here through the panel's focusSection message.
 *
 * Three always-open sections, ordered by what the reader can act on. The page
 * used to open with a per-server outcome grid - server, status, model count,
 * last checked, URL, with the error and the inactive-surface notices spanning
 * beneath each row. Every one of those facts now renders on the server's own
 * row on the Servers destination, which is where the fix lives, so the grid
 * said everything twice and said it further from the thing it was about. What
 * remains here is what has no row of its own: the configuration diagnostics,
 * the resolution the records produce, and the support tools.
 *
 * The connection facts survive in the one place they are still the only
 * source for: Copy diagnostics, whose plain-text block is composed from pushed
 * state (which carries no secret values by construction; see the storage
 * invariants) and stays English by policy, because it is destined for public
 * issue reports.
 *
 * The Resolved-models view is request/response-fed (readResolvedModels): it
 * scales with models x fields, re-requests on every state push while the tab
 * is visible, and is local to the dashboard by design - never part of issue
 * reports.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { latestCheckedMs, overallStatusText, serverOutcomeText } from "../../dashboard/presenters";
import type {
	ConfigDiagnosticSeverity,
	ConfigDiagnosticView,
	DashboardServer,
	RecordTreeNode,
	RecordTreeView,
	ResolvedCapCell,
	ResolvedModelRow,
	ResolvedParamCell,
	RevealableSettingId,
} from "../../dashboard/viewModels";
import {
	COST_CAPABILITY_FIELDS,
	capabilityDisplayLabel,
	formatCostPerMillion,
} from "../../shared/config/capabilityDisplay";
import type { RecordDiagnostic } from "../../shared/config/recordResolution";
import type { DocsUrl } from "./docsLinks";
import {
	DOCS_LINK_AUTHENTICATION,
	DOCS_LINK_GETTING_STARTED,
	DOCS_LINK_MODEL_MATCHING,
	DOCS_LINK_RESOLVED_MODELS,
	DOCS_LINK_SETTINGS_MIGRATION,
	DOCS_LINK_USAGE,
} from "./docsLinks";
import type { FeedbackUrl } from "./feedbackLinks";
import { FEEDBACK_LINK_FEATURE_REQUEST, FEEDBACK_LINK_RATE, FEEDBACK_LINK_REPOSITORY } from "./feedbackLinks";
import { DocsLink, HoverTip } from "./help";
import { helpConfigDiagnosticsSection, helpResolutionSection, helpSupportSection } from "./helpText";
import { useRpc } from "./hooks";
import {
	IconBook,
	IconBug,
	IconCheck,
	IconCopy,
	IconLightbulb,
	IconLinkExternal,
	IconOutput,
	IconPlug,
	IconRepo,
	IconStar,
} from "./icons";
import type { InspectorSection } from "./modelInspector";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Section } from "./ui/section";
import { sendRequest } from "./vscodeApi";

/**
 * How much a problem costs the reader, which is the only thing that should
 * decide how loud it looks. The same three tiers the server rows rank their
 * problems by, read against this page's subject - configuration rather than
 * connections - through the same question: does someone have to act, and how
 * much of what they wrote is being lost?
 *
 * "blocking" means this piece of configuration is wholly inert: it was
 * written, and it does nothing at all until someone changes it. "degraded"
 * means part of it is ignored and the rest still applies. "advisory" means
 * nothing is wrong - the value applies exactly as written and we are only
 * naming something that may have been a typo - and these must stay quiet, or
 * they train the reader to ignore the loud ones.
 *
 * Nothing here can be worse than blocking: a server that serves nothing is a
 * server-row problem, and the row that owns it says so.
 */
type DiagnosticSeverity = "blocking" | "degraded" | "advisory";

/** Loudest first: the list is read top to bottom in the order it costs you something. */
const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = { blocking: 0, degraded: 1, advisory: 2 };

/**
 * The tier said in words, for assistive technology.
 *
 * The three tiers are the page's whole organizing principle, and on screen
 * they ride hue, a wash, and the rule's weight and style - none of which a
 * screen reader can report. Without this, eight structurally identical list
 * items announce identically and the ranking the sort performs is invisible
 * to the one reader who cannot see the sort. Visually hidden rather than
 * printed: the sibling server rows carry no tier word either, and adding one
 * to only this surface would split the vocabulary the redesign just unified.
 */
function severityLabel(severity: DiagnosticSeverity): string {
	switch (severity) {
		case "blocking":
			return l10n.t("Not applied at all:");
		case "degraded":
			return l10n.t("Partly ignored:");
		case "advisory":
			return l10n.t("Note:");
	}
}

/**
 * The host's severity as a ceiling on the tier this page assigns.
 *
 * Capability validation is advisory BY CONTRACT - an unrecognized field
 * applies as an override as-is, because it is the user's server - so an
 * advisory stamp must be able to quiet any kind, never the reverse. Applied
 * to every variant rather than to record lints alone: a diagnostic the rail
 * badge leaves untinted must not render as an actionable row underneath it.
 */
function cappedSeverity(hostSeverity: ConfigDiagnosticSeverity, tier: DiagnosticSeverity): DiagnosticSeverity {
	return hostSeverity === "advisory" ? "advisory" : tier;
}

/**
 * One action offered beside a problem. Every one of them REVEALS the place a
 * human fixes it - the setting, the guide - and none rewrites configuration on
 * the reader's behalf: this is their settings file, and a button that silently
 * edited it would be a worse bug than the one it fixed.
 */
type DiagnosticAction =
	/**
	 * `subject` distinguishes repeats: several problems can reveal the same
	 * setting, so the setting id alone would give three buttons one accessible
	 * name. The visible label stays the short verb phrase and stays inside the
	 * accessible name, as Label in Name requires.
	 */
	| { readonly kind: "reveal"; readonly setting: RevealableSettingId; readonly subject: string }
	| { readonly kind: "docs"; readonly label: string; readonly href: DocsUrl; readonly ariaLabel: string };

/** The kinds of diagnostic this destination renders; see pageConfigDiagnostics for what it drops and why. */
type PageConfigDiagnostic = Exclude<ConfigDiagnosticView, { kind: "hidden-groups" }>;

interface ConfigProblem {
	/** Derived from the diagnostic's own identity, so React keeps focus on an action button across pushes. */
	readonly key: string;
	readonly severity: DiagnosticSeverity;
	/**
	 * What it costs, leading with the consequence and keeping the cause: a
	 * reader who stops after the first clause should still know what is not
	 * being applied, and one who reads on should know why.
	 */
	readonly headline: string;
	/** Where it lives, as machine text: setting ids and entry labels, never prose. */
	readonly where: readonly string[];
	/** The parser's structural report, when there is one. English by policy - it also rides the copyable block. */
	readonly detail?: string | undefined;
	readonly actions: readonly DiagnosticAction[];
}

/**
 * Whether one diagnostic belongs on this page, as an exhaustive classification
 * rather than a filter predicate.
 *
 * Two kinds are dropped because a row on the Servers destination reports
 * exactly the same fact, beside the control that fixes it: a rejected servers
 * entry THAT WAS DRAWN A ROW (the row says "<label> is switched off until this
 * entry is fixed" and lists the same parser problems), and hidden provider
 * groups (the hidden-groups line under the server list names them and offers
 * Unhide). Restating either here would be the second half of the duplication
 * the outcome grid's removal ended.
 *
 * `rowOwned` is the host's own answer, not a rule respelled here. A reject
 * with no drawable identity - no label, no base URL, or a label a declared
 * entry or an earlier reject already owns - gets NO row, and this list is then
 * the only place its problems appear. Deciding that from `misconfigured` alone
 * would erase the user's broken entry from both surfaces at once.
 *
 * A switch with no default and an annotated return type, deliberately: a
 * boolean predicate would have let a NEW diagnostic kind reach the page
 * unclassified, and the `is PageConfigDiagnostic` assertion that came with it
 * was unchecked - deleting the hidden-groups clause compiled fine and then
 * failed at runtime. Here a new union member does not typecheck until someone
 * decides which side it is on: `noImplicitReturns` (src/webview/tsconfig.json)
 * is what turns the unhandled case into TS7030, with the downstream
 * PageConfigDiagnostic switches giving TS2366 as a second net.
 */
function pageDiagnostic(diagnostic: ConfigDiagnosticView): PageConfigDiagnostic | undefined {
	switch (diagnostic.kind) {
		case "record":
		case "legacy":
		case "thresholds":
			return diagnostic;
		case "entry":
			return diagnostic.misconfigured && diagnostic.rowOwned ? undefined : diagnostic;
		case "hidden-groups":
			return undefined;
	}
}

/**
 * The diagnostics this page renders, which is not every diagnostic the host
 * builds; see pageDiagnostic for which are dropped and why.
 *
 * Exported because the rail's badge counts what this page shows. Two
 * definitions of "how many problems" would drift, and a badge reading 8 above
 * a list of 6 is the same bug in a smaller font.
 */
export function pageConfigDiagnostics(diagnostics: readonly ConfigDiagnosticView[]): readonly PageConfigDiagnostic[] {
	return diagnostics.flatMap((diagnostic) => {
		const kept = pageDiagnostic(diagnostic);
		return kept === undefined ? [] : [kept];
	});
}

/**
 * A record lint's tier. `unrecognized-key` is named explicitly rather than
 * left to the host's advisory stamp: capability validation is advisory by
 * invariant, and encoding that here makes the contract local instead of a
 * property this file happens to inherit.
 */
function recordSeverity(diagnostic: RecordDiagnostic): DiagnosticSeverity {
	switch (diagnostic.kind) {
		// The one record lint that costs the WHOLE record: no model can ever
		// match the key, so nothing inside it is ever applied.
		case "invalid-matcher":
			return "blocking";
		// The field applies as an override as-is; we are only naming a possible
		// typo.
		case "unrecognized-key":
			return "advisory";
		default:
			return "degraded";
	}
}

/**
 * One diagnostic's tier, independent of how it is worded.
 *
 * Split out of configProblem because the copied report needs the ranking
 * without the localized sentence beside it: the block is English by policy,
 * and reading the tier off a rendered ConfigProblem would have meant building
 * translated text to throw it away.
 */
function problemSeverity(diagnostic: PageConfigDiagnostic): DiagnosticSeverity {
	switch (diagnostic.kind) {
		case "record":
			return cappedSeverity(diagnostic.severity, recordSeverity(diagnostic.diagnostic));
		case "entry":
			return cappedSeverity(diagnostic.severity, diagnostic.misconfigured ? "blocking" : "degraded");
		case "legacy":
			// A parked-headers leftover still has a live route back: the headers
			// are held, and adopting the external group delivers them. The other
			// two hold values that reach nothing and have nowhere to go.
			return cappedSeverity(diagnostic.severity, diagnostic.hint === "parked-global-headers" ? "degraded" : "blocking");
		case "thresholds":
			return cappedSeverity(diagnostic.severity, "degraded");
	}
}

/**
 * One diagnostic as a line for the copied report: the tier, where it lives,
 * and the structural keys, in that order.
 *
 * English by construction rather than by translation - every part is a
 * classification (the tier ids, the lint kind) or a structural key the user
 * typed (setting ids, record keys, field names, the parser's own problem
 * strings). Nothing here goes through l10n, so the block stays English under
 * a Chinese UI without needing an English mirror for each sentence, and it
 * carries no server-derived text into a public issue report.
 */
/**
 * A record key or field name as the COPIED report may carry it.
 *
 * A matcher key is normally a model ID the user typed, which is exactly what
 * makes the copied block worth pasting. A key containing "://" is a different
 * animal: that is the removed server-scoped grammar (the same rule
 * migrations/settingsRedesign/records.ts calls isUrlScopedKey), so the key IS
 * a base URL, and a base URL can carry credentials in its userinfo. The legacy
 * hints module documents these as local-dashboard-only and says they must
 * never reach logs or issue reports; this block is destined for a public
 * GitHub issue, so it redacts rather than trusting that no user ever put a
 * password in a URL.
 *
 * Repeated rather than imported because the webview tree cannot reach
 * src/extension; it is one substring test, and the canonical definition is
 * named above so the two can be compared.
 */
function copySafeKey(key: string): string {
	return key.includes("://") ? "<url-scoped key>" : `"${key}"`;
}

function englishDiagnosticLine(diagnostic: PageConfigDiagnostic): string {
	const tier = problemSeverity(diagnostic);
	switch (diagnostic.kind) {
		case "record": {
			const lint = diagnostic.diagnostic;
			const where =
				diagnostic.entryLabel !== undefined
					? `${diagnostic.setting} (entry "${diagnostic.entryLabel}")`
					: diagnostic.setting;
			const keys =
				lint.key === lint.recordKey
					? copySafeKey(lint.recordKey)
					: `${copySafeKey(lint.recordKey)} / ${copySafeKey(lint.key)}`;
			return `${tier} ${where} ${lint.kind} ${keys}`;
		}
		case "entry": {
			const name = diagnostic.label !== undefined ? `"${diagnostic.label}"` : `#${diagnostic.position}`;
			return `${tier} servers entry ${name}: ${diagnostic.problems.join("; ")}`;
		}
		case "legacy":
			// The classification and the setting it sits in, and nothing else.
			// `oldKey` on a URL-scoped hint IS a base URL, and `detail` on a
			// parked-headers hint is the user's own header names - both are the
			// user text hints.ts documents as local-dashboard-only. For a
			// URL-scoped hint the setting is `detail`; for the two headers hints
			// it is `oldKey`. Every branch yields a setting id, never user text.
			return `${tier} ${diagnostic.hint} (${
				diagnostic.hint === "inert-url-scoped-key" ? diagnostic.detail : diagnostic.oldKey
			})`;
		case "thresholds":
			return `${tier} usage.alertThresholds: ${diagnostic.dropped} dropped`;
	}
}

/**
 * One record lint as a single consequence sentence; classifications and
 * structural keys only, never entered values.
 *
 * One sentence is the whole budget. Two things used to pad these and both are
 * said better elsewhere: the "and the rest still applies" clause, which is
 * exactly what the degraded tier means, and the matcher-key grammar, which is
 * reference material the guide holds. A reader scanning nine of these reads
 * the consequence nine times; they should not also read the manual nine times.
 */
function recordProblemText(diagnostic: RecordDiagnostic): string {
	switch (diagnostic.kind) {
		case "invalid-matcher":
			return l10n.t('Nothing in record "{0}" is applied: that is not a valid matcher key.', diagnostic.recordKey);
		case "unforceable-key":
			// "_ fields" earns its three words: this lint also fires on
			// underscore directive names, and blaming only provider-owned fields
			// would make the sentence wrong for half the cases it covers.
			return l10n.t('Forcing "{0}" has no effect: provider-owned and _ fields stay extension-owned.', diagnostic.key);
		case "unknown-inherit-key":
			return l10n.t(
				'Record "{0}" inherits nothing from "{1}": no record has that name.',
				diagnostic.recordKey,
				diagnostic.key
			);
		case "wrong-record-type":
			return l10n.t('"{0}" is ignored: it belongs to the other record type.', diagnostic.key);
		case "unrecognized-key":
			// Informational (the host marks these advisory): the field APPLIES as
			// written - the open vocabulary keeps it - and the surviving hint only
			// says the observed /model/info evidence does not name the key.
			return l10n.t('"{0}" applies as written, but this extension does not know the field.', diagnostic.key);
		case "invalid-value":
			return l10n.t('"{0}" is ignored: its value is not valid for that field.', diagnostic.key);
		case "invalid-directive":
			return l10n.t('Part of "{0}" is ignored: it carries an invalid directive value.', diagnostic.key);
	}
}

/** One legacy leftover as a single consequence sentence; the remedy lives behind Learn more. */
function legacyProblemText(diagnostic: Extract<ConfigDiagnosticView, { kind: "legacy" }>): string {
	switch (diagnostic.hint) {
		case "inert-url-scoped-key":
			// One cause is the budget: the key grammar's removal is the whole
			// story, and "matches no model ID" was that story retold as a
			// second reason.
			return l10n.t('Nothing uses "{0}": that key grammar was removed.', diagnostic.oldKey);
		case "inert-global-headers":
			return l10n.t("No server sends these headers: the setting that held them was removed.");
		case "parked-global-headers":
			// Consequence first, one negative: the old wording ("provider groups
			// without a server entry no longer get the removed global headers")
			// stacked a negative subject, a temporal claim, and a
			// self-contradicting noun phrase.
			return l10n.t("Externally managed provider groups no longer send the global headers ({0}).", diagnostic.detail);
	}
}

/**
 * The legacy record-key hint names the setting its leftover sits in; only the
 * two record settings can carry one, and narrowing here keeps the assumption
 * in one place with its reason instead of casting at the call site.
 */
function revealTarget(setting: string): RevealableSettingId {
	return setting === "models.capabilities" ? "models.capabilities" : "models.parameters";
}

/** The guide a problem's Learn more opens. The visible text rides the accessible name, as Label in Name requires. */
function docsAction(href: DocsUrl, subject: string): DiagnosticAction {
	return { kind: "docs", label: l10n.t("Learn more"), href, ariaLabel: l10n.t("Learn more: {0}", subject) };
}

/**
 * One configuration diagnostic, ranked and worded for this page. The `where`
 * strings are machine text (setting ids, record layers), so they render as
 * neutral outline badges rather than being folded into the sentence, where a
 * trailing "(models.parameters)" read as an afterthought on every line.
 *
 * Keys come from the diagnostic's own identity, never its list position: an
 * earlier problem appearing on the next push would otherwise slide every key
 * down one and move the user's focus to a different problem's button.
 *
 * The reveal action's `subject` is what makes its accessible name unique.
 * Several problems can name the same setting, and a screen-reader user
 * listing controls would otherwise hear "Show models.parameters in
 * settings.json" three times with nothing to choose between them.
 */
function configProblem(diagnostic: PageConfigDiagnostic): ConfigProblem {
	switch (diagnostic.kind) {
		case "record": {
			// An entry-layer record lives inside the servers setting, so that is
			// the place to reveal; a global one lives in its own setting.
			const setting: RevealableSettingId = diagnostic.entryLabel !== undefined ? "servers" : diagnostic.setting;
			const lint = diagnostic.diagnostic;
			// Identifiers joined by a slash, never a localized phrase: the pair is
			// machine text a reader retypes, and it needs no translation. An
			// invalid matcher key IS the record key, so naming it twice would read
			// as a mistake.
			const subject = lint.key === lint.recordKey ? lint.recordKey : `${lint.recordKey}/${lint.key}`;
			// Two of the sentences still name the record ("Nothing in record X",
			// "Record X inherits nothing"); the other five stopped naming it when
			// they were cut to one clause. Those get it back as a location chip
			// rather than as prose - without it, two records failing on the same
			// field render as identical rows.
			const namesRecord = lint.kind === "invalid-matcher" || lint.kind === "unknown-inherit-key";
			return {
				key: `record:${diagnostic.setting}:${diagnostic.entryLabel ?? ""}:${lint.kind}:${subject}`,
				severity: problemSeverity(diagnostic),
				headline: recordProblemText(lint),
				where: [
					diagnostic.setting,
					...(diagnostic.entryLabel !== undefined ? [l10n.t("entry {0}", diagnostic.entryLabel)] : []),
					...(namesRecord ? [] : [lint.recordKey]),
				],
				// Learn more on the one lint the shortened sentence cannot fix by
				// itself. It points at the same guide the section header links, and
				// N invalid keys still produce N identical links - accepted here
				// and nowhere else, because for this lint the grammar IS the
				// remedy, and the sentence stopped reciting it.
				actions:
					lint.kind === "invalid-matcher"
						? [
								{ kind: "reveal", setting, subject },
								docsAction(DOCS_LINK_MODEL_MATCHING, l10n.t("the model-matching guide")),
							]
						: [{ kind: "reveal", setting, subject }],
			};
		}
		case "entry": {
			// Only entries whose problems no server row states reach this page: a
			// reject that was drawn a row has them there, beside its own controls.
			const name = diagnostic.label !== undefined ? `"${diagnostic.label}"` : `#${diagnostic.position}`;
			return {
				// The position, not the label: a rejected entry can reuse a label
				// an accepted one already owns, and that is exactly the case whose
				// two diagnostics must not collapse onto one key - or one button
				// name, which is why the position rides the subject too.
				key: `entry:${diagnostic.position}`,
				severity: problemSeverity(diagnostic),
				headline: diagnostic.misconfigured
					? l10n.t("Server entry {0} is switched off until it is fixed.", name)
					: l10n.t("Server entry {0} runs without part of its configuration.", name),
				where: ["servers"],
				// The parser's structural reports stay English by policy.
				detail: diagnostic.problems.join("; "),
				actions: [
					{ kind: "reveal", setting: "servers", subject: `${name} #${diagnostic.position}` },
					docsAction(DOCS_LINK_AUTHENTICATION, l10n.t("the authentication guide")),
				],
			};
		}
		case "legacy":
			return {
				// The same leftover key can sit in BOTH record settings, and the
				// two hints differ only in which one; without `detail` they share a
				// key and React drops one of the blocks.
				key: `legacy:${diagnostic.hint}:${diagnostic.oldKey}:${diagnostic.detail}`,
				// A parked-headers leftover still has a live route back: the headers
				// are held, and adopting the external group delivers them. The other
				// two hold values that reach nothing and have nowhere to go.
				severity: problemSeverity(diagnostic),
				headline: legacyProblemText(diagnostic),
				where: diagnostic.hint === "inert-url-scoped-key" ? [diagnostic.detail] : [diagnostic.oldKey],
				actions: [
					{
						kind: "reveal",
						setting: diagnostic.hint === "inert-url-scoped-key" ? revealTarget(diagnostic.detail) : "servers",
						subject: diagnostic.oldKey,
					},
					docsAction(DOCS_LINK_SETTINGS_MIGRATION, l10n.t("the settings-migration guide")),
				],
			};
		case "thresholds":
			return {
				key: "thresholds",
				severity: problemSeverity(diagnostic),
				headline:
					diagnostic.dropped === 1
						? l10n.t("1 alert threshold was dropped: a threshold must be inside (0, 1].")
						: l10n.t("{0} alert thresholds were dropped: a threshold must be inside (0, 1].", diagnostic.dropped),
				where: ["usage.alertThresholds"],
				actions: [
					{ kind: "reveal", setting: "usage.alertThresholds", subject: "usage.alertThresholds" },
					docsAction(DOCS_LINK_USAGE, l10n.t("the usage and budgets guide")),
				],
			};
	}
}

/**
 * One problem, behind a severity rule.
 *
 * The class names are the server rows' own, deliberately: severity is one
 * vocabulary across the dashboard, and two stylesheets spelling the same three
 * tiers would drift the moment either changed. Severity rides three channels
 * there - hue, wash, and the rule's weight and style - so blocking and
 * degraded stay apart for a reader who cannot separate red from amber, and all
 * three stay ranked under forced colours, where every colour collapses to one.
 */
function ConfigProblemLine({ problem }: { problem: ConfigProblem }) {
	return (
		<li className={`row-diagnostic sev-${problem.severity}`}>
			<p className="row-diagnostic-headline">
				<span className="visually-hidden">{severityLabel(problem.severity)} </span>
				{problem.headline}
			</p>
			{problem.where.length > 0 ? (
				<p className="row-diagnostic-where">
					{problem.where.map((where, index) => (
						<Fragment key={where}>
							{/* The badges are separated only by a 4px gap and a hairline
							    outline, so to a screen reader they would run together as
							    "models.parametersentry prod" without this. */}
							{index > 0 ? <span className="visually-hidden">, </span> : null}
							<span className="chip-prov">{where}</span>
						</Fragment>
					))}
				</p>
			) : null}
			{problem.detail !== undefined ? <p className="row-diagnostic-detail">{problem.detail}</p> : null}
			{problem.actions.length > 0 ? (
				<div className="row-diagnostic-actions">
					{problem.actions.map((action) =>
						action.kind === "reveal" ? (
							// The verb is REVEAL, never rewrite: it opens the file at the
							// setting and leaves the editing to the person who owns it.
							<Button
								key={action.subject}
								variant="secondary"
								size="compact"
								aria-label={l10n.t("Show in settings.json: {0} in {1}", action.subject, action.setting)}
								onClick={() => sendRequest("revealSetting", { setting: action.setting })}
							>
								{l10n.t("Show in settings.json")}
							</Button>
						) : (
							<DocsLink key={action.href} href={action.href} label={action.ariaLabel}>
								{action.label}
							</DocsLink>
						)
					)}
				</div>
			) : null}
		</li>
	);
}

/**
 * The configuration problems, worst first. Always present as a section - the
 * page's sections do not appear and disappear under the reader - with the
 * clean state saying so in a sentence rather than leaving a gap where a
 * heading was.
 */
function ConfigDiagnostics({ diagnostics }: { diagnostics: readonly ConfigDiagnosticView[] }) {
	const problems = pageConfigDiagnostics(diagnostics)
		.map(configProblem)
		.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
	// Advisories are excluded from the count for the reason the server summary
	// excludes them: the configuration applies as written, so counting them
	// would call a healthy setup unhealthy. The total rides along when the two
	// numbers differ - the rail badge counts the whole list, and "7" beside a
	// list of 8 is a question the reader should not have to answer.
	const actionable = problems.filter((problem) => problem.severity !== "advisory").length;
	return (
		<Section
			id="config-diagnostics"
			title={l10n.t("Configuration")}
			help={helpConfigDiagnosticsSection()}
			// The trigger sits near the top of the document, where a tip placed
			// above it clips.
			helpBelow
			docs={{ href: DOCS_LINK_MODEL_MATCHING, label: l10n.t("Open the model-matching guide") }}
			meta={
				actionable === 0
					? undefined
					: actionable === problems.length
						? actionable === 1
							? l10n.t("1 needs attention")
							: l10n.t("{0} need attention", actionable)
						: l10n.t("{0} of {1} need attention", actionable, problems.length)
			}
			headerClassName="max-w-[64rem]"
		>
			{problems.length === 0 ? (
				// One clause. Where a server's own problems render is a fact about
				// the product, not about this moment, so it lives in the header's
				// help tip rather than in a line every healthy reader re-reads.
				<p className="hint mt-0">{l10n.t("Your settings read cleanly.")}</p>
			) : (
				<ul className="config-diagnostics">
					{problems.map((problem) => (
						<ConfigProblemLine key={problem.key} problem={problem} />
					))}
				</ul>
			)}
		</Section>
	);
}

/** One tree node's own-fields summary: "temperature 0.3 (inheritable, forced)". */
function nodeFieldText(field: RecordTreeNode["fields"][number]): string {
	const marks = [
		...(field.inheritable
			? [
					l10n.t({
						message: "inheritable",
						comment: ["Checkbox label on a record row; marks the field as inheritable by more specific records."],
					}),
				]
			: []),
		...(field.forced ? [l10n.t("forced")] : []),
		...(field.fallback
			? [
					l10n.t({
						message: "fallback",
						comment: ["Checkbox label on a capability row; applies the value only where the server reports none."],
					}),
				]
			: []),
	];
	return `${field.name} ${field.valueText}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
}

function TreeNode({ node }: { node: RecordTreeNode }) {
	return (
		<li className="tree-node">
			<span className="tree-key">
				<code>{node.key}</code>
			</span>
			{node.fields.length > 0 ? (
				<span className="tree-fields"> {node.fields.map(nodeFieldText).join(", ")}</span>
			) : (
				<span className="hint"> {l10n.t("(no own fields)")}</span>
			)}
			{node.barrier ? <span className="tree-barrier"> [{l10n.t("inheritance stops here")}]</span> : null}
			{!node.barrier && node.inheritFrom !== undefined ? (
				<span className="hint"> [{l10n.t("inherits from: {0}", node.inheritFrom)}]</span>
			) : null}
			{node.children.length > 0 || node.models.length > 0 ? (
				<ul>
					{node.children.map((child) => (
						<TreeNode key={child.key} node={child} />
					))}
					{node.models.map((model) => (
						<li key={model.id} className="tree-model">
							<span className="tree-model-id">{model.id}</span>
							{model.resolvedText.length > 0 ? (
								<span className="hint">
									{" "}
									{"->"} {model.resolvedText}
								</span>
							) : null}
						</li>
					))}
				</ul>
			) : node.models.length === 0 ? (
				<span className="hint"> {l10n.t("(matches no current model)")}</span>
			) : null}
		</li>
	);
}

/** One tree's heading: which record map it draws. */
function treeTitle(tree: RecordTreeView): string {
	if (tree.layer === "entry") {
		return tree.kind === "parameters"
			? l10n.t('Parameters - server entry "{0}"', tree.entryLabel ?? "")
			: l10n.t('Capabilities - server entry "{0}"', tree.entryLabel ?? "");
	}
	return tree.kind === "parameters" ? l10n.t("Parameters - Settings") : l10n.t("Capabilities - Settings");
}

/**
 * One record map as its inheritance tree. Open, with a plain heading: it used
 * to be a <details open>, which spent a disclosure triangle and a pointer
 * cursor advertising a collapse nobody wants on the one figure that explains
 * the whole record model.
 */
function RecordTree({ tree }: { tree: RecordTreeView }) {
	return (
		<div className="record-tree">
			<h3 className="record-tree-title">{treeTitle(tree)}</h3>
			<ul>
				{tree.roots.map((root) => (
					<TreeNode key={root.key} node={root} />
				))}
				{tree.unmatchedModelIds.length > 0 ? (
					<li className="tree-model">
						<span className="hint">
							{tree.unmatchedModelIds.length === 1
								? l10n.t("1 model matches no record here")
								: l10n.t("{0} models match no record here", tree.unmatchedModelIds.length)}
						</span>
					</li>
				) : null}
				{tree.invalidKeys.map((key) => (
					<li key={key} className="tree-model state-warn">
						{l10n.t('"{0}" is not a valid matcher key; it matches nothing', key)}
					</li>
				))}
			</ul>
		</div>
	);
}

/** A parameter cell's provenance, one compact phrase. */
function paramProvenance(cell: ResolvedParamCell): string {
	const base = cell.layer === "entry" ? l10n.t("entry {0}", cell.key) : l10n.t("settings {0}", cell.key);
	const marks = [
		...(cell.forced === true ? [l10n.t("forced")] : []),
		// "inherited from X" earns its words only when X is another record; a
		// value a record holds itself is already named by the base phrase.
		...(cell.inheritedFrom !== undefined && cell.inheritedFrom !== cell.key
			? [l10n.t("inherited from {0}", cell.inheritedFrom)]
			: []),
	];
	return marks.length > 0 ? `${base}; ${marks.join(", ")}` : base;
}

/** A capability cell's provenance, one compact phrase (the caps inspector's level names, shortened). */
function capProvenance(cell: ResolvedCapCell): string {
	const inherited =
		cell.inheritedFrom !== undefined && cell.inheritedFrom !== cell.key
			? `; ${l10n.t("inherited from {0}", cell.inheritedFrom)}`
			: "";
	switch (cell.level) {
		case "entry":
			return l10n.t("entry {0}", cell.key ?? "") + inherited;
		case "global":
			return l10n.t("settings {0}", cell.key ?? "") + inherited;
		case "directive":
			return l10n.t("catalog (directive {0})", cell.key ?? "");
		case "server":
			return l10n.t("server-reported");
		case "entry-fallback":
			return l10n.t("entry fallback {0}", cell.key ?? "") + inherited;
		case "global-fallback":
			return l10n.t("settings fallback {0}", cell.key ?? "") + inherited;
		case "catalog":
			return l10n.t("catalog match");
		case "derived":
			return l10n.t("derived");
		case "floor":
			return l10n.t("default");
	}
}

/**
 * A table chip's text with every space-separated token held whole: below the
 * 920px pane tier the table's chips may wrap internally, and an unguarded
 * wrap breaks record keys at their hyphens ("settings claude-" / "sonnet-4") -
 * the same mid-token split the code cells forbid, on text the chip rule
 * documents as retypeable. Wraps land between tokens, never inside one, and
 * textContent is unchanged.
 */
function ChipTokens({ text }: { text: string }) {
	return (
		<>
			{text.split(" ").map((token, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: tokens can repeat within one chip, and the list rebuilds wholesale with its text
				<Fragment key={`${index}-${token}`}>
					{index > 0 ? " " : null}
					<span className="whitespace-nowrap">{token}</span>
				</Fragment>
			))}
		</>
	);
}

/**
 * One generic capability cell: the friendly label where the consumed
 * vocabulary has one (the value keeps the monospace register), the raw wire
 * key in code otherwise (for an open field the key IS the fact), each with
 * its provenance chip. A labeled cell keeps its wire identity one focusable
 * tip away - this is a debugging surface, and the wire key is what a reader
 * writes into a models.capabilities record.
 */
function CapabilityCell({ cell }: { cell: ResolvedCapCell }) {
	const label = capabilityDisplayLabel(cell.name);
	return (
		<span className="resolved-cell">
			{label !== undefined ? (
				<HoverTip tip={`${cell.name} ${cell.valueText}`}>
					<span className="resolved-field">
						{label} <code>{cell.valueText}</code>
					</span>
				</HoverTip>
			) : (
				<code>
					{/* Key and value each hold together; a narrow column breaks the
					    line BETWEEN them, never inside a token - a quoted value like
					    "gold-eu-west" was splitting at its hyphens. */}
					<span className="whitespace-nowrap">{cell.name}</span>{" "}
					<span className="whitespace-nowrap">{cell.valueText}</span>
				</code>
			)}
			<span className="chip-prov">
				<ChipTokens text={capProvenance(cell)} />
			</span>
		</span>
	);
}

/**
 * The supported-params list as its count, the full list one focusable tip
 * away (a 27-element JSON array printed inline made the whole table
 * unscannable). A cell whose value is not the validated string array falls
 * back to the generic rendering rather than miscounting.
 */
function ParamsListCell({ cell }: { cell: ResolvedCapCell }) {
	let list: readonly string[] | undefined;
	try {
		const parsed: unknown = JSON.parse(cell.valueText);
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
			list = parsed;
		}
	} catch {
		// Fall through to the generic cell: valueText was not JSON.
	}
	if (list === undefined) {
		return <CapabilityCell cell={cell} />;
	}
	return (
		<span className="resolved-cell">
			<span className="resolved-field">{capabilityDisplayLabel(cell.name) ?? cell.name}</span>
			{/* The tip carries the wire key and the EXACT wire value (the JSON
			    array), not a joined rendering: element boundaries must survive
			    on a debugging surface, and a comma inside one name would make a
			    join ambiguous. The empty list keeps the tip too - the wire key
			    must stay reachable on every rendering. The visible value is the
			    bare count: the label beside it already says "parameters", and
			    "Supported parameters 27 parameters" said it twice. */}
			<HoverTip tip={`${cell.name} ${cell.valueText}`}>
				<span>{String(list.length)}</span>
			</HoverTip>
			<span className="chip-prov">
				<ChipTokens text={capProvenance(cell)} />
			</span>
		</span>
	);
}

/**
 * The capability cells of one resolved-model row, grouped for scanning: the
 * flag and token fields first (friendly labels where the vocabulary knows
 * them), then the eight cost fields collapsed into one $/M pricing line, then
 * the supported-params list as its count. Purely presentational regrouping:
 * every resolved field stays visible with its provenance - the pricing line
 * LEADS with the DOMINANT source's chip ("default: X, except where noted")
 * and badges only the parts that differ from it (one chip when uniform,
 * never eight chips saying the same thing), and its focusable tip keeps the
 * wire keys, exact per-token values, and per-field sources the $/M rendering
 * summarizes.
 */
/**
 * The pricing line's field label, naming the unit with the configured symbol
 * ("Pricing ($/M)"); the empty symbol drops the currency claim and keeps the
 * per-million unit.
 */
function pricingFieldLabel(currencySymbol: string): string {
	const symbol = currencySymbol.trim();
	return symbol.length === 0 ? l10n.t("Pricing (per M tokens)") : l10n.t("Pricing ({0}/M)", symbol);
}

function CapabilityCells({ cells, currencySymbol }: { cells: readonly ResolvedCapCell[]; currencySymbol: string }) {
	const pricing = COST_CAPABILITY_FIELDS.flatMap((name) => {
		const cell = cells.find((candidate) => candidate.name === name);
		if (cell === undefined) {
			return [];
		}
		// valueText is the JSON rendering of the resolved value, and a consumed
		// cost field is kind-validated to a finite number, so this parse is
		// exact; anything else keeps the generic rendering below.
		const perToken = Number(cell.valueText);
		return Number.isFinite(perToken) ? [{ cell, perToken }] : [];
	});
	const pricingNames = new Set(pricing.map((entry) => entry.cell.name));
	const params = cells.find((cell) => cell.name === "supported_openai_params");
	const rest = cells.filter((cell) => !pricingNames.has(cell.name) && cell !== params);
	// The most frequent provenance phrase wins the line's closing chip (first
	// seen wins ties); parts from any other source carry their own chip.
	const provenanceCounts = new Map<string, number>();
	for (const entry of pricing) {
		const provenance = capProvenance(entry.cell);
		provenanceCounts.set(provenance, (provenanceCounts.get(provenance) ?? 0) + 1);
	}
	let dominant = "";
	let dominantCount = -1;
	for (const [provenance, count] of provenanceCounts) {
		if (count > dominantCount) {
			dominant = provenance;
			dominantCount = count;
		}
	}
	return (
		<div className="resolved-cells">
			{rest.map((cell) => (
				<CapabilityCell key={cell.name} cell={cell} />
			))}
			{pricing.length > 0 ? (
				<span className="resolved-cell">
					{/* The tip pairs every wire key with its exact per-token value
					    and its source, so the dominant-chip scheme never asks the
					    reader to infer a source it cannot see. */}
					<HoverTip
						tip={pricing
							.map((entry) => `${entry.cell.name} ${entry.cell.valueText} (${capProvenance(entry.cell)})`)
							.join(", ")}
					>
						<span className="resolved-field">{pricingFieldLabel(currencySymbol)}</span>
					</HoverTip>
					{/* The dominant source's chip leads the line ("default: X,
					    except where noted"), so an unbadged part obviously reads
					    as the leading chip's source. */}
					<span className="chip-prov">
						<ChipTokens text={dominant} />
					</span>
					{pricing.map((entry) => {
						const provenance = capProvenance(entry.cell);
						return (
							<span key={entry.cell.name} className="resolved-price-part">
								{capabilityDisplayLabel(entry.cell.name)}{" "}
								<code>{formatCostPerMillion(entry.perToken, currencySymbol)}</code>
								{provenance === dominant ? null : (
									<span className="chip-prov">
										<ChipTokens text={provenance} />
									</span>
								)}
							</span>
						);
					})}
				</span>
			) : null}
			{params !== undefined ? <ParamsListCell cell={params} /> : null}
		</div>
	);
}

function matchesResolvedFilter(row: ResolvedModelRow, needle: string): boolean {
	return (
		row.rawId.toLowerCase().includes(needle) ||
		row.serverLabel.toLowerCase().includes(needle) ||
		row.matchedKeys.some((key) => key.toLowerCase().includes(needle))
	);
}

/**
 * The Resolution view: the inheritance trees and the flat provenance table,
 * both reading the extension's shared resolution (readResolvedModels). This is
 * the clearest explanation of the record model anywhere in the product, which
 * is why it is a destination section rather than an appendix.
 */
function ResolvedModels({
	active,
	stateSeq,
	currencySymbol,
	onInspect,
}: {
	active: boolean;
	stateSeq: number;
	/** The configured cost prefix (usage.currencySymbol); the pricing line renders through it. */
	currencySymbol: string;
	/** Opens the merged model inspector anchored on the named section. */
	onInspect: (target: { scopeKey: string; rawId: string; serverLabel: string }, section: InspectorSection) => void;
}) {
	const resolved = useRpc("readResolvedModels");
	const [filter, setFilter] = useState("");
	// Request on first show and again on every push while visible: the view
	// must follow settings edits; hidden tabs stay quiet.
	const { send } = resolved;
	// biome-ignore lint/correctness/useExhaustiveDependencies: stateSeq is the deliberate re-request key (see above), not a read
	useEffect(() => {
		if (!active) {
			return;
		}
		send(null);
	}, [active, stateSeq, send]);

	const view = resolved.data?.view;
	const needle = filter.trim().toLowerCase();
	const rows =
		view === undefined
			? []
			: needle.length === 0
				? view.rows
				: view.rows.filter((row) => matchesResolvedFilter(row, needle));
	return (
		<Section
			id="resolution"
			title={l10n.t("Resolution")}
			help={helpResolutionSection()}
			docs={{ href: DOCS_LINK_RESOLVED_MODELS, label: l10n.t("Open the resolved-models guide") }}
			// The count belongs to the title, not to a line of its own beside the
			// filter input, where it read as part of the control. And only while
			// the filter is narrowing: "showing 3 of 3" at rest is a tautology,
			// where the configuration header's "8 of 9" does real work.
			meta={
				view === undefined || view.rows.length === 0 || rows.length === view.rows.length
					? undefined
					: l10n.t("showing {0} of {1}", rows.length, view.rows.length)
			}
			headerClassName="max-w-[64rem]"
		>
			{/* No standing paragraph: the tree and the table ARE the explanation,
			    and a reader who wants the concept rather than their own data has
			    the header's help tip. A paragraph here was read once and then
			    scrolled past forever. */}
			{view === undefined ? (
				<p className="hint" role="status">
					{l10n.t("Resolving...")}
				</p>
			) : (
				<>
					{view.recordCount === 0 ? (
						// The table below shows every value's source per field, so
						// naming the sources here would restate what it proves.
						<p className="hint">{l10n.t("No matcher records configured.")}</p>
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: trees are positional; the view rebuilds wholesale on every response
						view.trees.map((tree, index) => <RecordTree key={index} tree={tree} />)
					)}
					{view.rows.length === 0 ? (
						// The same quiet register as the section's other empty
						// sentences; an italic here implied a hierarchy between two
						// empty states that does not exist.
						<p className="hint">{l10n.t("No models discovered yet; the table fills once a server syncs.")}</p>
					) : (
						<>
							<div className="filterbar resolved-filter">
								{/* The placeholder is short enough to survive the input's 260px
								    floor whole: the longer wording clipped at the input's edge,
								    cutting the text off exactly where the example started. */}
								<Input
									type="text"
									placeholder={l10n.t("Model ID or matcher key, e.g. gpt-5*")}
									aria-label={l10n.t("Filter resolved models")}
									value={filter}
									onChange={(event) => setFilter(event.currentTarget.value)}
								/>
							</div>
							{/* resolved-scroll: the stylesheet caps this table at the page's
							    measure; the rule carries the reasoning. */}
							<div className="table-scroll resolved-scroll">
								<table className="resolved-models">
									<thead>
										<tr>
											<th>{l10n.t("Model")}</th>
											<th>{l10n.t("Server")}</th>
											<th>{l10n.t("Parameters")}</th>
											<th>{l10n.t("Capabilities")}</th>
											<th>{/* actions */}</th>
										</tr>
									</thead>
									<tbody>
										{rows.length === 0 ? (
											<tr>
												{/* A filter that matches nothing used to leave the column
												    headers floating over an empty body, with the only
												    feedback being a count in the section header. */}
												<td colSpan={5} className="empty">
													{l10n.t("No model matches that filter.")}
												</td>
											</tr>
										) : null}
										{rows.map((row) => (
											<tr key={`${row.scopeKey}/${row.rawId}`}>
												<td className="resolved-id">
													{row.rawId}
													{/* The matcher keys that touched this model, as quiet
													    chips: they explain why a matcher-key filter (the
													    input above) keeps the row. */}
													{row.matchedKeys.length > 0 ? (
														<span className="resolved-matched">
															{row.matchedKeys.map((key) => (
																<code key={key} className="chip-matcher">
																	{key}
																</code>
															))}
														</span>
													) : null}
												</td>
												<td>{row.serverLabel}</td>
												<td className="resolved-col">
													{/* An inner flex div, never display:flex on the td itself:
													    a flexed td stops being a table cell and the column
													    layout collapses. */}
													<div className="resolved-cells">
														{row.parameters.length === 0 ? (
															<span className="hint">-</span>
														) : (
															row.parameters.map((cell) => (
																<span key={cell.name} className="resolved-cell">
																	<code>
																		{/* Same token discipline as the capability cell:
																		    break between key and value, never inside one. */}
																		<span className="whitespace-nowrap">{cell.name}</span>{" "}
																		<span className="whitespace-nowrap">{cell.valueText}</span>
																	</code>
																	<span className="chip-prov">
																		<ChipTokens text={paramProvenance(cell)} />
																	</span>
																</span>
															))
														)}
													</div>
												</td>
												<td className="resolved-col">
													<CapabilityCells cells={row.capabilities} currencySymbol={currencySymbol} />
												</td>
												<td className="actions">
													<Button
														variant="secondary"
														size="compact"
														className="params-action"
														aria-label={l10n.t("Inspect {0} on {1}", row.rawId, row.serverLabel)}
														onClick={() =>
															onInspect(
																{ scopeKey: row.scopeKey, rawId: row.rawId, serverLabel: row.serverLabel },
																"params"
															)
														}
													>
														{l10n.t("Inspect")}
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</>
					)}
				</>
			)}
		</Section>
	);
}

/**
 * A row's English error mirror substituted for the localized one: the copied
 * block is destined for public issue reports, which stay English by policy,
 * while the server rows keep the localized error the chat UI showed.
 */
function withEnglishError(server: DashboardServer): DashboardServer {
	if (server.state !== "unchecked" && server.errorEnglish !== undefined) {
		return { ...server, error: server.errorEnglish };
	}
	return server;
}

/**
 * The whole report as plain text, for the Copy diagnostics action: the
 * connection verdict, the facts, one outcome line per server, then the
 * configuration diagnostics this destination shows - composed from pushed
 * state only (which carries no secret values by construction; see the storage
 * invariants). Per-server lines go through serverOutcomeText, the shared
 * renderer, so the copied wording cannot drift from the classification the
 * server rows render.
 *
 * The configuration block was missing for as long as this action existed:
 * the page's subject is configuration, and the copy carried only connections,
 * so someone filing an issue about an inert matcher key pasted a report that
 * never mentioned it. It is the resolution view that stays out of issue
 * reports, not the diagnostics.
 *
 * Fully English, timestamp included: a plain ISO instant rather than a
 * locale-shaped date, and the diagnostic lines are composed from
 * classifications and structural keys rather than translated from the
 * on-screen sentences, so a Chinese UI copies the same block an English one
 * does.
 */
function diagnosticsReportText(
	servers: readonly DashboardServer[],
	modelCount: number,
	legacyServerCount: number,
	diagnostics: readonly ConfigDiagnosticView[]
): string {
	const copyServers = servers.map(withEnglishError);
	const checkedMs = latestCheckedMs(copyServers);
	const lines = [
		overallStatusText(copyServers, modelCount, legacyServerCount),
		`Servers configured: ${copyServers.length}`,
		`Last checked: ${checkedMs === undefined ? "Never" : new Date(checkedMs).toISOString()}`,
	];
	if (legacyServerCount > 0) {
		lines.push(`Legacy registry servers: ${legacyServerCount}`);
	}
	for (const server of copyServers) {
		lines.push(`${server.label} (${server.baseUrl}): ${serverOutcomeText(server)}`);
	}
	// Worst first, the order the page renders them in, so the paste reads the
	// way the reader's screen did.
	const problems = [...pageConfigDiagnostics(diagnostics)].sort(
		(a, b) => SEVERITY_ORDER[problemSeverity(a)] - SEVERITY_ORDER[problemSeverity(b)]
	);
	lines.push(`Configuration diagnostics: ${problems.length}`);
	for (const problem of problems) {
		lines.push(`  ${englishDiagnosticLine(problem)}`);
	}
	// Hidden groups are the one dropped kind with no other route into the
	// paste: they contribute no server row, so a hidden-only install would
	// otherwise report "Not configured / Configuration diagnostics: 0" and
	// assert a clean setup while the reader's screen says a group is serving
	// nothing. A count, never the labels - those are user text, and the count
	// is what makes the zero above honest.
	const hidden = diagnostics.reduce(
		(total, diagnostic) => (diagnostic.kind === "hidden-groups" ? total + diagnostic.labels.length : total),
		0
	);
	if (hidden > 0) {
		lines.push(`Hidden provider groups: ${hidden}`);
	}
	return lines.join("\n");
}

/** One reference link. The label names the destination, so it carries no gloss. */
function LinkRow({ href, icon, label }: { href: FeedbackUrl | DocsUrl; icon: ReactNode; label: string }) {
	return (
		<li>
			{/* Both glyphs stay decorative; the visible text is the accessible name. */}
			<a className="docs-link" href={href}>
				{icon}
				{label}
				<IconLinkExternal />
			</a>
		</li>
	);
}

/**
 * The ways out: the tools that collect evidence about this installation, then
 * the places to take it. Copy diagnostics is the only surviving reader of the
 * connection facts this page used to draw as a grid.
 */
function Support({
	servers,
	modelCount,
	legacyServerCount,
	diagnostics,
}: {
	servers: readonly DashboardServer[];
	modelCount: number;
	legacyServerCount: number;
	/** Copied alongside the connection facts; the page's subject rides its own report. */
	diagnostics: readonly ConfigDiagnosticView[];
}) {
	// A nonce, not a boolean: clicking Copy again while the check mark is
	// showing must restart the flash. Setting `copied` to true when it is
	// already true is a no-op, so the effect would not re-run and the second
	// click's confirmation could vanish mid-gesture.
	const [copiedAt, setCopiedAt] = useState(0);
	useEffect(() => {
		if (copiedAt === 0) {
			return;
		}
		// The check mark is the only feedback a fire-and-forget clipboard write
		// gets. The timer is cleaned up on unmount, so a flash interrupted by a
		// navigation cannot set state on a component that is gone.
		const timer = setTimeout(() => setCopiedAt(0), 1500);
		return () => clearTimeout(timer);
	}, [copiedAt]);
	const copyDiagnostics = () => {
		navigator.clipboard
			?.writeText(diagnosticsReportText(servers, modelCount, legacyServerCount, diagnostics))
			.catch(() => {});
		setCopiedAt((current) => current + 1);
	};
	const copied = copiedAt > 0;
	return (
		<Section
			id="support"
			title={l10n.t("Support")}
			help={helpSupportSection()}
			docs={{ href: DOCS_LINK_GETTING_STARTED, label: l10n.t("Open the getting-started guide") }}
			headerClassName="max-w-[64rem]"
		>
			<div className="toolbar">
				<Button
					variant="secondary"
					// Registry-only installs get no offer to test: the legacy registry's
					// serving path retires with this release train, so with no server
					// rows there is nothing a connection test could durably reach.
					disabled={servers.length === 0}
					onClick={() => sendRequest("executeCommand", { command: "testConnection" })}
				>
					<IconPlug /> {l10n.t("Test connection")}
				</Button>
				<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openOutput" })}>
					<IconOutput /> {l10n.t("Open output log")}
				</Button>
				<Button variant="secondary" onClick={copyDiagnostics}>
					{copied ? <IconCheck /> : <IconCopy />} {l10n.t("Copy diagnostics")}
				</Button>
				<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "reportIssue" })}>
					<IconBug /> {l10n.t("Report a bug")}
				</Button>
			</div>
			{/* No standing paragraph: the buttons name what they do, and what
			    Copy diagnostics collects is a question for the help tip rather
			    than a line under every visit. */}
			<ul className="feedback-links">
				<LinkRow href={DOCS_LINK_GETTING_STARTED} icon={<IconBook />} label={l10n.t("Documentation")} />
				<LinkRow href={FEEDBACK_LINK_REPOSITORY} icon={<IconRepo />} label={l10n.t("GitHub repository")} />
				<LinkRow href={FEEDBACK_LINK_FEATURE_REQUEST} icon={<IconLightbulb />} label={l10n.t("Request a feature")} />
				<LinkRow href={FEEDBACK_LINK_RATE} icon={<IconStar />} label={l10n.t("Rate this extension")} />
			</ul>
		</Section>
	);
}

export function DiagnosticsSection({
	servers,
	modelCount,
	legacyServerCount,
	diagnostics,
	active,
	stateSeq,
	currencySymbol,
	onInspect,
}: {
	servers: readonly DashboardServer[];
	modelCount: number;
	legacyServerCount: number;
	diagnostics: readonly ConfigDiagnosticView[];
	/** Whether the Diagnostics tab is the visible one; the resolved view requests only while shown. */
	active: boolean;
	/** Bumped on every state push; the resolved view re-requests on it while visible. */
	stateSeq: number;
	/** The configured cost prefix (usage.currencySymbol); display only, never a conversion. */
	currencySymbol: string;
	/** Open a model's inspector overlay in place; App renders the merged panel over the active tab, scrolled to the section. */
	onInspect: (target: { scopeKey: string; rawId: string; serverLabel: string }, section: InspectorSection) => void;
}) {
	// Ordered by what the reader can act on: what is wrong, then how the
	// records resolved, then the ways to get help.
	return (
		<>
			<ConfigDiagnostics diagnostics={diagnostics} />
			<ResolvedModels active={active} stateSeq={stateSeq} currencySymbol={currencySymbol} onInspect={onInspect} />
			<Support
				servers={servers}
				modelCount={modelCount}
				legacyServerCount={legacyServerCount}
				diagnostics={diagnostics}
			/>
		</>
	);
}
