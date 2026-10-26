/**
 * The inspectors' compact inheritance figure: one line per record map showing the matching chain broadest to winner,
 * each key jumping into the editor that owns it, barrier and exclusive-list markers worded exactly as the Diagnostics
 * tree words them. A chain of one record tells no inheritance story and renders nothing.
 */

import * as l10n from "@vscode/l10n";
import type { RecordChainLink, RecordChainView } from "../../dashboard/viewModels";
import { entryScope, Provenance, settingsScope } from "./provenance";
import { Button } from "./ui/button";

/** The two editors a chain key can jump into; an absent one leaves its keys as plain text. */
interface ChainEditors {
	readonly onEditRecord?: ((key: string) => void) | undefined;
	readonly onEditEntry?: ((label: string) => void) | undefined;
}

interface ChainLineProps {
	readonly chain: RecordChainView;
	readonly editors: ChainEditors;
}

interface ChainLinkProps {
	readonly chain: RecordChainView;
	readonly link: RecordChainLink;
	readonly first: boolean;
	readonly onJump: (() => void) | undefined;
}

function chainsWithStory(chains: readonly RecordChainView[] | undefined): readonly RecordChainView[] {
	return (chains ?? []).filter((chain) => chain.links.length >= 2);
}

/**
 * The jump a key offers, gated on the LAYER, never on which callback happens to exist: an entry key must open the
 * entry's form or nothing - falling back to the global editor would contradict its own aria-label.
 */
function linkJump(
	chain: RecordChainView,
	key: string,
	{ onEditRecord, onEditEntry }: ChainEditors
): (() => void) | undefined {
	if (chain.layer === "entry") {
		const { entryLabel } = chain;
		return onEditEntry === undefined ? undefined : () => onEditEntry(entryLabel);
	}
	return onEditRecord === undefined ? undefined : () => onEditRecord(key);
}

function jumpLabel(chain: RecordChainView, key: string): string {
	return chain.layer === "entry"
		? l10n.t('Edit in server entry "{0}"', chain.entryLabel)
		: l10n.t('Edit record "{0}" in settings', key);
}

/**
 * One nowrap unit per link - arrow, key, and markers - so a long chain wraps BETWEEN links, never mid-marker or with
 * an arrow stranded at a line's end.
 */
function ChainLink({ chain, link, first, onJump }: ChainLinkProps) {
	return (
		<span className="record-chain-link">
			{first ? null : <span className="record-chain-arrow"> {"->"} </span>}
			{onJump === undefined ? (
				<code>{link.key}</code>
			) : (
				<Button
					variant="secondary"
					size="compact"
					className="chain-key [--btn-mx:-0.125rem] px-0.5 py-0"
					aria-label={jumpLabel(chain, link.key)}
					onClick={onJump}
				>
					<code>{link.key}</code>
				</Button>
			)}
			{link.barrier ? <span className="tree-barrier"> [{l10n.t("inheritance stops here")}]</span> : null}
			{!link.barrier && link.inheritFrom !== undefined ? (
				<span> [{l10n.t("inherits from: {0}", link.inheritFrom)}]</span>
			) : null}
		</span>
	);
}

function ChainLine({ chain, editors }: ChainLineProps) {
	return (
		<p className="record-chain">
			<span className="record-chain-label">{l10n.t("Record path")}</span>{" "}
			{/* The layer word alone: the badge's second slot is a RECORD KEY everywhere else, and an
			    entry label sitting in it reads as a record named "prod". The entry is named in the
			    jump's accessible label and the panel's header. */}
			<Provenance source={{ scope: chain.layer === "entry" ? entryScope() : settingsScope() }} />{" "}
			{chain.links.map((link, index) => (
				<ChainLink
					key={link.key}
					chain={chain}
					link={link}
					first={index === 0}
					onJump={linkJump(chain, link.key, editors)}
				/>
			))}
		</p>
	);
}

export function RecordChainFigure({
	chains,
	onEditRecord,
	onEditEntry,
}: {
	/** One chain per record map; absent, and a chain of fewer than two links, renders nothing. */
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
			{shown.map((chain) => (
				<ChainLine key={chain.layer} chain={chain} editors={{ onEditRecord, onEditEntry }} />
			))}
		</div>
	);
}
