import * as l10n from "@vscode/l10n";
import { Fragment, useEffect, useRef, useState } from "react";
import type { GroupProblems, HeaderRow } from "../../dashboard/recordDraft";
import { toCapabilityGroups, toGroups, toggleExpectedFailure, toHeaderRows } from "../../dashboard/recordDraft";
import type {
	ApiVersionDraft,
	AuthFormId,
	SecretFieldDraft,
	ServerFormDraft,
	ServerFormField,
	ServerFormProblems,
} from "../../dashboard/serverForm";
import {
	apiVersionDraftOf,
	applyInlinePrefill,
	CONNECTION_FIELDS,
	deriveAuthForm,
	EMPTY_SERVER_FORM,
	isUsableHttpUrl,
	parseServerForm,
	parseServerFormForTest,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	serverFormFieldLabel,
	validateAdoptLabel,
} from "../../dashboard/serverForm";
import type {
	DashboardServer,
	DashboardUsage,
	HiddenGroup,
	InactiveEntryNotice,
	UsageServerView,
} from "../../dashboard/viewModels";
import type { SetupHintKind, TransportErrorClassification } from "../../shared/errorClassification";
import type { ExpectedFailureCategory, SecretFieldId, SecretLocation } from "../../shared/serverEntry";
import { EXPECTED_FAILURE_CATEGORIES, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { DEFAULT_API_VERSION } from "../../shared/util/baseUrl";
import { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";
import type { DocsUrl } from "./docsLinks";
import {
	DOCS_LINK_AUTHENTICATION,
	DOCS_LINK_CHECK_BASE_URL,
	DOCS_LINK_CONFIGURE_API_KEY,
	DOCS_LINK_DECLARED_MODELS,
	DOCS_LINK_MODEL_CAPABILITIES,
	DOCS_LINK_PARAMS_INACTIVE,
	DOCS_LINK_PROXY_NOT_RUNNING,
	DOCS_LINK_SERVER_FORM,
	DOCS_LINK_SERVERS,
} from "./docsLinks";
import { FailureText } from "./failureText";
import { DocsLink, Help, HoverTip } from "./help";
import {
	helpEntryModelParameterPrefix,
	helpOauthCompanionApiKey,
	helpSecretStorage,
	helpServersSection,
	serverFieldHelp,
} from "./helpText";
import { useIntentOutcome, useRpc } from "./hooks";
import { IconAdd, IconTrash } from "./icons";
import type { RecordEditorKind } from "./recordEditors";
import {
	capabilityIssueViews,
	capabilityKeySuggestions,
	paramIssueViews,
	RecordMatcherEditorOverlay,
	RecordMatcherTable,
} from "./recordEditors";
import { SlideOver } from "./slideOver";
import { relativeTime } from "./time";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Radio } from "./ui/radio";
import { Select } from "./ui/select";
import { barPresentation, formatPercent, formatUsd } from "./usage";
import { sendRequest } from "./vscodeApi";

/** The entry-only-fields-inactive notice classifications; one merged banner covers them all. */

/**
 * Every inactive notice's user-facing pieces in one table: the notice list,
 * the merged banner's surface phrases, and the row badges all derive from it,
 * so a new notice cannot ship half-wired (the satisfies clause fails to
 * compile until the table names it). Zero-arg functions, so the strings
 * resolve after the l10n bootstrap; surface phrases are plural because the
 * banner appends "are not applied".
 */
const INACTIVE_NOTICE_PRESENTATION = {
	"entry-params-inactive": {
		surface: () => l10n.t("per-server model parameters"),
		badge: () => l10n.t("params inactive"),
		tip: () =>
			l10n.t(
				"Per-server model parameters are not applied: the group serving this entry predates its label or a rename. The banner below has the fix."
			),
	},
	"entry-capabilities-inactive": {
		surface: () => l10n.t("per-server model capabilities, declared models, and expected failures"),
		badge: () => l10n.t("capabilities inactive"),
		tip: () =>
			l10n.t(
				"Per-server model capabilities, declared models, and expected failures are not applied: the group serving this entry predates its label or a rename. The banner below has the fix."
			),
	},
	"entry-headers-inactive": {
		surface: () => l10n.t("per-server custom headers"),
		badge: () => l10n.t("headers inactive"),
		tip: () =>
			l10n.t(
				"Per-server custom headers are not applied: the group serving this entry predates its label or a rename. The banner below has the fix."
			),
	},
	"entry-api-version-inactive": {
		surface: () => l10n.t("per-server API version overrides"),
		badge: () => l10n.t("API version inactive"),
		tip: () =>
			l10n.t(
				"The API version override is not applied, requests use the auto rule: the group serving this entry predates its label or a rename. The banner below has the fix."
			),
	},
} as const satisfies Record<InactiveEntryNotice, { surface: () => string; badge: () => string; tip: () => string }>;

const INACTIVE_NOTICES = Object.keys(INACTIVE_NOTICE_PRESENTATION) as readonly InactiveEntryNotice[];

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
 * The row's status pill: tone dot, plain-language verdict, and how long ago
 * discovery last looked. An "ok" row that still carries an error (a live
 * group kept serving while its sync failed) shows the warn tone, as does an
 * expected discovery failure (the entry declared it, so red would be a lie);
 * the error text itself renders in the section's banner, where it is
 * selectable.
 */
function StatusPill({ server, now }: { server: DashboardServer; now: number }) {
	const checked = server.lastChecked === undefined ? undefined : relativeTime(server.lastChecked, now);
	const time = checked === undefined ? null : <span className="pill-time">{checked}</span>;
	if (server.origin === "misconfigured") {
		// Origin outranks state: the entry never reaches discovery, so whatever
		// state rides the row, the verdict is the invalid entry itself.
		return (
			<HoverTip
				focusable
				tip={l10n.t(
					"This entry in the servers setting is invalid and is not used until fixed; the banner below lists the problems."
				)}
			>
				<span className="pill tone-error">
					<span className="dot" />
					{l10n.t("Misconfigured")}
					{time}
				</span>
			</HoverTip>
		);
	}
	if (server.state === "ok") {
		if (server.error !== undefined) {
			return (
				<HoverTip
					focusable
					tip={l10n.t("The server answered, but its last settings sync reported a problem; details below.")}
				>
					<span className="pill tone-warn">
						<span className="dot" />
						{l10n.t("Sync issue")}
						{time}
					</span>
				</HoverTip>
			);
		}
		return (
			<span className="pill tone-ok">
				<span className="dot" />
				{l10n.t("Connected")}
				{time}
			</span>
		);
	}
	if (server.state === "error") {
		if (server.expected === true) {
			const declared = server.declaredModelCount ?? 0;
			// One state, one name across tabs: a row still serving declared
			// models reads Connected here exactly as the Diagnostics grid reads
			// it OK, with the warn tone and tip carrying the expected failure.
			return (
				<HoverTip
					focusable
					tip={
						declared > 0
							? l10n.t(
									"Discovery failed in a category this entry expects; its declared models keep serving. The banner below has the details."
								)
							: l10n.t(
									"Discovery failed in a category this entry expects. Nothing is declared, so no models are served; add IDs to the entry's discovery.declared."
								)
					}
				>
					<span className="pill tone-warn">
						<span className="dot" />
						{declared > 0 ? l10n.t("Connected") : l10n.t("Expected failure")}
						{time}
					</span>
				</HoverTip>
			);
		}
		return (
			<span className="pill tone-error">
				<span className="dot" />
				{l10n.t("Error")}
				{time}
			</span>
		);
	}
	return (
		<HoverTip
			focusable
			tip={l10n.t("Declared in settings; no discovery pass has seen it yet. Run Sync models to check it now.")}
		>
			<span className="pill tone-muted">
				<span className="dot" />
				{l10n.t("Not checked")}
			</span>
		</HoverTip>
	);
}

/** The DashboardServer origins as their own types; Extract keeps them in step with the protocol union. */
type DeclaredDashboardServer = Extract<DashboardServer, { origin: "declared" }>;
type ExternalDashboardServer = Extract<DashboardServer, { origin: "external" }>;
type MisconfiguredDashboardServer = Extract<DashboardServer, { origin: "misconfigured" }>;

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
 * What the open form is for, decided once where it opens (a row's Edit or the
 * Add button) so no component re-derives it from optional fields: adding a
 * new entry, editing a declared one, or adopting an external group.
 */
type FormTarget =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly original: DeclaredDashboardServer }
	| { readonly kind: "adopt"; readonly server: ExternalDashboardServer };

/** The targets ServerForm handles; adoption renders AdoptForm instead. */
type ServerFormTarget = Extract<FormTarget, { kind: "add" | "edit" }>;

/**
 * The edit form's live hint evidence: the CURRENT server row's observed
 * /model/info key set, looked up by the edited entry's label on every render
 * rather than read from the form's frozen open-time snapshot - a discovery
 * pass finishing while the form is open must update the capability rows'
 * unknown-key hints the same way it updates the host-side filter. An add
 * target has no server and so no evidence.
 */
function observedKeysForForm(
	servers: readonly DashboardServer[],
	target: ServerFormTarget
): readonly string[] | undefined {
	if (target.kind !== "edit") {
		return undefined;
	}
	const row = servers.find((server) => server.origin === "declared" && server.label === target.original.label);
	return row?.observedModelInfoKeys;
}

/**
 * The inspectors' jump into a declared entry's edit form (the surface owning
 * per-entry records). Minted by App; the seq keys re-delivery so repeating
 * the same jump re-opens.
 */
export interface ServerEditRequest {
	readonly seq: number;
	readonly label: string;
}

/** The form's collapsible sections that can hide a field's problem. */
type ProblemDisclosureId = "apiVersion" | "vkCompanion" | "oauthCompanions" | "stored" | "headers" | "params" | "caps";

/**
 * Which collapsed disclosures hide the given problems. The membership depends
 * on the selected auth form: the virtual key pair sits in the API-key form's
 * companion disclosure, in OAuth's companions area, or (as a kept stored
 * value) in the stored-credentials fold; a kept stored client secret sits
 * there too whenever OAuth is not the form.
 */
function disclosuresForProblems(problems: ServerFormProblems, authForm: AuthFormId): readonly ProblemDisclosureId[] {
	const ids: ProblemDisclosureId[] = [];
	if (problems.apiVersion !== undefined) {
		ids.push("apiVersion");
	}
	const vkProblem = problems.virtualKeyHeader !== undefined || problems.virtualKeyValue !== undefined;
	if (authForm === "apiKey" && vkProblem) {
		ids.push("vkCompanion");
	}
	if (authForm === "oauth" && (vkProblem || problems.apiKey !== undefined)) {
		ids.push("oauthCompanions");
	}
	if (
		(authForm !== "oauth" && problems.oauthClientSecret !== undefined) ||
		(authForm === "none" && problems.virtualKeyValue !== undefined)
	) {
		ids.push("stored");
	}
	if (problems.headers !== undefined) {
		ids.push("headers");
	}
	if (problems.modelParameters !== undefined) {
		ids.push("params");
	}
	if (problems.modelCapabilities !== undefined) {
		ids.push("caps");
	}
	return ids;
}

