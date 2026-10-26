/**
 * The server form's sections from Authentication down, the save bar, and the overlays above the form, rendered from
 * the model serverEditPage.tsx derives and composes.
 */
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import type { ReplacedEntryIdentity } from "../../dashboard/endpoints";
import type { PrefixGroup } from "../../dashboard/recordDraft";
import { toggleCanonical } from "../../dashboard/recordDraft";
import type { AuthFormId, ServerFormDraft, ServerFormField } from "../../dashboard/serverForm";
import { isUsableHttpUrl, serverFormFieldLabel, storedInactiveSecrets } from "../../dashboard/serverForm";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { ExpectedFailureCategory, NonChatMode, SecretFieldId, SkippedModeCounts } from "../../shared/serverEntry";
import { EXPECTED_FAILURE_CATEGORIES, NON_CHAT_MODES, secretDestination } from "../../shared/serverEntry";
import { canonicalBaseUrl, mcpEndpointOf } from "../../shared/util/baseUrl";
import { trimHttpWhitespace } from "../../shared/util/headers";
import type { DocsUrl } from "./docsLinks";
import {
	DOCS_LINK_AUTHENTICATION,
	DOCS_LINK_DECLARED_MODELS,
	DOCS_LINK_MODEL_CAPABILITIES,
	DOCS_LINK_MODEL_PARAMETERS,
} from "./docsLinks";
import { Help } from "./help";
import {
	helpDiscoverySection,
	helpEntryModelParameterPrefix,
	helpMcpEndpoint,
	helpMcpSection,
	helpOauthCompanionApiKey,
	serverFieldHelp,
} from "./helpText";
import { IconAdd } from "./icons";
import type { GroupIssueView, RecordEditorKind } from "./recordIssues";
import { capabilityIssueViews, paramIssueViews } from "./recordIssues";
import { RecordMatcherEditorOverlay, RecordMatcherTable } from "./recordMatcherTable";
import type { FormModel, FormPhase, FormProps, MatcherEditorTarget, ServerFormModel } from "./serverEditPage";
import {
	COMMIT_BAR_CLASS,
	CompanionNote,
	FieldSpan,
	FormFieldRow,
	FormSection,
	HeaderRowsEditor,
	matcherCountAside,
	SecretField,
	StoredSecretRow,
	TextField,
	unsavedText,
} from "./serverFormFields";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ConfirmDialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Radio } from "./ui/radio";
import { Textarea } from "./ui/textarea";

/** Where a saved entry lands, shown in the save bar because a page that writes a settings file should say so. */
const SERVERS_SETTING_ID = `${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`;

/** The selector's render order: rank order, none first. */
const AUTH_FORM_IDS: readonly AuthFormId[] = ["none", "apiKey", "virtualKey", "oauth"];

interface MatcherSectionProps {
	readonly form: FormModel;
	readonly kind: RecordEditorKind;
	readonly onOpenEditor: (index: number) => void;
}

/** The matcher section's words and ids, by record kind. */
interface MatcherSectionWords {
	readonly docs: { readonly href: DocsUrl; readonly label: string };
	readonly empty: string;
	readonly addId: string;
	readonly addLabel: string;
}

interface DiscoverySectionProps {
	readonly form: FormModel;
	readonly offeredModes: readonly NonChatMode[];
	readonly skippedModeCounts: SkippedModeCounts | undefined;
}

interface CommitBarProps {
	readonly phase: FormPhase;
	readonly firstBlocking: ServerFormField | undefined;
	readonly unsavedCount: number;
	readonly onSave: () => void;
	readonly onRequestClose: () => void;
}

interface MatcherOverlayProps {
	readonly form: FormModel;
	readonly editor: MatcherEditorTarget;
	readonly onClose: () => void;
	readonly onRemoved: () => void;
}

interface CheckboxSetProps {
	readonly ariaLabel: string;
	readonly children: ReactNode;
}

interface HeadersSectionProps {
	readonly form: FormModel;
	readonly headerProblems: readonly (string | undefined)[];
}

interface FormOverlaysProps {
	readonly model: ServerFormModel;
}

