/**
 * The Diagnostics destination: configuration problems, the resolution the records
 * produce, and the support tools - everything with no server row of its own (per-server
 * facts render on the Servers destination, where the fix lives). The connection facts
 * survive only in Copy diagnostics, composed from pushed state (no secret values by
 * construction) and English by policy - destined for public issue reports. The
 * Resolved-models view is request/response-fed (readResolvedModels), re-requested per
 * push while visible, and local to the dashboard by design - never in issue reports.
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
import { helpConfigDiagnosticsSection, helpDiagnosticsTools, helpResolutionSection } from "./helpText";
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
import { ProblemBand } from "./problemBand";
import {
	capabilityProvenancePhrase,
	fallbackWord,
	forceWord,
	inheritableWord,
	parameterProvenancePhrase,
} from "./provenance";
import { type DiagnosticSeverity, SEVERITY_ORDER } from "./severity";
import { AbsentDatum } from "./ui/absent";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Section } from "./ui/section";
import { sendRequest } from "./vscodeApi";

/**
 * This page's reading of ./severity.ts, against configuration rather than connections:
 * "blocking" - wholly inert until someone changes it; "degraded" - part ignored, the
 * rest applies; "advisory" - applies exactly as written, we are only naming a possible
 * typo, and these must stay quiet or they train the reader to ignore the loud ones.
 * Nothing here can be worse than blocking: a server serving nothing is a row problem.
 */

/**
 * The host's severity as a ceiling: capability validation is advisory BY CONTRACT, so
 * an advisory stamp must be able to quiet any kind, never the reverse. Applied to every
 * variant - a diagnostic the rail badge leaves untinted must not render actionable.
 */
function cappedSeverity(hostSeverity: ConfigDiagnosticSeverity, tier: DiagnosticSeverity): DiagnosticSeverity {
	return hostSeverity === "advisory" ? "advisory" : tier;
}

/**
 * One action offered beside a problem: every one REVEALS the place a human fixes it,
 * none rewrites configuration - a button that silently edited the settings file would
 * be a worse bug than the one it fixed.
 */
type DiagnosticAction =
	/**
	 * `subject` distinguishes repeats: several problems can reveal the same setting, so the
	 * id alone would give three buttons one accessible name. The visible label stays inside
	 * the accessible name (Label in Name).
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
	 * Leads with the consequence, keeps the cause: a reader who stops after the first
	 * clause should still know what is not being applied.
	 */
	readonly headline: string;
	/** Where it lives, as machine text: setting ids and entry labels, never prose. */
	readonly where: readonly string[];
	/** The parser's structural report, when there is one. English by policy - it also rides the copyable block. */
	readonly detail?: string | undefined;
	readonly actions: readonly DiagnosticAction[];
}

/**
 * Whether one diagnostic belongs on this page, as an exhaustive classification, never a
 * filter predicate. Dropped kinds are the ones a Servers row reports beside the control
 * that fixes them: a rejected entry THAT WAS DRAWN A ROW, and hidden groups. `rowOwned`
 * is the host's own answer - a reject with no drawable identity gets NO row, and this
 * list is then the only place its problems appear. A switch with no default and an
 * annotated return type, deliberately: a boolean predicate let a new diagnostic kind
 * reach the page unclassified. `noImplicitReturns` turns the unhandled case into
 * TS7030; the downstream PageConfigDiagnostic switches give TS2366 as a second net.
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
 * The diagnostics this page renders (see pageDiagnostic for what is dropped). Exported
 * because the rail's badge counts what this page shows: two definitions of "how many
 * problems" would drift, and a badge reading 8 above a list of 6 is the same bug.
 */
export function pageConfigDiagnostics(diagnostics: readonly ConfigDiagnosticView[]): readonly PageConfigDiagnostic[] {
	return diagnostics.flatMap((diagnostic) => {
		const kept = pageDiagnostic(diagnostic);
		return kept === undefined ? [] : [kept];
	});
}

/**
 * A record lint's tier. `unrecognized-key` is named explicitly rather than left to the
 * host's advisory stamp: encoding the advisory-by-invariant contract here makes it
 * local instead of a property this file happens to inherit.
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
 * One diagnostic's tier, split out of configProblem because the copied report needs the
 * ranking without the localized sentence: the block is English by policy.
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
 * One diagnostic as a line for the copied report. English by construction, not
 * translation: every part is a classification or a structural key the user typed, so
 * the block stays English under a Chinese UI and carries no server-derived text.
 */