/**
 * Where the form is in its life. The prefill and save round trips each run
 * their own correlation (the prefill through its useRpc hook, the save
 * through the saved requestId below), but the form is only ever in one of
 * them: fields stay editable throughout, and only Save gates on the phase
 * being "editing".
 */
type FormPhase =
	| { readonly phase: "prefill" }
	| { readonly phase: "editing" }
	| { readonly phase: "saving"; readonly requestId: string };

/**
 * The draft-connection test's own little lifecycle, independent of FormPhase:
 * a test in flight must not gate editing, saving, or cancelling. Leaving
 * "testing" for any other state abandons the in-flight requestId, so a late
 * outcome for it is ignored - which is exactly what clearing on an edit needs.
 */
type TestState =
	| { readonly kind: "idle" }
	| { readonly kind: "testing"; readonly requestId: string }
	| { readonly kind: "pass"; readonly text: string }
	| {
			readonly kind: "fail";
			readonly text: string;
			readonly classification?: TransportErrorClassification | undefined;
	  };

/**
 * The troubleshooting-guide section behind a setup-hint id (the transport
 * assigns one only where the advice is known right; see
 * shared/errorClassification.ts), with the fuller accessible label naming the
 * destination. Labels resolve per call so the l10n bundle is honored. Shared
 * by the draft-test footer and the servers error banner, so a classified
 * failure links the same section wherever it surfaces.
 */
function troubleshootingLink(hint: SetupHintKind): { href: DocsUrl; label: string } {
	switch (hint) {
		case "proxy-not-running":
			return { href: DOCS_LINK_PROXY_NOT_RUNNING, label: l10n.t("Open the troubleshooting guide: unable to connect") };
		case "configure-api-key":
			return {
				href: DOCS_LINK_CONFIGURE_API_KEY,
				label: l10n.t("Open the troubleshooting guide: authentication failed"),
			};
		case "check-base-url":
			return {
				href: DOCS_LINK_CHECK_BASE_URL,
				label: l10n.t("Open the troubleshooting guide: the server answered 404"),
			};
	}
}

function secretDraft(existing: SecretLocation): SecretFieldDraft {
	return { value: "", location: existing === "settings" ? "settings" : "secure", clear: false, existing };
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
 * The API version disclosure's summary: the plain optional invitation while
 * the mode is the auto default, the chosen override otherwise - a collapsed
 * disclosure must not hide that an edited server carries one.
 */
function apiVersionSummaryText(value: ApiVersionDraft): string {
	if (value.mode === "none") {
		return l10n.t("API version: none");
	}
	if (value.mode === "custom") {
		const custom = value.custom.trim();
		return custom.length > 0 ? l10n.t("API version: {0}", custom) : l10n.t("API version: custom");
	}
	return l10n.t("API version (optional)");
}

function draftFor(target: ServerFormTarget): ServerFormDraft {
	if (target.kind === "add") {
		return EMPTY_SERVER_FORM;
	}
	const original = target.original;
	return {
		label: original.label,
		baseUrl: original.baseUrl,
		apiVersion: apiVersionDraftOf(original.config.apiVersion),
		authForm: deriveAuthForm(original.config),
		oauthTokenUrl: original.config.oauthTokenUrl ?? "",
		oauthClientId: original.config.oauthClientId ?? "",
		oauthScopes: original.config.oauthScopes ?? "",
		virtualKeyHeader: original.config.virtualKeyHeader ?? "",
		apiKey: secretDraft(original.config.secrets.apiKey),
		oauthClientSecret: secretDraft(original.config.secrets.oauthClientSecret),
		virtualKeyValue: secretDraft(original.config.secrets.virtualKeyValue),
		headers: toHeaderRows(original.config.headers ?? {}),
		declaredModels: (original.config.declaredModels ?? []).join("\n"),
		budget: original.config.budget !== undefined ? String(original.config.budget) : "",
		modelParameters: toGroups(original.config.modelParameters ?? {}),
		modelCapabilities: toCapabilityGroups(original.config.modelCapabilities ?? {}),
		expectedFailures: original.config.expectedFailures ?? [],
	};
}

/**
 * The Authentication selector's option labels; OAuth stays English (protocol
 * term). Deliberately distinct from the field labels ("API key", "Virtual key
 * header"): two identical label texts would leave label-based lookup - screen
 * readers' and the test harness's alike - ambiguous.
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

/** The selector's render order: rank order, none first. */
const AUTH_FORM_IDS: readonly AuthFormId[] = ["none", "apiKey", "virtualKey", "oauth"];

/** The storage locations' display names, resolved at call time (no module-level localized constants). */
function locationName(location: Exclude<SecretLocation, "none">): string {
	return location === "secure" ? l10n.t("secret storage") : l10n.t("settings");
}

interface FieldRenderProps {
	readonly draft: ServerFormDraft;
	/**
	 * The problems the form shows right now, computed once per render in
	 * ServerForm (a problem is visible once its field was touched or holds
	 * content). Fields render these directly, so the field decorations, the
	 * OAuth disclosure, and the save summary cannot disagree.
	 */
	readonly visibleProblems: ServerFormProblems;
	readonly disabled: boolean;
	readonly patch: (patch: Partial<ServerFormDraft>) => void;
	readonly touch: (field: ServerFormField) => void;
}

function TextField({
	field,
	placeholder,
	props,
}: {
	field: Exclude<
		ServerFormField,
		| SecretFieldId
		| "apiVersion"
		| "authForm"
		| "headers"
		| "declaredModels"
		| "modelParameters"
		| "modelCapabilities"
		| "expectedFailures"
	>;
	placeholder?: string;
	props: FieldRenderProps;
}) {
	const problem = props.visibleProblems[field];
	const showProblem = problem !== undefined;
	const id = `server-${field}`;
	const errorId = `${id}-error`;
	return (
		<div className="field">
			<span className="label-row">
				<label htmlFor={id}>{serverFormFieldLabel(field)}</label>
				<Help text={serverFieldHelp(field)} />
			</span>
			<Input
				id={id}
				type="text"
				placeholder={placeholder ?? ""}
				value={props.draft[field]}
				disabled={props.disabled}
				aria-invalid={showProblem}
				aria-describedby={showProblem ? errorId : undefined}
				onChange={(event) => props.patch({ [field]: event.currentTarget.value } as Partial<ServerFormDraft>)}
				onBlur={() => props.touch(field)}
			/>
			{showProblem ? (
				<span id={errorId} className="error">
					{problem}
				</span>
			) : null}
		</div>
	);
}

/**
 * React mirrors a controlled input's value into the value ATTRIBUTE (via the
 * defaultValue property, for form-reset semantics), which would put a
 * secret's plaintext into every DOM serialization - and the mirror is written
 * again after each input event by React's controlled-state restoration, so a
 * one-time scrub cannot hold. This mount ref instead makes the mirror inert
 * for the node's lifetime: it re-writes the value property first (a dirty
 * input no longer reflects the attribute, so the removal cannot blank a
 * not-yet-touched field), removes the mounted attribute, and shadows
 * defaultValue with a no-op instance property so every later mirror write
 * vanishes. The secret still lives only in the value property, exactly the
 * one residence the sweep in the tests permits.
 */
function disarmValueAttributeMirror(node: HTMLInputElement | null): void {
	if (node === null) {
		return;
	}
	const current = node.value;
	node.value = current;
	node.removeAttribute("value");
	Object.defineProperty(node, "defaultValue", {
		configurable: true,
		get: () => "",
		set: () => undefined,
	});
}

/**
 * One secret field: a password input plus the user's per-field storage
 * choice. Values in secure storage are never shown (they never reach this
 * page); an inline value prefills the input, masked behind a Show toggle,
 * because settings.json already displays it in plain text. Leaving the input
 * empty - or leaving a prefill unedited - keeps the stored value where it is.
 * Invariant: this is the page's ONLY secret-bearing input. A new secret field
 * must render through it, because the disarm above is what keeps the value
 * out of the serialized DOM.
 */
function SecretField({ field, help, props }: { field: SecretFieldId; help?: string; props: FieldRenderProps }) {
	const value = props.draft[field];
	const problem = props.visibleProblems[field];
	const showProblem = problem !== undefined;
	const [revealed, setRevealed] = useState(false);
	// Nothing to reveal in an empty or removal-marked field, so the toggle
	// disables and any lingering revealed state resets: the next value typed
	// (or a re-ticked remove undone) starts masked again.
	const empty = value.value.trim().length === 0;
	useEffect(() => {
		if (empty || value.clear) {
			setRevealed(false);
		}
	}, [empty, value.clear]);
	const id = `server-${field}`;
	const errorId = `${id}-error`;
	const patchSecret = (patch: Partial<SecretFieldDraft>) =>
		props.patch({ [field]: { ...value, ...patch } } as Partial<ServerFormDraft>);
	return (
		<div className="field">
			<span className="label-row">
				<label htmlFor={id}>{serverFormFieldLabel(field)}</label>
				<Help text={help ?? serverFieldHelp(field)} />
			</span>
			<span className="secret-input">
				<Input
					id={id}
					ref={disarmValueAttributeMirror}
					// The reveal button is absolutely positioned over the field's
					// right edge; the padding keeps the value clear of it.
					className="min-w-0 flex-1 pr-13"
					type={revealed ? "text" : "password"}
					value={value.value}
					disabled={props.disabled || value.clear}
					aria-invalid={showProblem}
					aria-describedby={showProblem ? errorId : undefined}
					onChange={(event) => patchSecret({ value: event.currentTarget.value })}
					onBlur={() => props.touch(field)}
				/>
				<Button
					variant="quiet"
					aria-pressed={revealed}
					aria-label={
						revealed
							? l10n.t("Hide the {0}", serverFormFieldLabel(field))
							: l10n.t("Show the {0}", serverFormFieldLabel(field))
					}
					disabled={props.disabled || value.clear || empty}
					onClick={() => setRevealed((current) => !current)}
				>
					{revealed ? l10n.t("Hide") : l10n.t("Show")}
				</Button>
			</span>
			<span
				className="secret-where"
				role="radiogroup"
				aria-label={l10n.t("Where to store the {0}", serverFormFieldLabel(field))}
			>
				<span className="where-label">{l10n.t("Store in:")}</span>
				<Help text={helpSecretStorage()} />
				<label>
					<Radio
						name={`${id}-where`}
						checked={value.location === "secure"}
						disabled={props.disabled || value.clear}
						onChange={() => patchSecret({ location: "secure" })}
					/>
					{l10n.t("secret storage")}
				</label>
				<label>
					<Radio
						name={`${id}-where`}
						checked={value.location === "settings"}
						disabled={props.disabled || value.clear}
						onChange={() => patchSecret({ location: "settings" })}
					/>
					{l10n.t("settings (visible)")}
				</label>
			</span>
			{/* Removal is destructive, so it lives on its own line in its own
			    tone, never as a third option inside the storage choice. */}
			{value.existing !== "none" ? (
				<label className={value.clear ? "secret-remove armed" : "secret-remove"}>
					<Checkbox
						checked={value.clear}
						disabled={props.disabled}
						onChange={(event) => patchSecret({ clear: event.currentTarget.checked })}
					/>
					{l10n.t("Remove the stored {0} on save", serverFormFieldLabel(field))}
				</label>
			) : null}
			{value.prefill !== undefined && !value.clear ? (
				value.value.trim().length === 0 ? (
					<span className="hint">{l10n.t("Emptied, but the stored value is kept; use remove to delete it.")}</span>
				) : (
					<span className="hint">
						{l10n.t("Inline in the servers setting, so settings.json already shows it; saving it unedited keeps it.")}
					</span>
				)
			) : value.existing !== "none" && !value.clear ? (
				<span className="hint">
					{l10n.t("Currently in {0}; leave the field empty to keep it.", locationName(value.existing))}
				</span>
			) : null}
			{value.clear ? <span className="hint">{l10n.t("The stored value will be removed on save.")}</span> : null}
			{showProblem ? (
				<span id={errorId} className="error">
					{problem}
				</span>
			) : null}
		</div>
	);
}

/**
 * Whether a field "holds content" for problem visibility. Record-row and
 * list-valued fields only carry problems on entries the user (or the
 * prefill) put there, so any entries count as content; text and secret
 * fields count their text.
 */
function fieldHasContent(draft: ServerFormDraft, field: ServerFormField): boolean {
	if (
		field === "modelParameters" ||
		field === "modelCapabilities" ||
		field === "expectedFailures" ||
		field === "headers"
	) {
		return draft[field].length > 0;
	}
	if (field === "authForm") {
		// The selector always holds a pick and never carries a problem.
		return false;
	}
	if (field === "apiVersion") {
		// Only a custom mode with text counts: an empty custom surfaces on Save
		// (which marks every field touched), like the other required-but-empty
		// inputs.
		return draft.apiVersion.mode === "custom" && draft.apiVersion.custom.length > 0;
	}
	const value = draft[field];
	return typeof value === "string" ? value.length > 0 : value.value.length > 0;
}

/**
 * An inactive form's stored secret, rendered so its Remove checkbox stays
 * reachable without offering an input (the parse would drop anything typed
 * into a field whose form is not selected): where the value lives, the remove
 * gesture, and any problem the parse pinned on the field.
 */
function StoredSecretRow({ field, props }: { field: SecretFieldId; props: FieldRenderProps }) {
	const value = props.draft[field];
	const problem = props.visibleProblems[field];
	const patchSecret = (patch: Partial<SecretFieldDraft>) =>
		props.patch({ [field]: { ...value, ...patch } } as Partial<ServerFormDraft>);
	return (
		<div className="field">
			<span className="field-label">{serverFormFieldLabel(field)}</span>
			{value.existing === "none" ? null : (
				<span className="hint">{l10n.t("Currently in {0}.", locationName(value.existing))}</span>
			)}
			<label className={value.clear ? "secret-remove armed" : "secret-remove"}>
				<Checkbox
					checked={value.clear}
					disabled={props.disabled}
					onChange={(event) => patchSecret({ clear: event.currentTarget.checked })}
				/>
				{l10n.t("Remove the stored {0} on save", serverFormFieldLabel(field))}
			</label>
			{value.clear ? <span className="hint">{l10n.t("The stored value will be removed on save.")}</span> : null}
			{problem !== undefined ? <span className="error">{problem}</span> : null}
		</div>
	);
}

/**
 * The custom-header rows: name and value inputs per row, the parse's
 * row-aligned problems under the offending row, remove and add actions - the
 * record editors' row idiom over the entry's headers record.
 */
function HeaderRowsEditor({
	rows,
	problems,
	disabled,
	onChange,
}: {
	rows: readonly HeaderRow[];
	problems: readonly (string | undefined)[];
	disabled: boolean;
	onChange: (next: readonly HeaderRow[]) => void;
}) {
	return (
		<>
			<div className="rows">
				{rows.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: header rows are positional while being edited; the index is the identity
					<div className="row" key={index}>
						<span className="cell key">
							<Input
								type="text"
								className="key"
								aria-label={l10n.t("Header name")}
								aria-invalid={problems[index] !== undefined}
								placeholder={l10n.t("Header, e.g. x-routing-env")}
								value={row.name}
								disabled={disabled}
								onChange={(event) =>
									onChange(rows.map((r, i) => (i === index ? { ...r, name: event.currentTarget.value } : r)))
								}
							/>
						</span>
						<span className="cell value">
							<Input
								type="text"
								className="value"
								aria-invalid={problems[index] !== undefined}
								aria-label={l10n.t("Header value")}
								placeholder={l10n.t("Value, e.g. prod")}
								value={row.valueText}
								disabled={disabled}
								onChange={(event) =>
									onChange(rows.map((r, i) => (i === index ? { ...r, valueText: event.currentTarget.value } : r)))
								}
							/>
						</span>
						<Button variant="quiet" disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
							<IconTrash /> {l10n.t("Remove")}
						</Button>
						{problems[index] !== undefined ? <span className="error">{problems[index]}</span> : null}
					</div>
				))}
			</div>
			<Button variant="secondary" disabled={disabled} onClick={() => onChange([...rows, { name: "", valueText: "" }])}>
				<IconAdd /> {l10n.t("Add header")}
			</Button>
		</>
	);
}

