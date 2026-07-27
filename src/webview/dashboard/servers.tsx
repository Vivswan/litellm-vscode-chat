import type { DashboardServer } from "../../extension/dashboard/protocol";
import { postMessage } from "./vscodeApi";

function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ServerRow({ server }: { server: DashboardServer }) {
	return (
		<tr>
			<td>{server.label}</td>
			<td>{server.baseUrl}</td>
			<td>
				{server.state === "ok" ? (
					<span class="state-ok">reachable</span>
				) : (
					<span class="state-error" title={server.error ?? ""}>
						error
					</span>
				)}
				{server.hasApiKey ? (
					<span class="badge" title="Authentication configured">
						auth
					</span>
				) : null}
			</td>
			<td class="num">{server.modelCount}</td>
			<td>{formatTimestamp(server.lastChecked)}</td>
		</tr>
	);
}

/**
 * The server list is read-only by design: server configurations (and their
 * secrets) live in VS Code's provider groups, which extensions cannot
 * enumerate or edit; the Manage Servers button routes to the native editor.
 */
export function ServersSection({ servers }: { servers: readonly DashboardServer[] }) {
	return (
		<section>
			<h2>Servers</h2>
			<div class="toolbar">
				<button type="button" onClick={() => postMessage({ type: "executeCommand", command: "manageServers" })}>
					Manage Servers
				</button>
				<button
					type="button"
					class="secondary"
					onClick={() => postMessage({ type: "executeCommand", command: "syncModels" })}
				>
					Sync Models Now
				</button>
				<button
					type="button"
					class="secondary"
					onClick={() => postMessage({ type: "executeCommand", command: "testConnection" })}
				>
					Test Connection
				</button>
				<button
					type="button"
					class="secondary"
					onClick={() => postMessage({ type: "executeCommand", command: "showDiagnostics" })}
				>
					Show Diagnostics
				</button>
			</div>
			{servers.length === 0 ? (
				<p class="empty">No servers seen yet. Add one with Manage Servers, then run Test Connection.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Server</th>
							<th>Base URL</th>
							<th>Status</th>
							<th class="num">Models</th>
							<th>Last checked</th>
						</tr>
					</thead>
					<tbody>
						{servers.map((server, index) => (
							// Rows rebuild wholesale on every state push; the positional
							// index is the identity (server IDs stay extension-side, they
							// embed a credential fingerprint).
							<ServerRow key={index} server={server} />
						))}
					</tbody>
				</table>
			)}
			{servers.some((server) => server.error !== undefined) ? (
				<p class="error">
					{servers
						.filter((server) => server.error !== undefined)
						.map((server) => `${server.label}: ${server.error}`)
						.join("; ")}
				</p>
			) : null}
		</section>
	);
}