/**
 * A record key or field name as the COPIED report may carry it. A key containing
 * "://" is the removed server-scoped grammar (migrations/settingsRedesign/records.ts,
 * isUrlScopedKey), so the key IS a base URL and may carry credentials in its userinfo -
 * this block lands in public GitHub issues, so it redacts. The substring test is
 * repeated, not imported: the webview tree cannot reach src/extension.
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
			// The classification and the setting it sits in, nothing else: `oldKey` on a URL-scoped
			// hint IS a base URL, and `detail` on a parked-headers hint is the user's own header
			// names (hints.ts: local-dashboard-only). Every branch yields a setting id, never user
			// text.
			return `${tier} ${diagnostic.hint} (${
				diagnostic.hint === "inert-url-scoped-key" ? diagnostic.detail : diagnostic.oldKey
			})`;
		case "thresholds":
			return `${tier} usage.alertThresholds: ${diagnostic.dropped} dropped`;
	}
}

/**
 * One record lint as a single consequence sentence; classifications and structural keys
 * only, never entered values. One sentence is the whole budget: the tier already says
 * "the rest still applies", and the matcher grammar is the guide's reference material.
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
 * The legacy record-key hint names the setting its leftover sits in; only the two
 * record settings can carry one, and narrowing here keeps the assumption in one place.
 */
function revealTarget(setting: string): RevealableSettingId {
	return setting === "models.capabilities" ? "models.capabilities" : "models.parameters";
}

/** The guide a problem's Learn more opens. The accessible name leads with the visible verb - Label in Name: a speech-input user activates the link by saying what the screen shows - and the trailing subject keeps the links-list entries distinct while they group under the same verb the eye groups them by. */
function docsAction(href: DocsUrl, subject: string): DiagnosticAction {
	return { kind: "docs", label: l10n.t("Learn more"), href, ariaLabel: l10n.t("Learn more: {0}", subject) };
}

/**
 * One configuration diagnostic, ranked and worded for this page. `where` strings are
 * machine text, so they render as neutral badges rather than trailing parentheses. Keys
 * come from the diagnostic's own identity, never list position: a new earlier problem
 * would slide every key down one and move the user's focus. The reveal's `subject`
 * makes its accessible name unique across problems naming the same setting.
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
			// Five of the sentences stopped naming the record when cut to one clause; they get it
			// back as a location chip - without it, two records failing on the same field render
			// as identical rows.
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
				// Learn more on the one lint the sentence cannot fix by itself: N invalid keys still
				// produce N identical links - accepted here and nowhere else, because for this lint
				// the grammar IS the remedy.
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
 * One problem, through the one band pipeline: severity is one vocabulary, and a second
 * renderer spelling its own tiers is exactly the drift ProblemBand exists to prevent.
 * This page's location badges and reveal actions ride the band's slots.
 */
function ConfigProblemLine({ problem }: { problem: ConfigProblem }) {
	return (
		<ProblemBand
			as="li"
			severity={problem.severity}
			subject="configuration"
			headline={problem.headline}
			where={
				problem.where.length > 0 ? (
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
				) : undefined
			}
			details={problem.detail !== undefined ? [problem.detail] : undefined}
			actions={
				problem.actions.length > 0 ? (
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
				) : undefined
			}
		/>
	);
}

/**
 * The configuration problems, worst first. Always present as a section - sections do
 * not appear and disappear under the reader - with the clean state saying so in words.
 */
function ConfigDiagnostics({ diagnostics }: { diagnostics: readonly ConfigDiagnosticView[] }) {
	const problems = pageConfigDiagnostics(diagnostics)
		.map(configProblem)
		.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
	// Advisories are excluded from the count (the configuration applies as written). The
	// total rides along when the two numbers differ - the rail badge counts the whole
	// list, and "7" beside a list of 8 is a question the reader should not have to answer.
	const actionable = problems.filter((problem) => problem.severity !== "advisory").length;
	return (
		<Section
			id="config-diagnostics"
			title={l10n.t("Configuration")}
			// One step under the page's own header, like every section inside a
			// destination.
			level={3}
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

/** One tree node's own-fields summary: "temperature 0.3 (inheritable, force)". */
function nodeFieldText(field: RecordTreeNode["fields"][number]): string {
	// The directive words come from the one vocabulary (./provenance and the
	// record editors' chips), never re-minted here.
	const marks = [
		...(field.inheritable ? [inheritableWord()] : []),
		...(field.forced ? [forceWord()] : []),
		...(field.fallback ? [fallbackWord()] : []),
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
 * One record map as its inheritance tree. Open, with a plain heading: a <details open>
 * spent a disclosure triangle advertising a collapse nobody wants here.
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
					<li key={key} className="tree-model">
						{/* A pointer, not a verdict: the Configuration section owns the invalid-matcher fact,
						    and one fact must not be told twice. The tree still names the key - a record the
						    reader wrote silently missing from the figure reads as a rendering bug. */}
						<span className="hint">{l10n.t('"{0}" is listed under Configuration above.', key)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * A table chip's text with every space-separated token held whole: below the 920px pane
 * tier chips may wrap internally, and an unguarded wrap breaks record keys at hyphens -
 * a mid-token split on retypeable text. textContent is unchanged.
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
 * One generic capability cell: the friendly label where the vocabulary has one, the raw
 * wire key in code otherwise (for an open field the key IS the fact). A labeled cell
 * keeps its wire identity one focusable tip away - the wire key is what a reader
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
				<ChipTokens text={capabilityProvenancePhrase(cell)} />
			</span>
		</span>
	);
}

/**
 * The supported-params list as its count, the full list one focusable tip away (a
 * 27-element JSON array inline made the table unscannable). A value that is not the
 * validated string array falls back to the generic rendering rather than miscounting.
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
			{/* The tip carries the wire key and the EXACT wire value, not a joined rendering:
			    element boundaries must survive on a debugging surface, and a comma inside one name
			    would make a join ambiguous. The empty list keeps the tip - the wire key must stay
			    reachable on every rendering. */}
			<HoverTip tip={`${cell.name} ${cell.valueText}`}>
				<span>{String(list.length)}</span>
			</HoverTip>
			<span className="chip-prov">
				<ChipTokens text={capabilityProvenancePhrase(cell)} />
			</span>
		</span>
	);
}

