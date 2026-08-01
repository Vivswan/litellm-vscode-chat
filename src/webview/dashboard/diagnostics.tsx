/**
 * The Diagnostics tab: the connection summary and the feedback surfaces in
 * one place; the litellm.showDiagnostics command deep-links here through the
 * panel's focusSection message. The summary renders the protocol module's
 * shared diagnostics renderers (overallStatusText, serverOutcomeParts) over
 * the same pushed state the overview hero reads, so the tab and the hero
 * cannot drift: the facts list carries the verdict, counts, and absolute
 * last-checked time, and the outcome grid shows one row per server with its
 * error or params-inactive warning spanning beneath it. Copy diagnostics
 * puts the same facts on the clipboard as plain text (composed here from
 * pushed state only, which carries no secret values by construction), with
 * each server's line rendered by serverOutcomeText - the exact string the
 * grid decomposes. Test connection, Open output log, and Report a bug post
 * executeCommand intents because the work is extension-side (the issue
 * reporter attaches version, platform, and recent logs on its own); the
 * external pages are plain anchors on literal constants (feedbackLinks.ts),
 * which the webview host opens itself.
 */

import type { ComponentChildren } from "preact";
import { Fragment } from "preact";
import { useRef, useState } from "preact/hooks";
import type { DashboardServer } from "../../extension/dashboard/protocol";
import {
	latestCheckedMs,
	overallStatusText,
	serverOutcomeParts,
	serverOutcomeText,
} from "../../extension/dashboard/protocol";
import { DOCS_LINK_GETTING_STARTED } from "./docsLinks";
import type { FeedbackUrl } from "./feedbackLinks";
import { FEEDBACK_LINK_FEATURE_REQUEST, FEEDBACK_LINK_RATE, FEEDBACK_LINK_REPOSITORY } from "./feedbackLinks";
import { DocsLink } from "./help";
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
import { relativeTime } from "./time";
import { postMessage } from "./vscodeApi";

/** One feedback row: the action (an anchor or a button) with its muted one-liner. */
function FeedbackRow({ action, hint }: { action: ComponentChildren; hint: string }) {
	return (
		<li>
			{action}
			<span class="hint">{hint}</span>
		</li>
	);
}

function ExternalRow({
	href,
	icon,
	label,
	hint,
}: {
	href: FeedbackUrl;
	icon: ComponentChildren;
	label: string;
	hint: string;
}) {
	return (
		<FeedbackRow
			action={
				<a class="docs-link" href={href}>
					{icon}
					{label}
					<IconLinkExternal />
				</a>
			}
			hint={hint}
		/>
	);
}

/** The overall last-checked reading: the absolute time with its relative echo, as the facts list renders it. */
function lastCheckedText(servers: readonly DashboardServer[], now: number): string {
	const checkedMs = latestCheckedMs(servers);
	if (checkedMs === undefined) {
		return "Never";
	}
	const absolute = new Date(checkedMs).toLocaleString();
	const ago = relativeTime(new Date(checkedMs).toISOString(), now);
	return ago === undefined ? absolute : `${absolute} (${ago})`;
}

/**
 * The whole connection block as plain text, for the Copy diagnostics action:
 * the verdict, the facts list, and one outcome line per server - exactly the
 * facts the tab renders, composed from pushed state only (which carries no
 * secret values by construction; see the storage invariants). Per-server
 * lines go through serverOutcomeText, the same shared renderer the grid
 * decomposes, so the copied wording cannot drift from the rendered one -
 * except that a row carrying an English error mirror (errorEnglish, the
 * transport error's log-safe rendering) substitutes it here: the copied
 * block is destined for public issue reports, which stay English by policy,
 * while the on-screen grid keeps the localized error.
 */
function withEnglishError(server: DashboardServer): DashboardServer {
	if (server.state === "error" && server.errorEnglish !== undefined) {
		return { ...server, error: server.errorEnglish };
	}
	if (server.state === "ok" && server.errorEnglish !== undefined) {
		return { ...server, error: server.errorEnglish };
	}
	return server;
}

function diagnosticsReportText(
	servers: readonly DashboardServer[],
	modelCount: number,
	legacyServerCount: number,
	now: number
): string {
	const copyServers = servers.map(withEnglishError);
	const lines = [
		overallStatusText(copyServers, modelCount, legacyServerCount),
		`Servers configured: ${copyServers.length}`,
		`Last checked: ${lastCheckedText(copyServers, now)}`,
	];
	if (legacyServerCount > 0) {
		lines.push(`Legacy registry servers: ${legacyServerCount}`);
	}
	for (const server of copyServers) {
		lines.push(`${server.label} (${server.baseUrl}): ${serverOutcomeText(server)}`);
	}
	return lines.join("\n");
}

/** A row's last-checked cell: relative ("is this fresh?"); the facts list above carries the precise overall time. */
function rowChecked(server: DashboardServer, now: number): string {
	if (server.lastChecked === undefined) {
		return "Never";
	}
	return relativeTime(server.lastChecked, now) ?? "-";
}

/**
 * The per-server outcome grid. Each server is one compact row; a row's error
 * and its params-inactive warning span beneath it as their own lines, so the
 * columns stay scannable while the details stay selectable. Wording comes
 * from serverOutcomeParts, the decomposition serverOutcomeText itself
 * composes; only the layout lives here.
 */
