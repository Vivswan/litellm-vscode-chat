/**
 * The capability inspector: a read-only slide-over stating what one model can
 * do and where each fact came from. The paramsInspector's twin with one
 * structural difference: parameters project from data the state push already
 * carries, but capabilities resolve against extension-side stores (the server
 * baseline, the OpenRouter catalog), so this page is request/response-fed -
 * it posts readModelCapabilities on open and renders the
 * EffectiveCapabilities the extension resolves with the SAME walk
 * registration runs. No resolver logic and no catalog data live in the
 * webview; the answer is data.
 */

import * as l10n from "@vscode/l10n";
import { useEffect, useState } from "preact/hooks";
import type {
	CapabilityDiagnostic,
	CapabilityFieldName,
	CapabilityLevel,
	DashboardModel,
	EffectiveCapabilities,
	EffectiveCapabilityField,
	ExtensionToWebviewMessage,
	ShadowedCapabilityValue,
} from "../../extension/dashboard/protocol";
import { CAPABILITY_FIELDS, FALLBACK_DIRECTIVE } from "../../extension/dashboard/protocol";
import { DOCS_LINK_CAPS_INSPECTOR } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpCapsInspector } from "./helpText";
import { formatTokens } from "./models";
import { RecordChainFigure } from "./recordChain";
import { SlideOver } from "./slideOver";
import { newRequestId, postMessage } from "./vscodeApi";

/** The latest modelCapabilities response; the inspector matches it against its own request ID. */
export type ModelCapabilitiesResponse = Extract<ExtensionToWebviewMessage, { type: "modelCapabilities" }>;

/** The capability fields in display order: the token trio, then the support flags. */
const FIELD_ORDER: readonly CapabilityFieldName[] = [
	"context_length",
	"max_input_tokens",
	"max_output_tokens",
	"supports_function_calling",
	"supports_vision",
	"supports_reasoning",
	"supports_audio_input",
];

/** A capability field's display name, resolved at call time (no module-level localized constants). */
function fieldLabel(name: CapabilityFieldName): string {
	switch (name) {
		case "context_length":
			return l10n.t("Context length");
		case "max_input_tokens":
			return l10n.t("Max input tokens");
		case "max_output_tokens":
			return l10n.t("Max output tokens");
		case "supports_function_calling":
			return l10n.t("Tool calling");
		case "supports_vision":
			return l10n.t("Vision");
		case "supports_reasoning":
			return l10n.t("Reasoning");
		case "supports_audio_input":
			return l10n.t("Audio input");
	}
}

function formatValue(name: CapabilityFieldName, value: number | boolean): string {
	if (typeof value === "boolean") {
		return value ? l10n.t("yes") : l10n.t("no");
	}
	return CAPABILITY_FIELDS[name] === "number" ? formatTokens(value) : String(value);
}

/** The Source column's naming: the precedence level that set the value plus its winning key. */
function levelName(level: CapabilityLevel, key: string | undefined): string {
	switch (level) {
		case "entry":
			return l10n.t("Server entry - {0}", key ?? "");
		case "global":
			return l10n.t("Settings - {0}", key ?? "");
		case "directive":
			return l10n.t("OpenRouter catalog (via _openrouter_model {0})", key ?? "");
		case "server":
			return l10n.t("Server-reported");
		case "entry-fallback":
			return l10n.t("Server entry fallback - {0}", key ?? "");
		case "global-fallback":
			return l10n.t("Settings fallback - {0}", key ?? "");
		case "catalog":
			return l10n.t("OpenRouter catalog match {0}", key ?? "");
		case "derived":
			return l10n.t("Derived (context length minus output tokens)");
		case "floor":
			return l10n.t("Built-in default");
	}
}

function ShadowedLine({ name, shadow }: { name: CapabilityFieldName; shadow: ShadowedCapabilityValue }) {
	return (
		<tr class="param-shadowed">
			<td />
			<td class="param-value">{formatValue(name, shadow.value)}</td>
			<td>{l10n.t("overridden: {0}", levelName(shadow.level, shadow.key))}</td>
		</tr>
	);
}