/**
 * The inline Add/Edit form. Saving posts one saveServerSetting intent through
 * the form's own useIntentOutcome hook and waits for its correlated outcome:
 * an ok closes the form (discarding the draft, typed secrets included); a
 * validation-kind fail returns it to a retryable editing state, while an
 * operation-kind one closes it too - the save committed, so the draft is
 * stale and the section-level notice carries the recovery path. Unrelated
 * state pushes leave it alone.
 */
function ServerForm({
	target,
	declaredLabels,
	observedModelInfoKeys,
	onUserEdit,
	onClose,
	onCancel,
}: {
	target: ServerFormTarget;
	declaredLabels: readonly string[];
	/** The edited entry's LIVE observed /model/info key set (observedKeysForForm); the capability hints' evidence. */
	observedModelInfoKeys?: readonly string[] | undefined;
	/** Reports the first user edit; the slide-over's close-with-confirm keys on it. */
	onUserEdit: () => void;
	onClose: () => void;
	/** The Cancel button's close request; routed through the slide-over's discard policy. */
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<ServerFormDraft>(() => draftFor(target));
	const [touched, setTouched] = useState<ReadonlySet<ServerFormField>>(new Set());
	const [phase, setPhase] = useState<FormPhase>({ phase: "editing" });
	const [testState, setTestState] = useState<TestState>({ kind: "idle" });
	// The form's own round trips. The inline-secret values live only in this
	// hook's state and the draft, both of which die with the form instance, so
	// a closed form leaves no secret value behind in webview memory.
	const saveIntent = useIntentOutcome("saveServerSetting");
	const testIntent = useIntentOutcome("testServerDraft");
	const inlineSecrets = useRpc("readInlineSecrets");
	// The disclosures open by themselves only for an entry that already
	// carries content in them; adding to a bare entry is opt-in. The auth
	// companions follow the same rule under the form the entry derives to.
	const [vkCompanionOpen, setVkCompanionOpen] = useState(
		() =>
			target.kind === "edit" &&
			deriveAuthForm(target.original.config) === "apiKey" &&
			((target.original.config.virtualKeyHeader ?? "").length > 0 ||
				target.original.config.secrets.virtualKeyValue !== "none")
	);
	const [oauthCompanionsOpen, setOauthCompanionsOpen] = useState(
		() =>
			target.kind === "edit" &&
			deriveAuthForm(target.original.config) === "oauth" &&
			(target.original.config.secrets.apiKey !== "none" ||
				(target.original.config.virtualKeyHeader ?? "").length > 0 ||
				target.original.config.secrets.virtualKeyValue !== "none")
	);
	const [storedOpen, setStoredOpen] = useState(false);
	const [apiVersionOpen, setApiVersionOpen] = useState(
		// A prefilled override must not hide behind a collapsed disclosure.
		() => target.kind === "edit" && target.original.config.apiVersion !== undefined
	);
	const [headersOpen, setHeadersOpen] = useState(
		() => target.kind === "edit" && Object.keys(target.original.config.headers ?? {}).length > 0
	);
	const [discoveryOpen, setDiscoveryOpen] = useState(
		() =>
			target.kind === "edit" &&
			((target.original.config.declaredModels ?? []).length > 0 ||
				(target.original.config.expectedFailures ?? []).length > 0)
	);
	const [paramsOpen, setParamsOpen] = useState(
		() => target.kind === "edit" && Object.keys(target.original.config.modelParameters ?? {}).length > 0
	);
	const [capsOpen, setCapsOpen] = useState(
		() => target.kind === "edit" && Object.keys(target.original.config.modelCapabilities ?? {}).length > 0
	);
	// The full matcher editor overlay over this form, by record kind and DRAFT
	// index (the tables' sorted order is a view; the draft array is the
	// identity space). Index identity is safe HERE, unlike the settings
	// editors: the form's draft is local state no store push ever rewrites,
	// so the arrays only change through the form's own actions. It still
	// closes itself when its group leaves the draft.
	const [matcherEditor, setMatcherEditor] = useState<{ kind: RecordEditorKind; index: number } | undefined>(undefined);
	const draftModelParameters = draft.modelParameters;
	const draftModelCapabilities = draft.modelCapabilities;
	useEffect(() => {
		setMatcherEditor((current) => {
			if (current === undefined) {
				return current;
			}
			const list = current.kind === "params" ? draftModelParameters : draftModelCapabilities;
			return list[current.index] === undefined ? undefined : current;
		});
	}, [draftModelParameters, draftModelCapabilities]);
	const saving = phase.phase === "saving";
	// Save holds until the prefill response lands (phase "prefill"): saving
	// before it arrives would assemble the still-empty fields as "keep",
	// silently dropping a relocation the user just picked (flip the radio to
	// secure, hit Save). Fields stay editable meanwhile; the response never
	// clobbers what was typed. The response is one round trip behind the form
	// opening, so the gate is imperceptible in practice.
	const saveOutcome = saveIntent.outcome;

	// Editing a declared entry with inline-stored secrets: ask for their values
	// once per form instance (the key remounts a fresh form). Secure-side and
	// absent fields are never requested-for or returned; they keep the empty
	// placeholder input.
	const requestInlineSecrets = inlineSecrets.send;
	useEffect(() => {
		if (target.kind !== "edit") {
			return;
		}
		const config = target.original.config;
		if (!SECRET_FIELD_IDS.some((field) => config.secrets[field] === "settings")) {
			return;
		}
		requestInlineSecrets({ label: target.original.label });
		setPhase({ phase: "prefill" });
	}, [target, requestInlineSecrets]);

	// This form's own response prefills the untouched inline fields; the hook
	// answers only the request this form instance posted.
	const inlineValues = inlineSecrets.data?.values;
	useEffect(() => {
		if (phase.phase !== "prefill" || inlineValues === undefined) {
			return;
		}
		setPhase({ phase: "editing" });
		setDraft((current) => applyInlinePrefill(current, inlineValues));
	}, [inlineValues, phase]);

	useEffect(() => {
		if (phase.phase === "saving" && saveOutcome?.result === "ok" && saveOutcome.id === phase.requestId) {
			onClose();
		}
	}, [saveOutcome, phase, onClose]);

	// This form's own test outcome. Success renders the extension-composed
	// message verbatim ("Connected - N models"); an outcome for an abandoned
	// requestId (the state left "testing" on an edit or a retest) is ignored.
	const testOutcome = testIntent.outcome;
	useEffect(() => {
		if (testState.kind !== "testing" || testOutcome === undefined || testOutcome.id !== testState.requestId) {
			return;
		}
		if (testOutcome.result === "ok") {
			setTestState({ kind: "pass", text: testOutcome.message ?? l10n.t("Connected") });
		} else {
			setTestState({
				kind: "fail",
				text: testOutcome.message,
				classification: testOutcome.classification,
			});
		}
	}, [testOutcome, testState]);

	// This form's own failure: a validation-kind one re-opens it for editing
	// (the draft is still the truth); an operation-kind one means the save
	// committed and the draft is stale, so the form closes like a success. The
	// message renders at the section level either way, so it also survives the
	// closed form.
	useEffect(() => {
		if (phase.phase !== "saving" || saveOutcome?.result !== "fail" || saveOutcome.id !== phase.requestId) {
			return;
		}
		if (saveFailureDisposition(saveOutcome.failureKind) === "close") {
			onClose();
			return;
		}
		setPhase({ phase: "editing" });
	}, [saveOutcome, phase, onClose]);

	const originalLabel = target.kind === "edit" ? target.original.label : undefined;
	// One parse per keystroke: it either carries the intent Save posts or the
	// problems the form renders, so what the fields show and what would be
	// saved can never diverge. The observed-keys evidence is the live prop, so
	// a discovery pass finishing under the open form refreshes the hints.
	const parse = parseServerForm(draft, {
		takenLabels: declaredLabels,
		...(originalLabel !== undefined ? { originalLabel } : {}),
		...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
	});
	const label = draft.label.trim();
	const renaming = target.kind === "edit" && label !== target.original.label;
	const collides = target.kind === "add" && declaredLabels.includes(label);

	// A problem is visible once its field was touched or holds content
	// (fieldHasContent); computed once here and passed through the render
	// props, so the fields, the disclosures, and the save summary all show the
	// same problems.
	const visibleProblems: ServerFormProblems = {};
	if (!parse.ok) {
		for (const field of SERVER_FORM_FIELD_ORDER) {
			const problem = parse.problems[field];
			if (problem === undefined) {
				continue;
			}
			if (touched.has(field) || fieldHasContent(draft, field)) {
				visibleProblems[field] = problem;
			}
		}
	}
	const modelParameterProblems: readonly GroupProblems[] = parse.ok ? [] : parse.modelParameterProblems;
	const modelParameterHints = parse.modelParameterHints;
	const modelCapabilityIssues = parse.modelCapabilityIssues;
	const entryParamIssueViews = paramIssueViews(draft.modelParameters, modelParameterProblems, modelParameterHints);
	const entryCapIssueViews = capabilityIssueViews(draft.modelCapabilities, modelCapabilityIssues);
	// The capability-key autocomplete over THIS entry's own observed
	// /model/info vocabulary (live, like the hint evidence above): an
	// entry-scoped record applies to this server only, so other servers'
	// vocabularies never leak in - an add target (no server yet) and a server
	// without evidence get just the static list.
	const entryCapabilityKeySuggestions = capabilityKeySuggestions(observedModelInfoKeys);
	const headerRowProblems: readonly (string | undefined)[] = parse.ok ? [] : parse.headerProblems;
	const firstBlocking = SERVER_FORM_FIELD_ORDER.find((field) => visibleProblems[field] !== undefined);
	const problemDisclosureSetters: Record<ProblemDisclosureId, (open: boolean) => void> = {
		apiVersion: setApiVersionOpen,
		vkCompanion: setVkCompanionOpen,
		oauthCompanions: setOauthCompanionsOpen,
		stored: setStoredOpen,
		headers: setHeadersOpen,
		params: setParamsOpen,
		caps: setCapsOpen,
	};
	const openDisclosures = (ids: readonly ProblemDisclosureId[]) => {
		for (const id of ids) {
			problemDisclosureSetters[id](true);
		}
	};
	// A problem surfacing inside a collapsed disclosure opens it once
	// (otherwise Save would refuse over an error the user cannot see); beyond
	// that the element is the user's: closing it again sticks, and it does not
	// snap shut when the problems clear. The ref remembers the previous set so
	// only ids that just APPEARED open - a set change elsewhere must not
	// reopen a disclosure the user deliberately closed.
	const problemDisclosureKey = disclosuresForProblems(visibleProblems, draft.authForm).join(",");
	const openedForProblems = useRef<ReadonlySet<ProblemDisclosureId>>(new Set());
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on the joined disclosure key (see above); openDisclosures is a stable setter wrapper read at fire time
	useEffect(() => {
		const current = new Set(
			problemDisclosureKey.length > 0 ? (problemDisclosureKey.split(",") as ProblemDisclosureId[]) : []
		);
		const appeared = [...current].filter((id) => !openedForProblems.current.has(id));
		openedForProblems.current = current;
		if (appeared.length > 0) {
			openDisclosures(appeared);
		}
	}, [problemDisclosureKey]);

	const save = () => {
		if (phase.phase !== "editing") {
			// Belt and braces behind the disabled button: never post while the
			// prefill is still on its way or a save is already in flight.
			return;
		}
		if (!parse.ok) {
			// Surface every problem instead of refusing silently.
			setTouched(new Set(SERVER_FORM_FIELD_ORDER));
			openDisclosures(disclosuresForProblems(parse.problems, draft.authForm));
			return;
		}
		const requestId = saveIntent.send(parse.intent);
		setPhase({ phase: "saving", requestId });
	};

	// The draft as typed goes out for one extension-side discovery probe; the
	// label and the model-parameter rows never gate it (parseServerFormForTest),
	// but a connection-relevant problem surfaces the way Save surfaces its
	// problems instead of probing a configuration a save would refuse.
	const testConnection = () => {
		if (testState.kind === "testing" || saving) {
			return;
		}
		const testParse = parseServerFormForTest(draft, originalLabel !== undefined ? { originalLabel } : {});
		if (!testParse.ok) {
			setTouched((current) => {
				const next = new Set(current);
				for (const field of CONNECTION_FIELDS) {
					if (testParse.problems[field] !== undefined) {
						next.add(field);
					}
				}
				return next;
			});
			openDisclosures(disclosuresForProblems(testParse.problems, draft.authForm));
			return;
		}
		const requestId = testIntent.send(testParse.intent);
		setTestState({ kind: "testing", requestId });
	};

	const props: FieldRenderProps = {
		draft,
		visibleProblems,
		disabled: saving,
		patch: (patch) => {
			onUserEdit();
			// Any field a probe's outcome depends on makes a standing (or
			// in-flight) result describe a configuration that no longer exists;
			// a stale PASS is worse than no result, so it clears. The label
			// counts: it selects which stored or orphan secret a "keep" directive
			// resolves extension-side, so a rename can silently change the
			// effective credentials the probe would use.
			// modelCapabilities and expectedFailures stay out of CONNECTION_FIELDS
			// (they never gate a probe) but still clear a standing result: they
			// shape its OUTCOME - the declared count and the expected downgrade.
			if (
				testState.kind !== "idle" &&
				Object.keys(patch).some(
					(field) =>
						field === "label" ||
						field === "modelCapabilities" ||
						field === "expectedFailures" ||
						field === "declaredModels" ||
						(CONNECTION_FIELDS as readonly string[]).includes(field)
				)
			) {
				setTestState({ kind: "idle" });
			}
			setDraft((current) => ({ ...current, ...patch }));
		},
		touch: (field) => {
			// An empty field stays quiet on blur: brushing focus past it toward
			// Cancel must not repaint the form mid-click (the inserted error line
			// moves the buttons under the pointer). A required-but-empty field
			// surfaces on Save, which marks every field touched.
			if (!fieldHasContent(draft, field)) {
				return;
			}
			setTouched((current) => new Set(current).add(field));
		},
	};

	// Kept stored secrets whose form is not selected: the shape-and-storage
	// rule (docs/servers.md#secrets-and-secret-storage) means a stored API key
	// still activates the bearer on the none and virtualKey shapes, and kept
	// stored values of the other two fields would make the save OAuth- or
	// virtual-key-shaped, so each renders a visible hint plus its Remove
	// checkbox instead of silently riding along.
	const storedApiKeyOrphan =
		(draft.authForm === "none" || draft.authForm === "virtualKey") && draft.apiKey.existing !== "none";
	const storedVkOrphan = draft.authForm === "none" && draft.virtualKeyValue.existing !== "none";
	const storedOauthSecretOrphan = draft.authForm !== "oauth" && draft.oauthClientSecret.existing !== "none";

	const virtualKeyPair = (
		<>
			<TextField field="virtualKeyHeader" placeholder={l10n.t("e.g. x-litellm-api-key")} props={props} />
			<SecretField field="virtualKeyValue" props={props} />
		</>
	);

	// Closing the overlay sweeps up a still-pristine new matcher (no key, no
	// fields): keeping it would strand an invalid empty row in the table.
	// Both the sweep and the add that minted the group write through setDraft
	// directly, NOT props.patch: a structural add-then-cancel is a no-op and
	// must not arm the form's discard confirm (onUserEdit is one-way).
	const closeMatcherEditor = () => {
		if (matcherEditor !== undefined) {
			const list = matcherEditor.kind === "params" ? draft.modelParameters : draft.modelCapabilities;
			const group = list[matcherEditor.index];
			if (group !== undefined && group.prefix.trim().length === 0 && group.params.length === 0) {
				const remaining = list.filter((_, index) => index !== matcherEditor.index);
				setDraft((current) =>
					matcherEditor.kind === "params"
						? { ...current, modelParameters: remaining }
						: { ...current, modelCapabilities: remaining }
				);
			}
		}
		setMatcherEditor(undefined);
	};
	const matcherEditorNote = l10n.t("Changes here edit the form; Save stores them on the entry.");
	const matcherEditorView = (() => {
		if (matcherEditor === undefined) {
			return null;
		}
		if (matcherEditor.kind === "params") {
			const group = draft.modelParameters[matcherEditor.index];
			if (group === undefined) {
				return null;
			}
			return (
				<RecordMatcherEditorOverlay
					kind="params"
					group={group}
					groupProblems={modelParameterProblems[matcherEditor.index]}
					groupHints={modelParameterHints[matcherEditor.index]}
					prefixHelp={helpEntryModelParameterPrefix()}
					disabled={saving}
					fallbackFocusId="server-params-add"
					note={matcherEditorNote}
					onChange={(next) =>
						props.patch({
							modelParameters: draft.modelParameters.map((g, index) => (index === matcherEditor.index ? next : g)),
						})
					}
					onRemove={() => {
						props.patch({
							modelParameters: draft.modelParameters.filter((_, index) => index !== matcherEditor.index),
						});
						setMatcherEditor(undefined);
					}}
					onClose={closeMatcherEditor}
				/>
			);
		}
		const group = draft.modelCapabilities[matcherEditor.index];
		if (group === undefined) {
			return null;
		}
		return (
			<RecordMatcherEditorOverlay
				kind="caps"
				group={group}
				groupIssues={modelCapabilityIssues[matcherEditor.index]}
				keySuggestions={entryCapabilityKeySuggestions}
				disabled={saving}
				fallbackFocusId="server-caps-add"
				note={matcherEditorNote}
				onChange={(next) =>
					props.patch({
						modelCapabilities: draft.modelCapabilities.map((g, index) => (index === matcherEditor.index ? next : g)),
					})
				}
				onRemove={() => {
					props.patch({
						modelCapabilities: draft.modelCapabilities.filter((_, index) => index !== matcherEditor.index),
					});
					setMatcherEditor(undefined);
				}}
				onClose={closeMatcherEditor}
			/>
		);
	})();

	return (
		<div className="form-card">
			{/* The dialog's accessible name is the title span alone, so the
			    docs anchor's own label never leaks into it. */}
			<h3 className="head-with-icons">
				<span id="server-form-title">
					{target.kind === "add" ? l10n.t("Add server") : l10n.t("Edit {0}", target.original.label)}
				</span>
				<DocsLink href={DOCS_LINK_SERVER_FORM} label={l10n.t("Open the server fields guide")} />
			</h3>
			<TextField field="label" placeholder={l10n.t("e.g. Production")} props={props} />
			{renaming && (parse.ok || parse.problems.label === undefined) ? (
				<p className="hint">
					{l10n.t(
						"Renaming makes VS Code treat this as a new server: the old name keeps serving its models until you delete its object from the models file (the rename notice opens it)."
					)}
				</p>
			) : null}
			{target.kind === "edit" && !renaming ? (
				<details className="fine-print">
					<summary>{l10n.t("Changing the URL or credentials?")}</summary>
					<p className="hint">
						{l10n.t("Saving stores the change, but VS Code keeps using the old connection details until:")}
					</p>
					<ol className="notice-steps hint">
						<li>{l10n.t("You remove this server's object from the models file (chatLanguageModels.json).")}</li>
						<li>{l10n.t("You reload the window, then run Sync Models Now.")}</li>
					</ol>
				</details>
			) : null}
			{collides ? (
				<p className="hint">{l10n.t("An entry with this label already exists; saving replaces it.")}</p>
			) : null}
			<TextField field="baseUrl" placeholder={l10n.t("e.g. http://localhost:4000")} props={props} />
			<details open={apiVersionOpen} onToggle={(event) => setApiVersionOpen(event.currentTarget.open)}>
				<summary>
					{apiVersionSummaryText(draft.apiVersion)} <Help text={serverFieldHelp("apiVersion")} />
				</summary>
				<div className="field">
					{/* The summary already names the field; an aria-label keeps the
					    select accessible without saying "API version" a second time. */}
					<Select
						id="server-apiVersion-mode"
						aria-label={serverFormFieldLabel("apiVersion")}
						value={draft.apiVersion.mode}
						disabled={saving}
						onChange={(event) =>
							props.patch({
								apiVersion: { ...draft.apiVersion, mode: event.currentTarget.value as ApiVersionDraft["mode"] },
							})
						}
					>
						<option value="auto">{l10n.t("Auto - detect, default /{0}", DEFAULT_API_VERSION)}</option>
						<option value="none">{l10n.t("No version - use the URL as-is")}</option>
						<option value="custom">{l10n.t("Custom...")}</option>
					</Select>
				</div>
				{draft.apiVersion.mode === "custom" ? (
					<div className="field">
						<label htmlFor="server-apiVersion">{l10n.t("Version segment")}</label>
						<Input
							id="server-apiVersion"
							type="text"
							placeholder={l10n.t("e.g. v2")}
							value={draft.apiVersion.custom}
							disabled={saving}
							aria-invalid={visibleProblems.apiVersion !== undefined}
							aria-describedby={visibleProblems.apiVersion !== undefined ? "server-apiVersion-error" : undefined}
							onChange={(event) =>
								props.patch({ apiVersion: { ...draft.apiVersion, custom: event.currentTarget.value } })
							}
							onBlur={() => props.touch("apiVersion")}
						/>
						{visibleProblems.apiVersion !== undefined ? (
							<span id="server-apiVersion-error" className="error">
								{visibleProblems.apiVersion}
							</span>
						) : null}
					</div>
				) : null}
			</details>
			<fieldset className="auth-block">
				<legend className="label-row">
					{serverFormFieldLabel("authForm")} <Help text={serverFieldHelp("authForm")} />
					<DocsLink href={DOCS_LINK_AUTHENTICATION} label={l10n.t("Open the authentication guide")} />
				</legend>
				<div className="auth-selector" role="radiogroup" aria-label={serverFormFieldLabel("authForm")}>
					{AUTH_FORM_IDS.map((form) => (
						<label key={form}>
							<Radio
								name="server-auth-form"
								checked={draft.authForm === form}
								disabled={saving}
								onChange={() => props.patch({ authForm: form })}
							/>
							{authFormName(form)}
						</label>
					))}
				</div>
				{draft.authForm === "apiKey" ? (
					<>
						<SecretField field="apiKey" props={props} />
						<details open={vkCompanionOpen} onToggle={(event) => setVkCompanionOpen(event.currentTarget.open)}>
							<summary>{l10n.t("Also send a virtual key header (optional)")}</summary>
							<p className="hint">
								{l10n.t("For gateways that check the bearer and a key in a second header at once.")}
							</p>
							{virtualKeyPair}
						</details>
					</>
				) : null}
				{draft.authForm === "virtualKey" ? virtualKeyPair : null}
				{draft.authForm === "oauth" ? (
					<>
						<TextField
							field="oauthTokenUrl"
							placeholder={l10n.t("e.g. https://idp.example.com/oauth2/token")}
							props={props}
						/>
						<TextField field="oauthClientId" placeholder={l10n.t("e.g. litellm-vscode")} props={props} />
						<SecretField field="oauthClientSecret" props={props} />
						<TextField field="oauthScopes" placeholder={l10n.t("e.g. litellm.read litellm.write")} props={props} />
						<details open={oauthCompanionsOpen} onToggle={(event) => setOauthCompanionsOpen(event.currentTarget.open)}>
							<summary>{l10n.t("Companions (optional)")}</summary>
							<p className="hint">
								{l10n.t("Second credentials sent beside the OAuth bearer, for gateways that check two at once.")}
							</p>
							<SecretField field="apiKey" help={helpOauthCompanionApiKey()} props={props} />
							{virtualKeyPair}
						</details>
					</>
				) : null}
				{storedApiKeyOrphan || storedVkOrphan || storedOauthSecretOrphan ? (
					<div className="stored-auth">
						{storedApiKeyOrphan ? (
							<p className="hint state-warn">
								{l10n.t(
									"A stored API key still activates the bearer on this shape; use its Remove checkbox to stop sending it."
								)}
							</p>
						) : null}
						{storedVkOrphan ? (
							<p className="hint state-warn">
								{l10n.t("A stored virtual key value is still attached; remove it below, or pick a form that sends it.")}
							</p>
						) : null}
						{storedOauthSecretOrphan ? (
							<p className="hint state-warn">
								{l10n.t(
									"A stored OAuth client secret is still attached; remove it below, or switch the form to OAuth."
								)}
							</p>
						) : null}
						<details open={storedOpen} onToggle={(event) => setStoredOpen(event.currentTarget.open)}>
							<summary>{l10n.t("Stored credentials")}</summary>
							{storedApiKeyOrphan ? <StoredSecretRow field="apiKey" props={props} /> : null}
							{storedVkOrphan ? <StoredSecretRow field="virtualKeyValue" props={props} /> : null}
							{storedOauthSecretOrphan ? <StoredSecretRow field="oauthClientSecret" props={props} /> : null}
						</details>
					</div>
				) : null}
			</fieldset>
			<details open={paramsOpen} onToggle={(event) => setParamsOpen(event.currentTarget.open)}>
				<summary>
					{l10n.t("Model parameters for this server (optional)")} <Help text={serverFieldHelp("modelParameters")} />
				</summary>
				<p className="hint">
					{l10n.t(
						"Sent only with requests routed through this entry; overrides the global Model parameters setting for the same keys. Keys match model IDs: gpt-4 exactly, gpt-4* for the family, /regex/ or * for broader sets - the most specific match wins."
					)}
				</p>
				{draft.modelParameters.length > 0 ? (
					<RecordMatcherTable
						kind="params"
						groups={draft.modelParameters}
						issues={entryParamIssueViews}
						disabled={saving}
						onChange={(next) => props.patch({ modelParameters: next })}
						onOpenEditor={(index) => setMatcherEditor({ kind: "params", index })}
					/>
				) : null}
				<Button
					variant="secondary"
					id="server-params-add"
					disabled={saving}
					onClick={() => {
						// setDraft, not patch: appending the empty group is structural,
						// and the pristine sweep undoes it without arming the confirm.
						setDraft((current) => ({
							...current,
							modelParameters: [...current.modelParameters, { prefix: "", params: [] }],
						}));
						setMatcherEditor({ kind: "params", index: draft.modelParameters.length });
					}}
				>
					<IconAdd /> {l10n.t("Add model matcher")}
				</Button>
			</details>
			<details open={capsOpen} onToggle={(event) => setCapsOpen(event.currentTarget.open)}>
				<summary>
					{l10n.t("Model capabilities for this server (optional)")} <Help text={serverFieldHelp("modelCapabilities")} />{" "}
					<DocsLink href={DOCS_LINK_MODEL_CAPABILITIES} label={l10n.t("Open the model capabilities guide")} />
				</summary>
				<p className="hint">
					{l10n.t(
						"Corrects what discovery reports for matching models, e.g. context_length 128000. Your values beat server-reported ones unless marked fallback."
					)}
				</p>
				{draft.modelCapabilities.length > 0 ? (
					<RecordMatcherTable
						kind="caps"
						groups={draft.modelCapabilities}
						issues={entryCapIssueViews}
						disabled={saving}
						keySuggestions={entryCapabilityKeySuggestions}
						onChange={(next) => props.patch({ modelCapabilities: next })}
						onOpenEditor={(index) => setMatcherEditor({ kind: "caps", index })}
					/>
				) : null}
				<Button
					variant="secondary"
					id="server-caps-add"
					disabled={saving}
					onClick={() => {
						// setDraft, not patch: see the parameters twin above.
						setDraft((current) => ({
							...current,
							modelCapabilities: [...current.modelCapabilities, { prefix: "", params: [] }],
						}));
						setMatcherEditor({ kind: "caps", index: draft.modelCapabilities.length });
					}}
				>
					<IconAdd /> {l10n.t("Add capability matcher")}
				</Button>
			</details>
			<details open={discoveryOpen} onToggle={(event) => setDiscoveryOpen(event.currentTarget.open)}>
				{/* The two controls for what discovery cannot see, side by side:
				    declared IDs plus expected failures are the recipe for a gateway
				    with no discovery at all. */}
				<summary>{l10n.t("Discovery (optional)")}</summary>
				<div className="field">
					<span className="label-row">
						<label htmlFor="server-declaredModels">{serverFormFieldLabel("declaredModels")}</label>
						<Help text={serverFieldHelp("declaredModels")} />
						<DocsLink href={DOCS_LINK_DECLARED_MODELS} label={l10n.t("Open the declared models guide")} />
					</span>
					<textarea
						id="server-declaredModels"
						rows={3}
						placeholder={l10n.t("One model ID per line, e.g. deepseek-r1")}
						value={draft.declaredModels}
						disabled={saving}
						onChange={(event) => props.patch({ declaredModels: event.currentTarget.value })}
					/>
					<span className="hint">{l10n.t("IDs are exact; a declaration goes inert once discovery lists the ID.")}</span>
				</div>
				<fieldset className="expected-failures">
					<legend className="label-row">
						{serverFormFieldLabel("expectedFailures")} <Help text={serverFieldHelp("expectedFailures")} />
					</legend>
					<p className="hint">
						{l10n.t(
							"Discovery endpoints this server is known to lack: marked failures log quietly, skip retries, and never count as errors."
						)}
					</p>
					{EXPECTED_FAILURE_CATEGORIES.map((category) => (
						<label key={category} className="setting-check">
							<Checkbox
								checked={draft.expectedFailures.includes(category)}
								disabled={saving}
								onChange={(event) =>
									props.patch({
										expectedFailures: toggleExpectedFailure(
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
				</fieldset>
			</details>
			<details open={headersOpen} onToggle={(event) => setHeadersOpen(event.currentTarget.open)}>
				<summary>
					{l10n.t("Custom headers (optional)")} <Help text={serverFieldHelp("headers")} />
				</summary>
				<p className="hint">
					{l10n.t(
						"Attached to every request to this server, e.g. routing or tracing tags. The entry's auth headers win conflicts; values sit in plain text in settings.json - credentials belong in Authentication above."
					)}
				</p>
				<HeaderRowsEditor
					rows={draft.headers}
					problems={headerRowProblems}
					disabled={saving}
					onChange={(next) => props.patch({ headers: next })}
				/>
			</details>
			<TextField field="budget" placeholder={l10n.t("e.g. 50")} props={props} />
			<p className="hint">
				{l10n.t(
					"Saved to the litellm-vscode-chat.servers user setting and synced to VS Code automatically. Secrets left empty or unedited keep their current value."
				)}
			</p>
			<div className="toolbar">
				<Button disabled={phase.phase !== "editing"} onClick={save}>
					{saving ? (
						<>
							<span className="spinner" aria-hidden="true" /> {l10n.t("Saving...")}
						</>
					) : (
						l10n.t("Save")
					)}
				</Button>
				<Button variant="secondary" onClick={onCancel}>
					{l10n.t("Cancel")}
				</Button>
				{/* Probes the draft as typed, saved or not. Disabled only while the
				    base URL is unusable or a probe/save is in flight; Cancel stays
				    live throughout - an abandoned probe's outcome is simply ignored. */}
				<Button
					variant="secondary"
					disabled={!isUsableHttpUrl(draft.baseUrl.trim()) || testState.kind === "testing" || saving}
					onClick={testConnection}
				>
					{testState.kind === "testing" ? (
						<>
							<span className="spinner" aria-hidden="true" /> {l10n.t("Testing...")}
						</>
					) : (
						l10n.t("Test connection")
					)}
				</Button>
				{phase.phase === "prefill" ? <span className="hint">{l10n.t("Loading stored values...")}</span> : null}
				{firstBlocking !== undefined ? (
					<span className="error" role="alert">
						{l10n.t("Cannot save: fix {0}", serverFormFieldLabel(firstBlocking))}
					</span>
				) : null}
				{testState.kind === "pass" ? (
					<span className="test-result state-ok" role="status">
						{testState.text}
					</span>
				) : null}
				{testState.kind === "fail" ? (
					<span className="test-result error" role="alert">
						{testState.text}
						{testState.classification?.setupHint !== undefined ? (
							// A classified setup problem: the link to its matching
							// troubleshooting-guide section rides inside the alert so one
							// announcement carries the failure and the way out. The leading
							// space keeps copied text from gluing the link label onto the
							// error message.
							<>
								{" "}
								<span className="test-hint">
									<DocsLink {...troubleshootingLink(testState.classification.setupHint)}>
										{l10n.t("Troubleshoot")}
									</DocsLink>
								</span>
							</>
						) : null}
					</span>
				) : null}
			</div>
			{matcherEditorView}
		</div>
	);
}

/**
 * The adopt form: turns an external provider group into a declared servers
 * entry. Credentials exist extension-side only, so instead of secret inputs
 * the form offers one storage choice per secret field; the posted intent
 * carries the label, the source row's identity, and those choices - never a
 * credential value. The round trip lives in ServersSection (pendingAdopt):
 * the section matches the ack or failure by requestId, so the form closes
 * freely while the intent is in flight and the outcome still lands as the
 * section's notice or banner.
 */
function AdoptForm({
	server,
	declaredLabels,
	saving,
	onUserEdit,
	onAdoptPosted,
	onCancel,
}: {
	server: ExternalDashboardServer;
	declaredLabels: readonly string[];
	/** Whether this form instance's adopt intent is in flight; disables the inputs against a double submit. */
	saving: boolean;
	/** Reports the first user edit; the slide-over's close-with-confirm keys on it. */
	onUserEdit: () => void;
	/** Hands the posted intent's requestId to the section, which owns the round trip. */
	onAdoptPosted: (requestId: string) => void;
	onCancel: () => void;
}) {
	const [label, setLabel] = useState(server.label);
	const [touched, setTouched] = useState(false);
	const [locations, setLocations] = useState<Record<SecretFieldId, "settings" | "secure">>({
		apiKey: "secure",
		oauthClientSecret: "secure",
		virtualKeyValue: "secure",
	});

	const problem = validateAdoptLabel(label, declaredLabels);
	const showProblem = problem !== undefined && (touched || label.trim() !== server.label);

	const adopt = () => {
		if (saving) {
			return;
		}
		if (problem !== undefined) {
			setTouched(true);
			return;
		}
		const requestId = sendRequest("adoptServer", {
			label: label.trim(),
			baseUrl: server.baseUrl,
			// External rows always carry the handle; the FormTarget union
			// guarantees only external rows reach this form.
			sourceHandle: server.adoptHandle,
			secrets: locations,
		});
		onAdoptPosted(requestId);
	};

	// Which secret rows to offer: hasApiKey is coarse (the provider reports it
	// for OAuth-only groups too, as "authentication configured"), so the key
	// row drops out only when the group demonstrably holds no credentials at
	// all, and every row states its own condition instead of promising a copy
	// that may not exist.
	const secretRows: readonly { field: SecretFieldId; hint: string }[] = [
		...(server.hasApiKey
			? [{ field: "apiKey" as const, hint: l10n.t("Copied only if the group has an API key.") }]
			: []),
		{ field: "oauthClientSecret" as const, hint: l10n.t("Copied only if the group is configured for OAuth.") },
		{ field: "virtualKeyValue" as const, hint: l10n.t("Copied only if the group sends a virtual key header.") },
	];

	return (
		<div className="form-card">
			<h3 id="server-form-title">{l10n.t("Adopt {0}", server.label)}</h3>
			<p className="hint">
				{l10n.t(
					"Adopting writes this VS Code-managed group into the litellm-vscode-chat.servers setting, so it becomes editable here. Its credentials are copied inside the extension and never pass through this page."
				)}
			</p>
			<div className="field">
				<label htmlFor="adopt-label">{l10n.t("Label")}</label>
				<Input
					id="adopt-label"
					type="text"
					value={label}
					disabled={saving}
					aria-invalid={showProblem}
					aria-describedby={showProblem ? "adopt-label-error" : undefined}
					onChange={(event) => {
						onUserEdit();
						setLabel(event.currentTarget.value);
					}}
					onBlur={() => setTouched(true)}
				/>
				<span className="hint">
					{l10n.t(
						"Names the new entry and its provider group; usually worth renaming, since a name an existing VS Code group already uses cannot be synced."
					)}
				</span>
				{showProblem ? (
					<span id="adopt-label-error" className="error">
						{problem}
					</span>
				) : null}
			</div>
			<div className="field">
				<span className="field-label">{l10n.t("Base URL")}</span>
				<span className="readonly-value">{server.baseUrl}</span>
				<span className="hint">
					{l10n.t("Fixed to the group being adopted; edit the server afterwards to change it.")}
				</span>
			</div>
			{secretRows.map(({ field, hint }) => (
				<div className="field" key={field}>
					<span>{serverFormFieldLabel(field)}</span>
					<span className="hint">{hint}</span>
					<span
						className="secret-where"
						role="radiogroup"
						aria-label={l10n.t("Where to store the {0}", serverFormFieldLabel(field))}
					>
						<span className="where-label">{l10n.t("Store in:")}</span>
						<label>
							<Radio
								name={`adopt-${field}-where`}
								checked={locations[field] === "secure"}
								disabled={saving}
								onChange={() => {
									onUserEdit();
									setLocations((current) => ({ ...current, [field]: "secure" }));
								}}
							/>
							{l10n.t("secret storage")}
						</label>
						<label>
							<Radio
								name={`adopt-${field}-where`}
								checked={locations[field] === "settings"}
								disabled={saving}
								onChange={() => {
									onUserEdit();
									setLocations((current) => ({ ...current, [field]: "settings" }));
								}}
							/>
							{l10n.t("settings (visible)")}
						</label>
					</span>
				</div>
			))}
			<p className="hint">
				{l10n.t(
					"VS Code cannot remove the original group: its models appear twice until its object is deleted from the models file."
				)}
			</p>
			<div className="toolbar">
				<Button disabled={saving} onClick={adopt}>
					{saving ? (
						<>
							<span className="spinner" aria-hidden="true" /> {l10n.t("Adopting...")}
						</>
					) : (
						l10n.t("Adopt")
					)}
				</Button>
				{/* Cancel routes through the slide-over's discard policy; a pending
				    adopt never blocks it - the section owns the round trip. */}
				<Button variant="secondary" onClick={onCancel}>
					{l10n.t("Cancel")}
				</Button>
				{showProblem ? (
					<span className="error" role="alert">
						{l10n.t("Cannot adopt: fix Label")}
					</span>
				) : null}
			</div>
		</div>
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
	if (usage.spentFraction !== undefined) {
		return (
			<span className={`usage-cell tone-${barPresentation(usage.spentFraction, thresholds).tone}`}>
				{formatPercent(usage.spentFraction)}
			</span>
		);
	}
	return <span className="usage-cell">{formatUsd(usage.spend)}</span>;
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
}) {
	const confirmRemove = () => {
		sendRequest("removeServerSetting", { label: server.label });
		onArmRemove(false);
	};
	return (
		<tr>
			<td>{server.label}</td>
			<td className="url">{server.baseUrl}</td>
			<td data-label={l10n.t("Status")}>
				<StatusPill server={server} now={now} />
			</td>
			<td className="num" data-label={l10n.t("Models")}>
				{/* The count doubles as the bridge to the models section below:
				    clicking it scopes the list to this server. A zero stays plain
				    text, since an empty scoped list has nothing to show. */}
				{onShowModels !== undefined && server.modelCount > 0 ? (
					<Button
						variant="quiet"
						className="count-link px-1 py-0"
						aria-label={l10n.t("Show models from {0}", server.label)}
						onClick={() => onShowModels(server.label)}
					>
						{server.modelCount}
					</Button>
				) : (
					server.modelCount
				)}
			</td>
			<td className="num" data-label={l10n.t("Usage")}>
				<UsageCell usage={usage} thresholds={usageThresholds} />
			</td>
			<td>
				{/* The credential kind is the information, so it is the visible
				    text; a generic "auth" badge would hide it in a hover tip. */}
				{server.hasApiKey || server.hasOAuth ? <Badge>{server.hasOAuth ? "OAuth" : l10n.t("API key")}</Badge> : null}
				{server.origin === "external" ? (
					<HoverTip focusable tip={externalTip(server)}>
						<Badge>{l10n.t("external")}</Badge>
					</HoverTip>
				) : null}
				{/* Gated on expected: only expected failures fold the declared count
				    into the row's served models; an unexpected failure's declarations
				    are extension bookkeeping, and a badge beside a zero count would
				    contradict the row. */}
				{server.state === "error" && server.expected === true && (server.declaredModelCount ?? 0) > 0 ? (
					<HoverTip
						focusable
						tip={l10n.t(
							"Models declared in the entry's discovery.declared list; they keep serving while discovery fails."
						)}
					>
						<Badge>
							{(server.declaredModelCount ?? 0) === 1
								? l10n.t("1 declared model")
								: l10n.t("{0} declared models", server.declaredModelCount ?? 0)}
						</Badge>
					</HoverTip>
				) : null}
				{INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true).map((notice) => (
					<HoverTip key={notice} tip={INACTIVE_NOTICE_PRESENTATION[notice].tip()}>
						<Badge variant="warn">{INACTIVE_NOTICE_PRESENTATION[notice].badge()}</Badge>
					</HoverTip>
				))}
			</td>
			<td className={armed ? "actions armed" : "actions"}>
				{armed ? (
					<>
						<Button
							variant="danger"
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
						<Button variant="quiet" onClick={() => onArmRemove(false)}>
							{l10n.t("Cancel")}
						</Button>
					</>
				) : (
					<>
						{/* A misconfigured entry cannot round-trip through the edit form
						    without rewriting what the user typed, so its fix action
						    reveals the setting instead of opening the form. */}
						{server.origin === "misconfigured" ? (
							<Button variant="quiet" onClick={() => sendRequest("revealSetting", { setting: "servers" })}>
								{l10n.t("Fix in settings.json")}
							</Button>
						) : (
							<Button variant="quiet" onClick={onEdit}>
								{l10n.t("Edit")}
							</Button>
						)}
						{/* A legacy-registry external row is not hideable (the registry
						    path would keep serving its models), so it keeps Edit only. */}
						{server.origin === "declared" || server.origin === "misconfigured" || server.hideable ? (
							<Button variant="quiet" onClick={() => onArmRemove(true)}>
								{l10n.t("Remove")}
							</Button>
						) : null}
					</>
				)}
			</td>
		</tr>
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
	if (hidden.length === 0) {
		return null;
	}
	return (
		<div className="hidden-groups">
			<p className="hint">
				{hidden.length === 1 ? l10n.t("1 hidden group") : l10n.t("{0} hidden groups", hidden.length)} -{" "}
				<Button variant="quiet" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
					{expanded ? l10n.t("hide") : l10n.t("show")}
				</Button>
			</p>
			{expanded ? (
				<ul>
					{hidden.map((group) => (
						// Keyed by the identity pair the unhideServer intent posts.
						<li key={`${group.label}:${group.baseUrl}`}>
							<span className="hidden-label">{group.label}</span> <span className="url">{group.baseUrl}</span>{" "}
							<Button
								variant="quiet"
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
	editRequest,
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
	/** The inspectors' jump into a declared entry's edit form; see ServerEditRequest. */
	editRequest?: ServerEditRequest | undefined;
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
	// The form target survives state pushes (editing continues across a
	// background refresh). Keys come from a never-reused counter: a fresh key
	// per open forces a clean draft, and pendingAdopt's formKey scoping relies
	// on a closed form's key never coming back.
	const [form, setForm] = useState<{ target: FormTarget; key: number } | undefined>(undefined);
	const nextFormKey = useRef(1);
	// The slide-over's close policy: a dirty form asks before discarding.
	const [formDirty, setFormDirty] = useState(false);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	// The one-time post-adoption notice: the old host-owned group survives (no
	// removal API), so the user is told plainly why models now appear twice.
	const [adoptNotice, setAdoptNotice] = useState<string | undefined>(undefined);
	// The adopt round trips: each posted intent's requestId plus the posting
	// form instance's key. A list, not a slot: the form is freely closable
	// mid-adopt, so a second adopt can be in flight before the first ack lands,
	// and every ack must still deliver its post-adoption notice. The form key
	// scopes the follow-up close (and the form's saving state) to the instance
	// that posted, never a later form.
	const [pendingAdopts, setPendingAdopts] = useState<readonly { requestId: string; formKey: number }[]>([]);
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
	const noServers = servers.length === 0;
	// The two aggregate failure banners' entry lists, filtered once so the
	// separator logic can look at each entry's predecessor.
	const failingServers = servers.filter(
		(server) => server.origin !== "misconfigured" && server.error !== undefined && server.expected !== true
	);
	const expectedFailureServers = servers.filter((server) => server.error !== undefined && server.expected === true);

	const openForm = (target: FormTarget) => {
		setFormDirty(false);
		setConfirmingDiscard(false);
		const key = nextFormKey.current;
		nextFormKey.current += 1;
		setForm({ target, key });
	};

	// The inspectors' entry-jump: open the addressed declared entry's edit form
	// (its per-entry records live there). A label that no longer resolves to a
	// declared row is a no-op; keyed on the seq so repeating the jump re-opens.
	const editRequestSeq = editRequest?.seq;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on the seq alone so repeating the jump re-opens; the request and servers are read at fire time
	useEffect(() => {
		if (editRequest === undefined) {
			return;
		}
		const target = servers.find(
			(server): server is DeclaredDashboardServer => server.origin === "declared" && server.label === editRequest.label
		);
		if (target !== undefined) {
			openForm({ kind: "edit", original: target });
		}
	}, [editRequestSeq]);

	const closeForm = () => {
		setForm(undefined);
		setFormDirty(false);
		setConfirmingDiscard(false);
	};

	// Every way out of an open form funnels through here: the form's Cancel,
	// the slide-over's X, the scrim, and Esc. One policy: on a dirty form,
	// toggle the discard confirm (so Esc while it shows means "keep editing" -
	// only the explicit Discard button destroys edits); otherwise close,
	// dismissing the form's stale failure notice with it.
	const discardForm = () => {
		if (form?.target.kind === "adopt") {
			adoptIntent.reset();
		} else {
			saveIntent.reset();
		}
		closeForm();
	};
	const requestCloseForm = () => {
		if (formDirty) {
			setConfirmingDiscard((current) => !current);
			return;
		}
		discardForm();
	};

	// A pending adopt's own ack: compose the post-adoption notice (plus the
	// extension's optional caveat) and close the posting form when it is still
	// the one open. A later or already-closed form is left alone.
	const adoptOutcome = adoptIntent.outcome;
	const ackedAdopt =
		adoptOutcome?.result === "ok" ? pendingAdopts.find((pending) => pending.requestId === adoptOutcome.id) : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: closeForm is a stable setter bundle; the deps that decide whether the ack applies are listed
	useEffect(() => {
		if (ackedAdopt === undefined || adoptOutcome?.result !== "ok") {
			return;
		}
		const base = l10n.t(
			"Adopted into the servers setting. Models appear twice until the original group's object is deleted: open the models file, remove it, reload the window."
		);
		setAdoptNotice(adoptOutcome.message !== undefined ? `${base} ${adoptOutcome.message}` : base);
		setPendingAdopts((current) => current.filter((pending) => pending.requestId !== ackedAdopt.requestId));
		if (form?.key === ackedAdopt.formKey) {
			closeForm();
		}
	}, [adoptOutcome, ackedAdopt, form]);

	// A pending adopt's own failure: a validation-kind one returns the still
	// open form to editing (removing the pending entry re-enables it); an
	// operation-kind one committed its write, so the stale form closes and the
	// section banner carries the recovery path.
	const failedAdopt =
		adoptFailure !== undefined ? pendingAdopts.find((pending) => pending.requestId === adoptFailure.id) : undefined;
	const adoptFailureKind = adoptFailure?.failureKind;
	// biome-ignore lint/correctness/useExhaustiveDependencies: closeForm is a stable setter bundle; the deps that decide whether the failure applies are listed
	useEffect(() => {
		if (failedAdopt === undefined) {
			return;
		}
		setPendingAdopts((current) => current.filter((pending) => pending.requestId !== failedAdopt.requestId));
		if (saveFailureDisposition(adoptFailureKind ?? "validation") === "close" && form?.key === failedAdopt.formKey) {
			closeForm();
		}
	}, [failedAdopt, adoptFailureKind, form]);

	// Misconfigured entries count: they occupy their label in the setting, so
	// a rename onto one or an adopt under one must be refused like any sibling.
	const declaredLabels = servers
		.filter((server) => server.origin === "declared" || server.origin === "misconfigured")
		.map((server) => server.label);

	// Usage is tracked per declared entry and keyed by its label (the usage
	// store's documented join key back to the server rows), so only declared
	// rows look it up; a URL spelling difference must not break the join.
	// Forbidden-usage cards carry no numbers, so they stay out of the join
	// and their rows show an empty cell; the Usage tab renders their story.
	const usageByLabel = new Map(
		(usage?.servers ?? []).flatMap((view) => (view.kind === "usage" ? [[view.label, view] as const] : []))
	);

	return (
		<section>
			<h2>
				{l10n.t("Servers")} <Help text={helpServersSection()} below />
				<DocsLink href={DOCS_LINK_SERVERS} label={l10n.t("Open the servers guide")} />
			</h2>
			{/* First run shows the guided card alone; a strip of mostly disabled
			    controls above it would put dead buttons before the guidance. */}
			{!noServers ? (
				<div className="toolbar">
					<Button onClick={() => openForm({ kind: "add" })}>
						<IconAdd /> {l10n.t("Add server")}
					</Button>
				</div>
			) : null}
			{form !== undefined ? (
				<SlideOver
					labelledBy="server-form-title"
					fallbackFocusId="tab-overview"
					confirming={confirmingDiscard}
					onRequestClose={requestCloseForm}
					onKeepEditing={() => setConfirmingDiscard(false)}
					onDiscard={discardForm}
				>
					{form.target.kind === "adopt" ? (
						<AdoptForm
							key={form.key}
							server={form.target.server}
							declaredLabels={declaredLabels}
							saving={pendingAdopts.some((pending) => pending.formKey === form.key)}
							onUserEdit={() => setFormDirty(true)}
							onAdoptPosted={(requestId) =>
								setPendingAdopts((current) => [...current, { requestId, formKey: form.key }])
							}
							onCancel={requestCloseForm}
						/>
					) : (
						<ServerForm
							key={form.key}
							target={form.target}
							declaredLabels={declaredLabels}
							observedModelInfoKeys={observedKeysForForm(servers, form.target)}
							onUserEdit={() => setFormDirty(true)}
							onClose={closeForm}
							onCancel={requestCloseForm}
						/>
					)}
				</SlideOver>
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
						<Button variant="quiet" onClick={() => setRemovedNotice(undefined)}>
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
						<Button variant="quiet" onClick={() => setAdoptNotice(undefined)}>
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
					<Button variant="quiet" onClick={adoptIntent.reset}>
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
					<Button variant="quiet" onClick={saveIntent.reset}>
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
					<Button variant="quiet" onClick={removeIntent.reset}>
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
					<Button variant="quiet" onClick={hideIntent.reset}>
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
					<Button variant="quiet" onClick={unhideIntent.reset}>
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
					<Button onClick={() => openForm({ kind: "add" })}>{l10n.t("Add your first server")}</Button>
				</div>
			) : (
				<div className="table-scroll">
					{/* className="servers": the narrow-viewport stylesheet stacks these rows
					    into cards so the row actions stay reachable. */}
					<table className="servers">
						<thead>
							<tr>
								<th>{l10n.t("Server")}</th>
								<th>{l10n.t("Base URL")}</th>
								<th>{l10n.t("Status")}</th>
								<th className="num">{l10n.t("Models")}</th>
								<th className="num">{l10n.t("Usage")}</th>
								<th>{/* badges */}</th>
								<th>{/* actions */}</th>
							</tr>
						</thead>
						<tbody>
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
										// The one place the form's purpose is decided: a declared
										// row edits, an external row adopts. A misconfigured row
										// renders no Edit at all (its shape cannot round-trip the
										// form); the guard keeps the narrowing honest.
										if (server.origin === "misconfigured") {
											return;
										}
										openForm(
											server.origin === "declared" ? { kind: "edit", original: server } : { kind: "adopt", server }
										);
									}}
									onArmRemove={(armed) => setArmedRemove(armed ? server.label : undefined)}
									onHideExternal={hideExternal}
									onShowModels={onShowModels}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
			<HiddenGroupsLine hidden={hidden} />
			{failingServers.length > 0 ? (
				<div className="banner banner-error">
					<p className="error">
						{failingServers.map((server, index) => {
							// Keyed identity (origin plus the external row's opaque handle
							// or the declared row's setting-unique label) so reconciliation
							// keeps focus on a Troubleshoot link when an earlier entry
							// recovers. A classified failure carries the same short
							// Troubleshoot link as the draft-test footer, inline after its
							// own entry's HEADLINE (the link must not drift below a detail
							// line); a two-part error's technical detail renders as its own
							// dimmed line after the link. The "; " separator joins inline
							// entries only: after a block detail line the next entry starts
							// on its own line, and a leading "; " there would dangle.
							const detail = statusErrorDetail(server.error ?? "");
							const afterDetail = index > 0 && statusErrorDetail(failingServers[index - 1]?.error ?? "") !== undefined;
							return (
								<Fragment key={`${server.origin}:${server.adoptHandle ?? server.label}`}>
									{index > 0 && !afterDetail ? "; " : ""}
									{`${server.label}: ${statusErrorHeadline(server.error ?? "")}`}
									{server.classification?.setupHint !== undefined ? (
										// The leading space keeps copied text (the banner is the
										// selectable error surface) from gluing the link label
										// onto the error message.
										<>
											{" "}
											<span className="banner-hint">
												<DocsLink {...troubleshootingLink(server.classification.setupHint)}>
													{l10n.t("Troubleshoot")}
												</DocsLink>
											</span>
										</>
									) : null}
									{detail !== undefined ? <span className="failure-detail">{detail}</span> : null}
								</Fragment>
							);
						})}
					</p>
				</div>
			) : null}
			{servers.some((server) => server.origin === "misconfigured") ? (
				<div className="banner banner-error">
					<p className="error">
						{servers
							.filter((server): server is MisconfiguredDashboardServer => server.origin === "misconfigured")
							.map((server, index) => (
								<Fragment key={server.label}>
									{index > 0 ? "; " : ""}
									{/* The parser's structural reports stay English by policy
									    (they land in issue reports); only the framing localizes. */}
									{l10n.t(
										"{0}: this entry is invalid and not used until fixed - {1}",
										server.label,
										server.problems.join("; ")
									)}
								</Fragment>
							))}
					</p>
					<p className="hint">
						{l10n.t("Keep exactly one auth form per entry; companions of lower rank only.")}{" "}
						<DocsLink href={DOCS_LINK_AUTHENTICATION} label={l10n.t("Open the authentication guide")}>
							{l10n.t("Learn more")}
						</DocsLink>
					</p>
				</div>
			) : null}
			{expectedFailureServers.length > 0 ? (
				<div className="banner banner-warn">
					<p className="state-warn">
						{expectedFailureServers.map((server, index) => {
							// Warn tone, never the red banner: the entry declared this
							// category, so the failure is stated with its localized
							// annotation instead of raised as a problem. Separators join
							// inline entries only (see the error banner above).
							const afterDetail =
								index > 0 && statusErrorDetail(expectedFailureServers[index - 1]?.error ?? "") !== undefined;
							return (
								<Fragment key={`${server.origin}:${server.adoptHandle ?? server.label}`}>
									{index > 0 && !afterDetail ? "; " : ""}
									<FailureText
										message={server.error ?? ""}
										frame={(headline) => l10n.t("{0}: {1} (expected)", server.label, headline)}
									/>
								</Fragment>
							);
						})}
					</p>
				</div>
			) : null}
			{servers.some((server) => INACTIVE_NOTICES.some((notice) => server.notices?.includes(notice) === true)) ? (
				<div className="banner banner-warn">
					<p className="state-warn">
						{/* One banner for every inactive entry-only surface: the cause and
						    the two-step fix are identical, so per-surface twin banners
						    would only repeat them. */}
						{servers
							.filter((server) => INACTIVE_NOTICES.some((notice) => server.notices?.includes(notice) === true))
							.map((server) => `${server.label}: ${inactiveSurfacesText(server)}`)
							.join("; ")}{" "}
						{l10n.t("are not applied: the group serving the entry predates its label or a rename. To activate them:")}{" "}
						<DocsLink href={DOCS_LINK_PARAMS_INACTIVE} label={l10n.t("Learn more in the troubleshooting guide")}>
							{l10n.t("Learn more")}
						</DocsLink>
					</p>
					<ol className="notice-steps">
						<li>{l10n.t("Delete the group's object from the models file (chatLanguageModels.json).")}</li>
						<li>
							{l10n.t("Reload the window, then run Sync Models Now - or save the entry under a new label instead.")}
						</li>
					</ol>
				</div>
			) : null}
			{servers.some((server) => server.notices?.includes("expected-failures-nothing-declared") === true) ? (
				<div className="banner banner-warn">
					<p className="state-warn">
						{l10n.t(
							"{0}: discovery fails in an expected category and nothing is declared, so no models are served. Add IDs to the entry's discovery.declared list to serve models without discovery.",
							servers
								.filter((server) => server.notices?.includes("expected-failures-nothing-declared") === true)
								.map((server) => server.label)
								.join(", ")
						)}
					</p>
				</div>
			) : null}
		</section>
	);
}
