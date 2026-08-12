/**
 * The inspectors' compact inheritance figure: one line per record map showing
 * the inspected model's matching chain broadest to winner - `* -> gpt-5*
 * [inheritance stops here] -> gpt-5.6` - with each key jumping into the
 * editor that owns it (a global key into the settings record editor, an entry
 * key into the server entry's form) and the barrier/exclusive-list markers
 * worded exactly as the Diagnostics tree words them. A chain of one record
 * tells no inheritance story and renders nothing.
 */

import * as l10n from "@vscode/l10n";
import type { RecordChainView } from "../../dashboard/viewModels";

/** The chains that tell an inheritance story; a chain of one record renders nothing. */
export function chainsWithStory(chains: readonly RecordChainView[] | undefined): readonly RecordChainView[] {
	return (chains ?? []).filter((chain) => chain.links.length >= 2);
}

export function RecordChainFigure({
	chains,
	onEditRecord,
	onEditEntry,
}: {
	/** The response's per-map chains; absent or single-link chains render nothing. */
	chains: readonly RecordChainView[] | undefined;
	/** Jump into the global record editor focused on the key; absent, keys render as plain text. */
	onEditRecord?: ((key: string) => void) | undefined;
	/** Jump into the server entry's edit form (the owner of entry-layer records). */
	onEditEntry?: ((label: string) => void) | undefined;
}) {
	const shown = chainsWithStory(chains);
	if (shown.length === 0) {
		return null;
	}
	return (
		<div className="record-chains">
			{shown.map((chain) => {
				// The jump is gated on the LAYER, never on which callback happens to
				// exist: an entry key must open the entry's form or nothing - falling
				// back to the global editor would contradict its own aria-label.
				const jump =
					chain.layer === "entry"
						? onEditEntry === undefined
							? undefined
							: () => onEditEntry(chain.entryLabel)
						: undefined;
				const jumpFor = (key: string) =>
					chain.layer === "entry" ? jump : onEditRecord === undefined ? undefined : () => onEditRecord(key);
				return (
					<p className="record-chain hint" key={chain.layer}>
						<span className="record-chain-label">
							{chain.layer === "entry"
								? l10n.t('Record path (server entry "{0}"):', chain.entryLabel)
								: l10n.t("Record path (settings):")}
						</span>{" "}
						{chain.links.map((link, index) => {
							const onJump = jumpFor(link.key);
							return (
								// One nowrap unit per link - arrow, key, and markers - so a
								// long chain wraps BETWEEN links, never mid-marker or with an
								// arrow stranded at a line's end.
								<span className="record-chain-link" key={link.key}>
									{index > 0 ? <span className="record-chain-arrow"> {"->"} </span> : null}
									{onJump !== undefined ? (
										<button
											type="button"
											className="quiet chain-key"
											aria-label={
												chain.layer === "entry"
													? l10n.t('Edit in server entry "{0}"', chain.entryLabel)
													: l10n.t('Edit record "{0}" in settings', link.key)
											}
											onClick={onJump}
										>
											<code>{link.key}</code>
										</button>
									) : (
										<code>{link.key}</code>
									)}
									{link.barrier ? <span className="tree-barrier"> [{l10n.t("inheritance stops here")}]</span> : null}
									{!link.barrier && link.inheritFrom !== undefined ? (
										<span> [{l10n.t("inherits from: {0}", link.inheritFrom)}]</span>
									) : null}
								</span>
							);
						})}
					</p>
				);
			})}
		</div>
	);
}