/** One expected-failure category's checkbox label; endpoint paths stay English (protocol terms). */
function expectedFailureLabel(category: ExpectedFailureCategory): string {
	switch (category) {
		case "modelListing":
			return l10n.t({
				message: "Model listing (/models)",
				comment: ["Do not translate /models; it is an HTTP endpoint path."],
			});
		case "modelInfo":
			return l10n.t({
				message: "Model info (/model/info)",
				comment: ["Do not translate /model/info; it is an HTTP endpoint path."],
			});
	}
}

/**
 * One included-mode checkbox label: the mode token (a protocol term, untranslated) plus what the last listing dropped.
 */
function includeModeLabel(mode: NonChatMode, skipped: number | undefined): string {
	return skipped !== undefined && skipped > 0 ? l10n.t("{0} ({1} skipped)", mode, skipped) : mode;
}

/**
 * The entry's own base URL is right there in the draft, so the hint names the exact address rather than describing the
 * rule and leaving the reader to apply it. A base URL that is empty or not yet a usable URL has no derivable answer, so
 * that case falls back to naming the shape instead of interpolating half a URL.
 */
function derivedMcpHint(baseUrl: string): string {
	const trimmed = trimHttpWhitespace(baseUrl);
	// mcpEndpointOf over the spelling Save stores is the publisher's own derivation, so the address named here is the
	// address that gets published - not a second rendering of the rule.
	const canonical = canonicalBaseUrl(trimmed);
	return isUsableHttpUrl(trimmed) && canonical !== undefined
		? l10n.t("Leave empty to use {0}", mcpEndpointOf(canonical))
		: l10n.t("Leave empty to use this server's own /mcp.");
}

/**
 * The Authentication selector's option labels; OAuth stays English (protocol term). Deliberately distinct from the
 * field labels: two identical label texts would leave label-based lookup - screen readers' and the test harness's -
 * ambiguous.
 */
function authFormName(form: AuthFormId): string {
	switch (form) {
		case "none":
			return l10n.t("None");
		case "apiKey":
			return l10n.t("API key (bearer)");
		case "virtualKey":
			return l10n.t("Virtual key in a custom header");
		case "oauth":
			return "OAuth";
	}
}

/**
 * The stale-key dialog's detail line.
 *
 *   the keys share the base URL -> destinations deduplicated
 *   no token URL                -> nothing to name; the sentence without a destination
 *   resolved per render         -> l10n stays call-time
 */
function staleKeyDetail(fields: readonly SecretFieldId[], original: ReplacedEntryIdentity | undefined): string {
	const describe = (field: SecretFieldId): string => {
		if (original === undefined) {
			return "";
		}
		const destination = secretDestination(original, field);
		if (typeof destination === "string") {
			return destination;
		}
		if (destination.tokenUrl === undefined) {
			return "";
		}
		return destination.clientId === undefined
			? destination.tokenUrl
			: l10n.t("{0} (client {1})", destination.tokenUrl, destination.clientId);
	};
	const destinations = [...new Set(fields.map(describe).filter((d) => d !== ""))];
	return destinations.length > 0
		? l10n.t(
				"The stored key was saved for {0}. Clearing the key removes it from secret storage.",
				destinations.join(", ")
			)
		: l10n.t("The stored key was saved for a different destination. Clearing the key removes it from secret storage.");
}

/** The draft's matcher groups of one record kind. */
function groupsOf(draft: ServerFormDraft, kind: RecordEditorKind): readonly PrefixGroup[] {
	return kind === "params" ? draft.modelParameters : draft.modelCapabilities;
}

/** The draft patch that replaces one record kind's matcher groups. */
function groupsPatch(kind: RecordEditorKind, groups: readonly PrefixGroup[]): Partial<ServerFormDraft> {
	return kind === "params" ? { modelParameters: groups } : { modelCapabilities: groups };
}

/**
 * Closing the overlay removes a still-pristine new matcher (no prefix, no rows): the patch that drops it, or nothing.
 * The caller writes it through setDraft, NOT props.patch - a structural add-then-cancel is a no-op and must not arm
 * the shell's discard confirm.
 */
