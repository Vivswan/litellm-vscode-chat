import * as vscode from "vscode";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function normalizeCustomHeaders(raw: unknown, log?: (message: string, data?: unknown) => void): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		const trimmedName = name.trim();
		if (!trimmedName || !HEADER_NAME_PATTERN.test(trimmedName)) {
			log?.("Ignoring invalid custom header name", { name });
			continue;
		}
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
			log?.("Ignoring custom header with non-primitive value", { name: trimmedName });
			continue;
		}
		const rendered = String(value);
		if (rendered.includes("\r") || rendered.includes("\n")) {
			log?.("Ignoring custom header with unsafe newline characters", { name: trimmedName });
			continue;
		}
		headers[trimmedName] = rendered;
	}

	return headers;
}

export function getCustomHeaders(log?: (message: string, data?: unknown) => void): Record<string, string> {
	const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
	const raw = settings.get<Record<string, unknown>>("headers", {});
	return normalizeCustomHeaders(raw, log);
}