function FieldRow({
	name,
	field,
	onEditField,
}: {
	name: CapabilityFieldName;
	field: EffectiveCapabilityField<number | boolean>;
	/** The per-row jump to the record that owns the value; renders only on record-sourced rows. */
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	const editable =
		onEditField !== undefined &&
		field.key !== undefined &&
		(field.level === "entry" ||
			field.level === "global" ||
			field.level === "entry-fallback" ||
			field.level === "global-fallback");
	return (
		<>
			<tr>
				<td class="param-name">{fieldLabel(name)}</td>
				<td class="param-value">{formatValue(name, field.value)}</td>
				<td>
					{levelName(field.level, field.key)}
					{editable ? (
						<button
							type="button"
							class="quiet row-edit"
							aria-label={l10n.t('Edit record "{0}"', field.key ?? "")}
							onClick={() => onEditField?.(field.level, field.key ?? "")}
						>
							{l10n.t("edit")}
						</button>
					) : null}
					{field.inheritedFrom !== undefined ? (
						<span class="param-skip"> ({l10n.t("inherited from {0}", field.inheritedFrom)})</span>
					) : null}
				</td>
			</tr>
			{field.shadowed.map((shadow) => (
				<ShadowedLine key={`${shadow.level}/${shadow.key ?? ""}`} name={name} shadow={shadow} />
			))}
		</>
	);
}

/** One record diagnostic as prose; classifications and the offending keys, never values. */
function diagnosticText(diagnostic: CapabilityDiagnostic): string {
	const where =
		diagnostic.layer === "entry"
			? l10n.t("server entry key {0}", diagnostic.recordKey)
			: l10n.t("settings key {0}", diagnostic.recordKey);
	switch (diagnostic.kind) {
		case "unknown-key":
			return l10n.t('"{0}" is not a known capability field ({1})', diagnostic.key, where);
		case "invalid-value":
			return l10n.t('"{0}" has an invalid value and is ignored ({1})', diagnostic.key, where);
		case "invalid-matcher":
			return l10n.t(
				'"{0}" is not a valid matcher key and never matches: use an exact ID, a trailing-* glob, /regex/, or "*" ({1})',
				diagnostic.key,
				where
			);
		case "wrong-record-type":
			return l10n.t('"{0}" belongs to parameters records and is ignored here ({1})', diagnostic.key, where);
		case "unknown-inherit-key":
			return l10n.t(
				'"_inherit_from" names "{0}", which is not a key of this record; the rest still applies ({1})',
				diagnostic.key,
				where
			);
		case "unforceable-key":
		case "invalid-directive":
			// `_fallback` gets its own copy: the same diagnostic covers a malformed
			// value and bad list entries (the valid ones still apply), so the
			// sentence names the rules without overclaiming.
			if (diagnostic.key === FALLBACK_DIRECTIVE) {
				return l10n.t(
					'"{0}" must be true or a list of fields the record sets, e.g. ["context_length"]; offending marks are ignored ({1})',
					diagnostic.key,
					where
				);
			}
			return l10n.t('"{0}" carries an invalid directive value and is ignored ({1})', diagnostic.key, where);
	}
}

function outputLimitNote(capabilities: EffectiveCapabilities): string {
	switch (capabilities.outputLimitSource) {
		case "user":
			return l10n.t("The output limit is user-set; requests send it uncapped.");
		case "provider":
			return l10n.t("The output limit is server-declared; requests send it uncapped.");
		case "defaults":
			return l10n.t("The output limit is a default; requests cap max_tokens at 4096.");
	}
}

/**
 * The inspector body once the response landed: the provenance table, the
 * directive outcome, and the diagnostics.
 */
function CapsBody({
	capabilities,
	declared,
	onEditField,
}: {
	capabilities: EffectiveCapabilities;
	declared: boolean;
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	return (
		<>
			{declared ? (
				<p class="hint">
					{l10n.t("Declared model: created by the entry's declared list, not discovered on the server.")}
				</p>
			) : null}
			{capabilities.directive?.kind === "not-found" ? (
				<p class="state-warn" role="alert">
					{l10n.t(
						'OpenRouter model "{0}" was not found in the catalog; its fields fill from the remaining levels.',
						capabilities.directive.id
					)}
				</p>
			) : null}
			<table class="params">
				<thead>
					<tr>
						<th>{l10n.t("Capability")}</th>
						<th>{l10n.t("Value")}</th>
						<th>{l10n.t("Source")}</th>
					</tr>
				</thead>
				<tbody>
					{FIELD_ORDER.map((name) => (
						<FieldRow key={name} name={name} field={capabilities.fields[name]} onEditField={onEditField} />
					))}
				</tbody>
			</table>
			<p class="params-max-tokens">
				<span class="hint">{outputLimitNote(capabilities)}</span>
			</p>
			{capabilities.diagnostics.length > 0 ? (
				<div class="params-replaced">
					<p class="hint">{l10n.t("Configuration problems in the matched records:")}</p>
					<ul>
						{capabilities.diagnostics.map((diagnostic) => (
							<li key={`${diagnostic.layer}/${diagnostic.recordKey}/${diagnostic.key}`}>
								{diagnosticText(diagnostic)}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</>
	);
}

export function CapsInspector({
	model,
	response,
	stateSeq,
	fallbackFocusId = "models-section",
	onClose,
	onEditRecord,
	onEditEntry,
}: {
	model: DashboardModel;
	/** The latest modelCapabilities response App holds; matched against this inspector's own requestId. */
	response: ModelCapabilitiesResponse | undefined;
	/** Bumped on every state push; the inspector re-requests so an open panel follows configuration edits. */
	stateSeq: number;
	/** Where focus lands on close when the opener is gone; the overlay's owner names a visible element (the active tab). */
	fallbackFocusId?: string;
	onClose: () => void;
	/** Jump into the global capabilities editor: focus record `key`, or create an exact-ID draft when `create`. */
	onEditRecord?: ((key: string, create: boolean) => void) | undefined;
	/** Jump into a server entry's edit form (the owner of entry-layer values). */
	onEditEntry?: ((label: string) => void) | undefined;
}) {
	const [requestId, setRequestId] = useState<string | undefined>(undefined);

	// One request per inspected model AND per state push: a configuration or
	// discovery change re-pushes state, and an open inspector must follow the
	// fresh resolution instead of showing pre-edit values; a stale response is
	// ignored by its requestId.
	const { scopeKey, rawId } = model;
	useEffect(() => {
		const id = newRequestId();
		setRequestId(id);
		postMessage({ type: "readModelCapabilities", scopeKey, rawId, requestId: id });
	}, [scopeKey, rawId, stateSeq]);

	const answered = requestId !== undefined && response?.requestId === requestId ? response : undefined;
	// The per-row jump: an entry-level value is owned by the server entry's own
	// record (edited in its form; entry records apply only when labels align,
	// so the group's label addresses the entry), a global one by the settings
	// record named in the row.
	const editField =
		onEditRecord === undefined
			? undefined
			: (level: CapabilityLevel, key: string) => {
					if (level === "entry" || level === "entry-fallback") {
						onEditEntry?.(model.serverLabel);
					} else {
						onEditRecord(key, false);
					}
				};
	return (
		<SlideOver
			labelledBy="caps-inspector-title"
			fallbackFocusId={fallbackFocusId}
			confirming={false}
			onRequestClose={onClose}
			onKeepEditing={onClose}
			onDiscard={onClose}
		>
			<div class="params-inspector caps-inspector">
				<h3 id="caps-inspector-title">
					{model.name} <Help text={helpCapsInspector()} name={l10n.t("About effective capabilities")} />{" "}
					<DocsLink href={DOCS_LINK_CAPS_INSPECTOR} label={l10n.t("Open the effective-capabilities guide")} />
				</h3>
				<p class="hint params-identity">
					{l10n.t({
						message: "{0} on {1}",
						args: [model.rawId, model.serverLabel],
						comment: ["{0} is a model ID, {1} is the server it is served from"],
					})}
				</p>
				<RecordChainFigure
					chains={answered?.chains}
					entryLabel={model.serverLabel}
					onEditRecord={onEditRecord === undefined ? undefined : (key) => onEditRecord(key, false)}
					onEditEntry={onEditEntry}
				/>
				{onEditRecord !== undefined ? (
					<p class="params-configure">
						<button
							type="button"
							class="secondary"
							disabled={answered === undefined}
							onClick={() => {
								// Reuse the most specific matching global record when one
								// exists; otherwise a fresh draft keyed by the exact model ID.
								const key = answered?.globalRecordKey;
								if (key !== undefined) {
									onEditRecord(key, false);
								} else {
									onEditRecord(model.rawId, true);
								}
							}}
						>
							{l10n.t("Configure capabilities for this model")}
						</button>
					</p>
				) : null}
				{answered === undefined ? (
					<p class="hint" role="status">
						{l10n.t("Resolving capabilities...")}
					</p>
				) : answered.capabilities === undefined ? (
					<p class="hint" role="status">
						{l10n.t("The model list changed; close and reopen the inspector.")}
					</p>
				) : (
					<CapsBody capabilities={answered.capabilities} declared={model.declared === true} onEditField={editField} />
				)}
			</div>
		</SlideOver>
	);
}