function pristineMatcherRemoval(
	draft: ServerFormDraft,
	editor: MatcherEditorTarget
): Partial<ServerFormDraft> | undefined {
	const list = groupsOf(draft, editor.kind);
	const group = list[editor.index];
	if (group === undefined || trimHttpWhitespace(group.prefix).length > 0 || group.params.length > 0) {
		return undefined;
	}
	return groupsPatch(
		editor.kind,
		list.filter((_, index) => index !== editor.index)
	);
}

/** The matcher table's per-row issue views of one record kind, from the current parse. */
function matcherIssueViews(form: FormModel, kind: RecordEditorKind): readonly GroupIssueView[] {
	const { draft, parse } = form;
	if (kind === "params") {
		return paramIssueViews(
			draft.modelParameters,
			parse.ok ? [] : parse.modelParameterProblems,
			parse.modelParameterHints
		);
	}
	return capabilityIssueViews(draft.modelCapabilities, parse.modelCapabilityIssues);
}

function matcherSectionWords(kind: RecordEditorKind): MatcherSectionWords {
	if (kind === "params") {
		return {
			docs: { href: DOCS_LINK_MODEL_PARAMETERS, label: l10n.t("Open the model parameters guide") },
			empty: l10n.t("No per-server parameters."),
			addId: "server-params-add",
			addLabel: l10n.t("Add model matcher"),
		};
	}
	return {
		docs: { href: DOCS_LINK_MODEL_CAPABILITIES, label: l10n.t("Open the model capabilities guide") },
		empty: l10n.t("No corrections."),
		addId: "server-caps-add",
		addLabel: l10n.t("Add capability matcher"),
	};
}

/**
 * The Authentication selector, one option per line: the four labels are very unequal, so a wrapping row lands
 * differently at every pane width, and mutually exclusive options are read by scanning down. The cost is one row's
 * height, paid once.
 */
function AuthMethodRow({ form }: FormProps) {
	const { draft, props, saving } = form;
	return (
		<FormFieldRow label={l10n.t("Method")} wide={true}>
			<span
				className="auth-selector flex flex-col items-start gap-y-1 text-[12.5px]"
				role="radiogroup"
				aria-label={serverFormFieldLabel("authForm")}
			>
				{AUTH_FORM_IDS.map((auth) => (
					<label key={auth} className="flex items-center gap-1.5">
						<Radio
							name="server-auth-form"
							checked={draft.authForm === auth}
							disabled={saving}
							onChange={() => props.patch({ authForm: auth })}
						/>
						{authFormName(auth)}
					</label>
				))}
			</span>
		</FormFieldRow>
	);
}

/** The fields of the selected authentication method; the virtual-key pair rides along with every keyed method. */
function AuthFields({ form }: FormProps) {
	const { draft, props } = form;
	const virtualKeyPair = (
		<>
			<TextField field="virtualKeyHeader" placeholder={l10n.t("e.g. x-litellm-api-key")} props={props} />
			<SecretField field="virtualKeyValue" props={props} />
		</>
	);
	return (
		<>
			{draft.authForm === "apiKey" ? (
				<>
					<SecretField field="apiKey" props={props} />
					<CompanionNote />
					{virtualKeyPair}
				</>
			) : null}
			{draft.authForm === "virtualKey" ? virtualKeyPair : null}
			{draft.authForm === "oauth" ? (
				<>
					<TextField
						field="oauthTokenUrl"
						mono={true}
						placeholder={l10n.t("e.g. https://idp.example.com/oauth2/token")}
						props={props}
					/>
					<TextField field="oauthClientId" mono={true} placeholder={l10n.t("e.g. litellm-vscode")} props={props} />
					<SecretField field="oauthClientSecret" props={props} />
					<TextField
						field="oauthScopes"
						mono={true}
						placeholder={l10n.t("e.g. litellm.read litellm.write")}
						props={props}
					/>
					<CompanionNote />
					<SecretField field="apiKey" help={helpOauthCompanionApiKey()} props={props} />
					{virtualKeyPair}
				</>
			) : null}
		</>
	);
}

