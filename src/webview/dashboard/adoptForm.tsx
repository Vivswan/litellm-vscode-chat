/**
 * Credentials exist extension-side only, so the form offers one storage choice per secret field and the intent
 * carries no credential value. ServerEditPage owns the round trip, and servers.tsx watches the same envelope for its notice.
 */
import * as l10n from "@vscode/l10n";
import { useState } from "react";
import { serverFormFieldLabel, validateAdoptLabel } from "../../dashboard/serverForm";
import type { ExternalDashboardServer } from "../../dashboard/viewModels";
import type { SecretFieldId } from "../../shared/serverEntry";
import { BackToServers } from "./backToServers";
import { helpAdoptionSection } from "./helpText";
import { COMMIT_BAR_CLASS, FieldRow, FieldSpan, FormSection } from "./serverFormFields";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Radio } from "./ui/radio";
import { SectionHeader } from "./ui/section";
import { sendRequest } from "./vscodeApi";

export function AdoptForm({
	server,
	declaredLabels,
	saving,
	onDirtyChange,
	onAdoptPosted,
	onRequestClose,
}: {
	server: ExternalDashboardServer;
	declaredLabels: readonly string[];
	saving: boolean;
	onDirtyChange: (dirty: boolean) => void;
	/** Hands the posted intent's requestId to the page, which owns the round trip. */
	onAdoptPosted: (requestId: string) => void;
	onRequestClose: () => void;
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
			sourceHandle: server.adoptHandle,
			secrets: locations,
		});
		onAdoptPosted(requestId);
	};

	// The credential verdict is coarse (reported for OAuth-only groups too), so the key row drops
	// out only when the group demonstrably holds no credentials; every row states its own condition.
	const secretRows: readonly { field: SecretFieldId; hint: string }[] = [
		...(server.credentials === "present"
			? [{ field: "apiKey" as const, hint: l10n.t("Copied only if the group has an API key.") }]
			: []),
		{ field: "oauthClientSecret" as const, hint: l10n.t("Copied only if the group is configured for OAuth.") },
		{ field: "virtualKeyValue" as const, hint: l10n.t("Copied only if the group sends a virtual key header.") },
	];

	return (
		<div className="form-card server-form">
			<BackToServers onRequestClose={onRequestClose} />
			{/* The edit form's header primitive without a docs slot; the 24px above restated for the
			    same no-<section> reason. */}
			<SectionHeader titleId="server-form-title" level={3} title={l10n.t("Adopt {0}", server.label)} className="mt-6" />
			<FormSection title={l10n.t("Adoption")} help={helpAdoptionSection()}>
				<FieldRow
					htmlFor="adopt-label"
					label={l10n.t("Label")}
					hint={l10n.t(
						"Names the new entry and its provider group; rename it if a VS Code group already uses the name."
					)}
					problem={showProblem ? problem : undefined}
					errorId="adopt-label-error"
				>
					<Input
						id="adopt-label"
						type="text"
						className="min-w-0 flex-1"
						value={label}
						disabled={saving}
						aria-invalid={showProblem}
						aria-describedby="adopt-label-error"
						onChange={(event) => {
							onDirtyChange(true);
							setLabel(event.currentTarget.value);
						}}
						onBlur={() => setTouched(true)}
					/>
				</FieldRow>
				<FieldRow label={l10n.t("Base URL")} hint={l10n.t("Editable after adopting.")}>
					{/* Plain dimmed text, never a disabled input, because a value that cannot
					    be edited here must not look like one that merely refused. */}
					<span className="readonly-value font-mono text-[12px] break-all text-muted-foreground">{server.baseUrl}</span>
				</FieldRow>
				{secretRows.map(({ field, hint }) => (
					<FieldRow label={serverFormFieldLabel(field)} hint={hint} key={field}>
						<span
							className="secret-where flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground"
							role="radiogroup"
							aria-label={l10n.t("Where to store the {0}", serverFormFieldLabel(field))}
						>
							<span className="where-label @max-[700px]/pane:basis-full">{l10n.t("Store in:")}</span>
							<label className="flex items-center gap-1.5">
								<Radio
									name={`adopt-${field}-where`}
									checked={locations[field] === "secure"}
									disabled={saving}
									onChange={() => {
										onDirtyChange(true);
										setLocations((current) => ({ ...current, [field]: "secure" }));
									}}
								/>
								{l10n.t("secret storage")}
							</label>
							<label className="flex items-center gap-1.5">
								<Radio
									name={`adopt-${field}-where`}
									checked={locations[field] === "settings"}
									disabled={saving}
									onChange={() => {
										onDirtyChange(true);
										setLocations((current) => ({ ...current, [field]: "settings" }));
									}}
								/>
								{l10n.t("settings (visible)")}
							</label>
						</span>
					</FieldRow>
				))}
				<FieldSpan>
					<p className="hint m-0 text-[11.5px]">
						{l10n.t("The original group survives: its models appear twice until you delete it from the models file.")}
					</p>
				</FieldSpan>
			</FormSection>
			<div className={COMMIT_BAR_CLASS}>
				<Button disabled={saving} onClick={adopt}>
					{saving ? (
						<>
							<span className="spinner" aria-hidden="true" /> {l10n.t("Adopting...")}
						</>
					) : (
						l10n.t("Adopt")
					)}
				</Button>
				{/* Cancel routes through the shell's discard policy; a pending
				    adopt never blocks it, because the page owns the round trip. */}
				<Button variant="secondary" onClick={onRequestClose}>
					{l10n.t("Cancel")}
				</Button>
				{showProblem ? (
					<span className="error text-[11.5px]" role="alert">
						{l10n.t("Cannot adopt: fix Label")}
					</span>
				) : null}
			</div>
		</div>
	);
}
