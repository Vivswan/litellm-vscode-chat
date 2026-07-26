/**
 * Server-related types shared across the extension and provider layers.
 * They live here so the provider layer never imports from src/extension
 * (the dependency between layers is one-way: extension -> provider -> shared).
 */

export interface ServerConfig {
	id: string;
	label: string;
	baseUrl: string;
}

export interface ServerWithKey extends ServerConfig {
	apiKey: string;
}

export interface ServerStatus {
	serverId: string;
	label: string;
	baseUrl: string;
	state: "ok" | "error";
	modelCount: number;
	error?: string | undefined;
	lastChecked: string;
	/** Whether the server's configuration carries credentials (a static API key or OAuth client credentials); the secrets themselves never leave their store. */
	hasApiKey?: boolean | undefined;
}

export interface AggregatedStatus {
	serverStatuses: ServerStatus[];
	totalModels: number;
	silent: boolean;
}