/**
 * Kept stored secrets whose form is not selected still change the save's shape (the shape-and-storage rule,
 * docs/servers.md#secrets-and-secret-storage), so each renders a visible hint plus its Remove checkbox instead of
 * silently riding along. The parse's blocking rules read the same derivation, so the way out of a block always
 * renders.
 *
 * The tone-text register (state-warn), not utility spellings: one register keeps heading and lines in one voice and
 * carries the forced-colors squiggle the utilities lack.
 */
function StoredOrphans({ form }: FormProps) {
	const orphans = storedInactiveSecrets(form.draft);
	if (!(orphans.apiKey || orphans.virtualKeyValue || orphans.oauthClientSecret)) {
		return null;
	}
	return (
		<>
			<FieldSpan className="mt-2">
				<p className="state-warn m-0 text-[11.5px]">{l10n.t("Stored credentials")}</p>
				{orphans.apiKey ? (
					<p className="hint state-warn m-0 text-[11.5px]">
						{l10n.t("A stored API key is still attached and still sent as a bearer token.")}
					</p>
				) : null}
				{orphans.virtualKeyValue ? (
					<p className="hint state-warn m-0 text-[11.5px]">{l10n.t("A stored virtual key value is still attached.")}</p>
				) : null}
				{orphans.oauthClientSecret ? (
					<p className="hint state-warn m-0 text-[11.5px]">
						{l10n.t("A stored OAuth client secret is still attached.")}
					</p>
				) : null}
			</FieldSpan>
			{orphans.apiKey ? <StoredSecretRow field="apiKey" props={form.props} /> : null}
			{orphans.virtualKeyValue ? <StoredSecretRow field="virtualKeyValue" props={form.props} /> : null}
			{orphans.oauthClientSecret ? <StoredSecretRow field="oauthClientSecret" props={form.props} /> : null}
		</>
	);
}

export function AuthenticationSection({ form }: FormProps) {
	return (
		<FormSection
			title={serverFormFieldLabel("authForm")}
			help={serverFieldHelp("authForm")}
			docs={{ href: DOCS_LINK_AUTHENTICATION, label: l10n.t("Open the authentication guide") }}
		>
			<AuthMethodRow form={form} />
			<AuthFields form={form} />
			<StoredOrphans form={form} />
		</FormSection>
	);
}

/** One record kind's matcher table; the key suggestions are the capabilities table's alone. */
function MatcherTable({ form, kind, onOpenEditor }: MatcherSectionProps) {
	const { draft, props, saving } = form;
	const issues = matcherIssueViews(form, kind);
	if (kind === "params") {
		return (
			<RecordMatcherTable
				kind="params"
				groups={draft.modelParameters}
				issues={issues}
				disabled={saving}
				onChange={(next) => props.patch({ modelParameters: next })}
				onOpenEditor={onOpenEditor}
			/>
		);
	}
	return (
		<RecordMatcherTable
			kind="caps"
			groups={draft.modelCapabilities}
			issues={issues}
			disabled={saving}
			keySuggestions={form.keySuggestions}
			onChange={(next) => props.patch({ modelCapabilities: next })}
			onOpenEditor={onOpenEditor}
		/>
	);
}

/**
 * One matcher-record section (parameters or capabilities) with its table and the add action. The add writes through
 * setDraft, not patch: appending the empty group is structural, and the removal on close undoes it without arming the
 * confirm.
 */
export function MatcherSection({ form, kind, onOpenEditor }: MatcherSectionProps) {
	const { draft, saving, setDraft } = form;
	const field = kind === "params" ? "modelParameters" : "modelCapabilities";
	const words = matcherSectionWords(kind);
	const groups = draft[field];
	const add = () => {
		setDraft((current) => ({
			...current,
			...groupsPatch(kind, [...groupsOf(current, kind), { prefix: "", params: [] }]),
		}));
		onOpenEditor(groups.length);
	};
	return (
		<FormSection
			quiet={true}
			title={serverFormFieldLabel(field)}
			aside={matcherCountAside(groups.length)}
			help={serverFieldHelp(field)}
			docs={words.docs}
		>
			<FormFieldRow label={l10n.t("Matchers")} wide={true}>
				{groups.length > 0 ? (
					<MatcherTable form={form} kind={kind} onOpenEditor={onOpenEditor} />
				) : (
					<p className="m-0 text-[12px] text-muted-foreground">{words.empty}</p>
				)}
				<div>
					<Button variant="secondary" id={words.addId} disabled={saving} onClick={add}>
						<IconAdd /> {words.addLabel}
					</Button>
				</div>
			</FormFieldRow>
		</FormSection>
	);
}