/**
 * The pricing line's field label names the unit with the configured symbol; the empty
 * symbol drops the currency claim and keeps the per-million unit.
 */
function pricingFieldLabel(currencySymbol: string): string {
	const symbol = currencySymbol.trim();
	return symbol.length === 0 ? l10n.t("Pricing (per M tokens)") : l10n.t("Pricing ({0}/M)", symbol);
}

/**
 * The capability cells of one resolved-model row, grouped for scanning. Purely
 * presentational: every field stays visible with its provenance - the pricing line
 * LEADS with the DOMINANT source's chip and badges only the parts that differ (one
 * chip when uniform, never eight saying the same thing); its tip keeps the wire keys,
 * exact per-token values, and per-field sources.
 */
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
		const provenance = capabilityProvenancePhrase(entry.cell);
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
			{cells.length === 0 ? (
				// A row with nothing resolved says so (ui/absent.tsx); a silently
				// empty cell read as a rendering gap.
				<AbsentDatum className="hint" reason={l10n.t("no capabilities resolved")} />
			) : null}
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
							.map((entry) => `${entry.cell.name} ${entry.cell.valueText} (${capabilityProvenancePhrase(entry.cell)})`)
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
						const provenance = capabilityProvenancePhrase(entry.cell);
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
 * The Resolution view: the inheritance trees and the flat provenance table, both
 * reading the extension's shared resolution (readResolvedModels). The clearest
 * explanation of the record model in the product, hence a destination section.
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
			level={3}
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
							{/* resolved-scroll: the table's own scrollport, full-bleed to
							    the pane like every structural surface; the stylesheet's
							    narrow-pane chip-wrapping rule keys off this class. */}
							<div className="table-scroll resolved-scroll">
								<table className="resolved-models">
									<thead>
										<tr>
											<th>{l10n.t("Model")}</th>
											<th>{l10n.t("Server")}</th>
											<th>{l10n.t("Parameters")}</th>
											<th>{l10n.t("Capabilities")}</th>
											{/* Pins with the body's actions cells: an unpinned header
											    would slide a neighbouring label under the pinned
											    column while the table scrolls. */}
											<th className="actions" />
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
															<AbsentDatum className="hint" reason={l10n.t("no parameters resolved")} />
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
																		<ChipTokens text={parameterProvenancePhrase(cell)} />
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
 * A row's English error mirror substituted for the localized one: the copied block
 * stays English by policy, while the server rows keep the localized error.
 */
function withEnglishError(server: DashboardServer): DashboardServer {
	if (server.state !== "unchecked" && server.errorEnglish !== undefined) {
		return { ...server, error: server.errorEnglish };
	}
	return server;
}

/**
 * The whole report as plain text for Copy diagnostics, composed from pushed state only
 * (no secret values by construction). Per-server lines go through serverOutcomeText,
 * so the copied wording cannot drift from what the rows render. Fully English,
 * timestamp a plain ISO instant; lines composed from classifications and structural
 * keys, so a Chinese UI copies the same block an English one does. The resolution view
 * stays out of issue reports; the diagnostics do not.
 */