function OutcomeGrid({ servers, now }: { servers: readonly DashboardServer[]; now: number }) {
	return (
		<table class="diag-grid">
			<thead>
				<tr>
					<th>Server</th>
					<th>Status</th>
					<th class="num">Models</th>
					<th>Last checked</th>
					<th>URL</th>
				</tr>
			</thead>
			<tbody>
				{servers.map((server) => {
					const parts = serverOutcomeParts(server);
					const tone = parts.status === "Error" ? "tone-error" : parts.status === "OK" ? "tone-ok" : "tone-muted";
					const notes: { kind: "error" | "warn"; text: string }[] = [];
					if (parts.error !== undefined) {
						notes.push({ kind: "error", text: parts.error });
					}
					if (parts.notice !== undefined) {
						notes.push({ kind: "warn", text: parts.notice });
					}
					return (
						<Fragment key={`${server.label} ${server.baseUrl}`}>
							{/* Rows followed by a note drop their rule so the group reads
							    as one server; the group's last row draws it. */}
							<tr class={notes.length > 0 ? "no-rule" : undefined}>
								<td>{server.label}</td>
								<td>
									<span class={`pill ${tone}`}>
										<span class="dot" />
										{parts.status}
									</span>
								</td>
								<td class="num">{server.modelCount}</td>
								<td>{rowChecked(server, now)}</td>
								<td class="diag-url">{server.baseUrl}</td>
							</tr>
							{notes.map((note, index) => (
								<tr
									key={note.kind}
									class={index < notes.length - 1 ? `diag-note ${note.kind} no-rule` : `diag-note ${note.kind}`}
								>
									<td colSpan={5}>{note.text}</td>
								</tr>
							))}
						</Fragment>
					);
				})}
			</tbody>
		</table>
	);
}

export function DiagnosticsSection({
	servers,
	modelCount,
	legacyServerCount,
	now,
}: {
	servers: readonly DashboardServer[];
	modelCount: number;
	legacyServerCount: number;
	now: number;
}) {
	const [copied, setCopied] = useState(false);
	const copySeq = useRef(0);
	const copyDiagnostics = () => {
		// Clipboard write is fire-and-forget; the check mark is the only
		// feedback (the models table's copy action sets the precedent).
		navigator.clipboard?.writeText(diagnosticsReportText(servers, modelCount, legacyServerCount, now)).catch(() => {});
		setCopied(true);
		const seq = ++copySeq.current;
		setTimeout(() => {
			if (copySeq.current === seq) {
				setCopied(false);
			}
		}, 1500);
	};
	return (
		<>
			<section aria-labelledby="diagnostics-title">
				<h2 id="diagnostics-title">Diagnostics</h2>
				<p class="diag-verdict">{overallStatusText(servers, modelCount, legacyServerCount)}</p>
				<ul class="diag-facts">
					<li>Servers configured: {servers.length}</li>
					{/* One literal string, not CSS-spaced fragments: the line is meant
					    to be copied whole into a report, and Copy diagnostics renders
					    exactly the same text. */}
					<li>Last checked: {lastCheckedText(servers, now)}</li>
					{/* The legacy registry (pre-migration installs and test mode)
					    holds servers no row lists; the count keeps the copyable block
					    honest about them. */}
					{legacyServerCount > 0 ? <li>Legacy registry servers: {legacyServerCount}</li> : null}
				</ul>
				{servers.length > 0 ? <OutcomeGrid servers={servers} now={now} /> : null}
				<div class="diag-actions">
					<button
						type="button"
						class="secondary"
						// Legacy-registry servers are testable too: litellm.testConnection
						// still sweeps the registry until migration completes.
						disabled={servers.length === 0 && legacyServerCount === 0}
						onClick={() => postMessage({ type: "executeCommand", command: "testConnection" })}
					>
						<IconPlug /> Test connection
					</button>
					<button
						type="button"
						class="secondary"
						onClick={() => postMessage({ type: "executeCommand", command: "openOutput" })}
					>
						<IconOutput /> Open output log
					</button>
					<button type="button" class="secondary" onClick={copyDiagnostics}>
						{copied ? <IconCheck /> : <IconCopy />} Copy diagnostics
					</button>
				</div>
			</section>
			<section aria-labelledby="diagnostics-feedback-title">
				<h2 id="diagnostics-feedback-title">Feedback &amp; links</h2>
				<ul class="feedback-links">
					<FeedbackRow
						action={
							<button
								type="button"
								class="linkish"
								onClick={() => postMessage({ type: "executeCommand", command: "reportIssue" })}
							>
								<IconBug /> Report a bug
							</button>
						}
						hint="Opens a GitHub issue pre-filled with version, platform, and recent logs."
					/>
					<ExternalRow
						href={FEEDBACK_LINK_FEATURE_REQUEST}
						icon={<IconLightbulb />}
						label="Request a feature"
						hint="Suggest an improvement as a GitHub issue."
					/>
					<ExternalRow
						href={FEEDBACK_LINK_RATE}
						icon={<IconStar />}
						label="Rate this extension"
						hint="Leave a review on the Visual Studio Marketplace."
					/>
					<FeedbackRow
						action={
							<DocsLink href={DOCS_LINK_GETTING_STARTED} label="Documentation - the getting-started guide">
								<IconBook /> Documentation
							</DocsLink>
						}
						hint="The getting-started guide, with the rest of the docs one click away."
					/>
					<ExternalRow
						href={FEEDBACK_LINK_REPOSITORY}
						icon={<IconRepo />}
						label="GitHub repository"
						hint="Source code, releases, and issues."
					/>
				</ul>
			</section>
		</>
	);
}