/**
 * A checkbox set as a real fieldset, not a role: the set is a group with a name, and the flat page has no box chrome
 * for it to inherit. One row while the pair fits, a column below the stylesheet's own 560px tier (same exclusive
 * `width < 560px` semantics); between, wrap depended on the translation's width.
 */
function CheckboxSet({ ariaLabel, children }: CheckboxSetProps) {
	return (
		<fieldset
			className="expected-failures m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-0 p-0 text-[12.5px] @max-[560px]/pane:flex-col @max-[560px]/pane:items-start"
			aria-label={ariaLabel}
		>
			{children}
		</fieldset>
	);
}

/** The Discovery section: the declared models, the expected failures, and the modes to include where any is offered. */
export function DiscoverySection({ form, offeredModes, skippedModeCounts }: DiscoverySectionProps) {
	const { draft, props, saving } = form;
	return (
		<FormSection
			quiet={true}
			title={l10n.t("Discovery")}
			aside={l10n.t("optional")}
			help={helpDiscoverySection()}
			docs={{ href: DOCS_LINK_DECLARED_MODELS, label: l10n.t("Open the declared models guide") }}
		>
			<FormFieldRow
				htmlFor="server-declaredModels"
				label={serverFormFieldLabel("declaredModels")}
				help={
					<Help
						text={serverFieldHelp("declaredModels")}
						name={l10n.t("Help: {0}", serverFormFieldLabel("declaredModels"))}
					/>
				}
				wide={true}
			>
				<Textarea
					id="server-declaredModels"
					className="w-full font-mono text-[12px]"
					rows={3}
					placeholder={l10n.t("One model ID per line, e.g. deepseek-r1")}
					value={draft.declaredModels}
					disabled={saving}
					onChange={(event) => props.patch({ declaredModels: event.currentTarget.value })}
				/>
			</FormFieldRow>
			<FormFieldRow
				label={serverFormFieldLabel("expectedFailures")}
				help={
					<Help
						text={serverFieldHelp("expectedFailures")}
						name={l10n.t("Help: {0}", serverFormFieldLabel("expectedFailures"))}
					/>
				}
				wide={true}
			>
				<CheckboxSet ariaLabel={serverFormFieldLabel("expectedFailures")}>
					{EXPECTED_FAILURE_CATEGORIES.map((category) => (
						<label key={category} className="setting-check flex items-center gap-1.5">
							<Checkbox
								checked={draft.expectedFailures.includes(category)}
								disabled={saving}
								onChange={(event) =>
									props.patch({
										expectedFailures: toggleCanonical(
											EXPECTED_FAILURE_CATEGORIES,
											draft.expectedFailures,
											category,
											event.currentTarget.checked
										),
									})
								}
							/>
							{expectedFailureLabel(category)}
						</label>
					))}
				</CheckboxSet>
			</FormFieldRow>
			{offeredModes.length > 0 && (
				<FormFieldRow
					label={serverFormFieldLabel("includeModes")}
					help={
						<Help
							text={serverFieldHelp("includeModes")}
							name={l10n.t("Help: {0}", serverFormFieldLabel("includeModes"))}
						/>
					}
					wide={true}
				>
					<CheckboxSet ariaLabel={serverFormFieldLabel("includeModes")}>
						{offeredModes.map((mode) => (
							<label key={mode} className="setting-check flex items-center gap-1.5">
								<Checkbox
									checked={draft.includeModes.includes(mode)}
									disabled={saving}
									onChange={(event) =>
										props.patch({
											includeModes: toggleCanonical(
												NON_CHAT_MODES,
												draft.includeModes,
												mode,
												event.currentTarget.checked
											),
										})
									}
								/>
								{includeModeLabel(mode, skippedModeCounts?.[mode])}
							</label>
						))}
					</CheckboxSet>
				</FormFieldRow>
			)}
		</FormSection>
	);
}

