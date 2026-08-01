/**
 * The Diagnostics tab: the connection summary and the feedback surfaces in
 * one place; the litellm.showDiagnostics command deep-links here through the
 * panel's focusSection message. The summary renders the protocol module's
 * shared diagnostics renderers (overallStatusText, serverOutcomeText) over
 * the same pushed state the overview hero reads, so the tab and the hero
 * cannot drift, and it stands alone as a copyable block: verdict, server
 * count, absolute last-checked time, legacy-registry leftovers, and one
 * outcome line per server. Test connection and Report a bug post the
 * executeCommand intent because the work is extension-side (the issue
 * reporter attaches version, platform, and recent logs on its own); the
 * external pages are plain anchors on literal constants (feedbackLinks.ts),
 * which the webview host opens itself.
 */

import type { ComponentChildren } from "preact";
import type { DashboardServer } from "../../extension/dashboard/protocol";
import { latestCheckedMs, overallStatusText, serverOutcomeText } from "../../extension/dashboard/protocol";
import { DOCS_LINK_GETTING_STARTED } from "./docsLinks";
import type { FeedbackUrl } from "./feedbackLinks";
import { FEEDBACK_LINK_FEATURE_REQUEST, FEEDBACK_LINK_RATE, FEEDBACK_LINK_REPOSITORY } from "./feedbackLinks";
import { DocsLink } from "./help";
import { IconBook, IconBug, IconLightbulb, IconLinkExternal, IconPlug, IconRepo, IconStar } from "./icons";
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
	const checkedMs = latestCheckedMs(servers);
	const lastCheckedAgo = checkedMs === undefined ? undefined : relativeTime(new Date(checkedMs).toISOString(), now);
	return (
		<>
			<section aria-labelledby="diagnostics-title">
				<h2 id="diagnostics-title">Diagnostics</h2>
				<p class="diag-verdict">{overallStatusText(servers, modelCount, legacyServerCount)}</p>
				<ul class="diag-facts">
					<li>Servers configured: {servers.length}</li>
					<li>
						Last checked:{" "}
						{checkedMs === undefined ? (
							"Never"
						) : (
							<>
								{new Date(checkedMs).toLocaleString()}
								{/* A literal space and parentheses, not CSS spacing: the line
								    is meant to be copied whole into a report. */}
								{lastCheckedAgo !== undefined ? <span class="hint"> ({lastCheckedAgo})</span> : null}
							</>
						)}
					</li>
					{/* The legacy registry (pre-migration installs and test mode)
					    holds servers no row lists; the count keeps the copyable block
					    honest about them. */}
					{legacyServerCount > 0 ? <li>Legacy registry servers: {legacyServerCount}</li> : null}
				</ul>
				{servers.length > 0 ? (
					<ul class="diag-servers">
						{servers.map((server) => (
							<li key={`${server.label} ${server.baseUrl}`}>
								<strong>{server.label}</strong>: {serverOutcomeText(server)}
								<span class="hint">{server.baseUrl}</span>
							</li>
						))}
					</ul>
				) : null}
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
				</div>
				<p class="hint">Check the LiteLLM output channel for detailed logs.</p>
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