function diagnosticsReportText(
	servers: readonly DashboardServer[],
	modelCount: number,
	legacyServerCount: number,
	hiddenGroupCount: number,
	diagnostics: readonly ConfigDiagnosticView[]
): string {
	const copyServers = servers.map(withEnglishError);
	const checkedMs = latestCheckedMs(copyServers);
	const lines = [
		overallStatusText(copyServers, modelCount, { legacyServerCount, hiddenGroupCount }),
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
	// Hidden groups are the one dropped kind with no other route into the paste:
	// they contribute no server row, so a hidden-only install would otherwise
	// assert a clean setup. The count the shell passed (state.hiddenGroups), so
	// the headline verdict and this line cannot disagree; never the labels -
	// those are user text.
	if (hiddenGroupCount > 0) {
		lines.push(`Hidden provider groups: ${hiddenGroupCount}`);
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
 * The page's four tools lead the body as one scannable stack: evidence collectors
 * first, then the escalation. A plain <ul>, no group label - the buttons name
 * themselves and the page heading scopes them.
 */
function DiagnosticsTools({
	servers,
	modelCount,
	legacyServerCount,
	hiddenGroupCount,
	diagnostics,
}: {
	servers: readonly DashboardServer[];
	modelCount: number;
	legacyServerCount: number;
	/** How many provider groups an explicit removal hides (state.hiddenGroups); the report's verdict and count read it. */
	hiddenGroupCount: number;
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
			?.writeText(diagnosticsReportText(servers, modelCount, legacyServerCount, hiddenGroupCount, diagnostics))
			.catch(() => {});
		setCopiedAt((current) => current + 1);
	};
	const copied = copiedAt > 0;
	return (
		<ul className="diagnostics-tools">
			<li>
				{/* Primary rank for all four tools: they ARE the page's content, with nothing louder
				    to rank under - the same promotion the settings transfer section makes. */}
				<Button
					// Registry-only installs get no offer to test: the legacy registry's
					// serving path retires with this release train, so with no server
					// rows there is nothing a connection test could durably reach.
					disabled={servers.length === 0}
					onClick={() => sendRequest("executeCommand", { command: "testConnection" })}
				>
					<IconPlug /> {l10n.t("Test connection")}
				</Button>
			</li>
			<li>
				<Button onClick={() => sendRequest("executeCommand", { command: "openOutput" })}>
					<IconOutput /> {l10n.t("Open output log")}
				</Button>
			</li>
			<li>
				<Button onClick={copyDiagnostics}>
					{copied ? <IconCheck /> : <IconCopy />} {l10n.t("Copy diagnostics")}
				</Button>
			</li>
			<li>
				<Button onClick={() => sendRequest("executeCommand", { command: "reportIssue" })}>
					<IconBug /> {l10n.t("Report a bug")}
				</Button>
			</li>
		</ul>
	);
}

/**
 * The external escape hatches, one rank quieter than the tools (the link hue's quiet
 * tier at rest, `.feedback-links` - full link blue outshone the actions above). No
 * heading: four links are a shelf, and the nav's aria-label keeps the grouping.
 */
function Support() {
	return (
		<nav aria-label={l10n.t("Support")}>
			<ul className="feedback-links">
				<LinkRow href={DOCS_LINK_GETTING_STARTED} icon={<IconBook />} label={l10n.t("Documentation")} />
				<LinkRow href={FEEDBACK_LINK_REPOSITORY} icon={<IconRepo />} label={l10n.t("GitHub repository")} />
				<LinkRow href={FEEDBACK_LINK_FEATURE_REQUEST} icon={<IconLightbulb />} label={l10n.t("Request a feature")} />
				<LinkRow href={FEEDBACK_LINK_RATE} icon={<IconStar />} label={l10n.t("Rate this extension")} />
			</ul>
		</nav>
	);
}

export function DiagnosticsSection({
	servers,
	modelCount,
	legacyServerCount,
	hiddenGroupCount,
	diagnostics,
	active,
	stateSeq,
	currencySymbol,
	onInspect,
}: {
	servers: readonly DashboardServer[];
	modelCount: number;
	legacyServerCount: number;
	/** How many provider groups an explicit removal hides (state.hiddenGroups.length); Copy diagnostics reads it. */
	hiddenGroupCount: number;
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
	// One page-level header, the anatomy every destination has. The eight actions open the
	// body as one vertical list (settled user direction; the header's actions slot stays
	// empty); sections below are ordered by what the reader can act on.
	return (
		<Section
			id="diagnostics"
			title={l10n.t("Diagnostics")}
			help={helpDiagnosticsTools()}
			// The trigger sits at the very top of the document, where a tip
			// placed above it clips.
			helpBelow
		>
			<DiagnosticsTools
				servers={servers}
				modelCount={modelCount}
				legacyServerCount={legacyServerCount}
				hiddenGroupCount={hiddenGroupCount}
				diagnostics={diagnostics}
			/>
			<Support />
			<ConfigDiagnostics diagnostics={diagnostics} />
			<ResolvedModels active={active} stateSeq={stateSeq} currencySymbol={currencySymbol} onInspect={onInspect} />
		</Section>
	);
}