export function HeadersSection({ form, headerProblems }: HeadersSectionProps) {
	const { draft, props, saving } = form;
	return (
		<FormSection
			quiet={true}
			title={l10n.t("Headers and budget")}
			aside={l10n.t("optional")}
			help={serverFieldHelp("headers")}
		>
			<FormFieldRow label={serverFormFieldLabel("headers")} wide={true}>
				<HeaderRowsEditor
					rows={draft.headers}
					problems={headerProblems}
					disabled={saving}
					onChange={(next) => props.patch({ headers: next })}
				/>
			</FormFieldRow>
			<TextField field="budget" narrow={true} placeholder={l10n.t("e.g. 50")} props={props} />
		</FormSection>
	);
}

/**
 * The MCP section. The endpoint row follows the API version's idiom: it exists only while the choice it belongs to is
 * live, so an opted-out entry shows no dead input. Its hint is the DERIVED default, not an abstract restatement: the
 * form knows the base URL, so it can show the exact address an empty field publishes.
 */
export function McpSection({ form }: FormProps) {
	const { draft, props, saving } = form;
	return (
		<FormSection quiet={true} title={l10n.t("MCP")} aside={l10n.t("optional")} help={helpMcpSection()}>
			<FormFieldRow
				label={serverFormFieldLabel("mcp")}
				help={<Help text={serverFieldHelp("mcp")} name={l10n.t("Help: {0}", serverFormFieldLabel("mcp"))} />}
			>
				<label className="setting-check flex items-center gap-1.5">
					<Checkbox
						checked={draft.mcp.enabled}
						disabled={saving}
						onChange={(event) => props.patch({ mcp: { ...draft.mcp, enabled: event.currentTarget.checked } })}
					/>
					{l10n.t("Make this server's MCP tools available in chat")}
				</label>
			</FormFieldRow>
			{draft.mcp.enabled ? (
				<FormFieldRow
					htmlFor="server-mcp-url"
					label={l10n.t("MCP endpoint")}
					help={<Help text={helpMcpEndpoint()} name={l10n.t("Help: {0}", l10n.t("MCP endpoint"))} />}
					problem={props.visibleProblems.mcp}
					errorId="server-mcp-url-error"
					hint={derivedMcpHint(draft.baseUrl)}
				>
					<Input
						id="server-mcp-url"
						type="text"
						className="min-w-0 flex-1 font-mono text-[12px]"
						placeholder={l10n.t("e.g. https://gateway.internal/mcp")}
						value={draft.mcp.url}
						disabled={saving}
						aria-invalid={props.visibleProblems.mcp !== undefined}
						aria-describedby="server-mcp-url-error"
						onChange={(event) => props.patch({ mcp: { ...draft.mcp, url: event.currentTarget.value } })}
						onBlur={() => props.touch("mcp")}
					/>
				</FormFieldRow>
			) : null}
		</FormSection>
	);
}

/**
 * The save bar. "Discard changes" is named apart from the confirm dialog's own Discard: this one REQUESTS a close, and
 * two controls one answer apart must not answer to the same word.
 *
 * The bar's trailing facts sit on ONE wrap-proof line (dashboard.css .commit-status, the record footer's
 * .editor-status discipline): zero flex basis, so the count speaking never changes the bar's wrap points or its
 * height; the DOM keeps the whole text, so screen readers read it unclipped.
 *
 * NBSP glue around the dash: the two facts are flex items, so a collapsible space at the target's start sits at its
 * own line box's start and is trimmed.
 */
export function CommitBar({ phase, firstBlocking, unsavedCount, onSave, onRequestClose }: CommitBarProps) {
	const savedTo = l10n.t("Saved to {0}", SERVERS_SETTING_ID);
	return (
		<div className={COMMIT_BAR_CLASS}>
			<Button disabled={phase.phase !== "editing"} onClick={onSave}>
				{phase.phase === "saving" ? (
					<>
						<span className="spinner" aria-hidden="true" /> {l10n.t("Saving...")}
					</>
				) : (
					l10n.t("Save")
				)}
			</Button>
			<Button variant="secondary" onClick={onRequestClose}>
				{l10n.t("Discard changes")}
			</Button>
			{firstBlocking === undefined ? null : (
				<span className="error text-[11.5px]" role="alert">
					{l10n.t("Cannot save: fix {0}", serverFormFieldLabel(firstBlocking))}
				</span>
			)}
			{phase.phase === "prefill" ? (
				<span className="hint m-0 text-[11.5px]">{l10n.t("Loading stored values...")}</span>
			) : null}
			<span
				className="commit-status text-right text-[11.5px] text-muted-foreground"
				title={unsavedCount > 0 ? `${unsavedText(unsavedCount)} - ${savedTo}` : savedTo}
			>
				{unsavedCount > 0 ? <span className="unsaved-count tabular-nums">{unsavedText(unsavedCount)}</span> : null}
				<span className="save-target">{unsavedCount > 0 ? `\u00a0-\u00a0${savedTo}` : savedTo}</span>
			</span>
		</div>
	);
}

/** The full matcher editor over one draft group; its edits write through props.patch, so they dirty the form. */
function MatcherOverlay({ form, editor, onClose, onRemoved }: MatcherOverlayProps) {
	const { draft, parse, props, saving } = form;
	const note = l10n.t("Changes here edit the form; Save stores them on the entry.");
	const list = groupsOf(draft, editor.kind);
	const group = list[editor.index];
	if (group === undefined) {
		return null;
	}
	const onChange = (next: PrefixGroup) =>
		props.patch(
			groupsPatch(
				editor.kind,
				list.map((g, index) => (index === editor.index ? next : g))
			)
		);
	const onRemove = () => {
		props.patch(
			groupsPatch(
				editor.kind,
				list.filter((_, index) => index !== editor.index)
			)
		);
		onRemoved();
	};
	if (editor.kind === "params") {
		return (
			<RecordMatcherEditorOverlay
				kind="params"
				group={group}
				groupProblems={parse.ok ? undefined : parse.modelParameterProblems[editor.index]}
				groupHints={parse.modelParameterHints[editor.index]}
				prefixHelp={helpEntryModelParameterPrefix()}
				disabled={saving}
				fallbackFocusId="server-params-add"
				note={note}
				onChange={onChange}
				onRemove={onRemove}
				onClose={onClose}
			/>
		);
	}
	return (
		<RecordMatcherEditorOverlay
			kind="caps"
			group={group}
			groupIssues={parse.modelCapabilityIssues[editor.index]}
			keySuggestions={form.keySuggestions}
			disabled={saving}
			fallbackFocusId="server-caps-add"
			note={note}
			onChange={onChange}
			onRemove={onRemove}
			onClose={onClose}
		/>
	);
}

/**
 * The surfaces over the form: the full matcher editor, and the stale-key question a Save raised - modal like the
 * discard confirm, since a credential decision interrupts the save and has no in-place anywhere. Esc/"Keep editing"
 * posts nothing; the two verbs answer the ONE question.
 */
export function FormOverlays({ model }: FormOverlaysProps) {
	const { form, matcherEditor, setMatcherEditor, staleKey, commit, original } = model;
	const closeMatcherEditor = (editor: MatcherEditorTarget) => {
		const removal = pristineMatcherRemoval(form.draft, editor);
		if (removal !== undefined) {
			form.setDraft((current) => ({ ...current, ...removal }));
		}
		setMatcherEditor(undefined);
	};
	return (
		<>
			{matcherEditor === undefined ? null : (
				<MatcherOverlay
					form={form}
					editor={matcherEditor}
					onClose={() => closeMatcherEditor(matcherEditor)}
					onRemoved={() => setMatcherEditor(undefined)}
				/>
			)}
			{staleKey.fields === undefined ? null : (
				<ConfirmDialog
					question={l10n.t("Keep using the stored key for the new destination?")}
					detail={staleKeyDetail(staleKey.fields, original)}
					confirmLabel={l10n.t("Clear key")}
					alternateLabel={l10n.t("Use same key")}
					cancelLabel={l10n.t("Keep editing")}
					surfaceId="server-edit-page"
					onConfirm={commit.answerStaleKeyClear}
					onAlternate={commit.answerStaleKeyKeep}
					onCancel={staleKey.dismiss}
				/>
			)}
		</>
	);
}
