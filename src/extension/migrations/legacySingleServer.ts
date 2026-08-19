import type * as vscode from "vscode";
import { z } from "zod";
import {
	apiKeySecret,
	LEGACY_API_KEY_SECRET,
	LEGACY_BASE_URL_SECRET,
	LEGACY_CLEANUP_PENDING_KEY,
} from "../../shared/config/storageKeys";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { ServerRegistry } from "../servers/serverRegistry";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

/**
 * True while the pre-registry single-server secrets are still stored. The
 * registry-to-provider-groups migration's fresh-install completion keys on
 * this: an install is only "fresh" when no legacy config is waiting to become
 * a registry entry on a later activation.
 */
export async function hasLegacyConfig(secrets: vscode.SecretStorage): Promise<boolean> {
	return Boolean(await secrets.get(LEGACY_BASE_URL_SECRET));
}

/** Base-URL secret last: it is the presence marker every detection here keys on. */
async function deleteLegacySecrets(secrets: vscode.SecretStorage): Promise<void> {
	await secrets.delete(LEGACY_API_KEY_SECRET);
	await secrets.delete(LEGACY_BASE_URL_SECRET);
}

// The cleanup marker is `true` for a plain interrupted run; losing an import
// race to another window adds the per-server secret ids the loser must still
// delete.
const cleanupMarkerSchema = z.union([z.boolean(), z.object({ orphanedSecretIds: z.array(z.string()) })]);

function parseCleanupMarker(raw: unknown): { pending: boolean; orphanedSecretIds: string[] } {
	const parsed = cleanupMarkerSchema.safeParse(raw);
	if (!parsed.success) {
		return { pending: false, orphanedSecretIds: [] };
	}
	if (typeof parsed.data === "boolean") {
		return { pending: parsed.data, orphanedSecretIds: [] };
	}
	return { pending: true, orphanedSecretIds: parsed.data.orphanedSecretIds };
}

async function finishCleanup(ctx: MigrationContext, orphanedSecretIds: readonly string[]): Promise<void> {
	await deleteLegacySecrets(ctx.secrets);
	for (const id of orphanedSecretIds) {
		await ctx.secrets.delete(apiKeySecret(id));
	}
	await ctx.globalState.update(LEGACY_CLEANUP_PENDING_KEY, undefined);
}

async function migrateLegacySingleServer(ctx: MigrationContext): Promise<MigrationOutcome> {
	// A pending marker means the registry entry persisted in an earlier run but
	// the deletions did not finish. They are retried before anything reads the
	// registry: the group migration may have emptied it since, and an empty
	// registry with lingering legacy secrets would otherwise re-import stale
	// config as a new "Default" server.
	const marker = parseCleanupMarker(ctx.globalState.get<unknown>(LEGACY_CLEANUP_PENDING_KEY));
	if (marker.pending) {
		await finishCleanup(ctx, marker.orphanedSecretIds);
		return "migrated";
	}
	const baseUrl = await ctx.secrets.get(LEGACY_BASE_URL_SECRET);
	if (!baseUrl) {
		return "nothing-to-do";
	}
	const normalized = normalizeBaseUrl(baseUrl);
	// Recovery detection is by base URL alone, never by label: a run whose
	// marker write failed left the imported entry behind, and the user may
	// have renamed it before this retry.
	const hasLegacyEntry = () => ctx.registry.getServers().some((s) => s.baseUrl === normalized);
	const servers = ctx.registry.getServers();
	if (servers.length > 0 && !hasLegacyEntry()) {
		// A populated registry means newer configuration superseded the legacy
		// one; importing a "Default" server on top of it would be a surprise.
		// The superseded pair is DELETED, not left waiting: once the group
		// migration empties the registry, lingering legacy secrets would
		// re-import on the next activation as a provider group with the stale
		// key. Marker first, so an interrupted deletion stays retryable.
		await ctx.globalState.update(LEGACY_CLEANUP_PENDING_KEY, true);
		await finishCleanup(ctx, []);
		return "migrated";
	}
	const orphanedSecretIds: string[] = [];
	if (!hasLegacyEntry()) {
		const apiKey = (await ctx.secrets.get(LEGACY_API_KEY_SECRET)) ?? "";
		// Re-read after the secret read above, right before the write:
		// getServers() adopts another window's strictly newer persisted
		// registry, so a concurrent import that landed during the await is seen
		// here. The legacy secrets are deleted only after the entry persists,
		// so a failed addServer leaves them in place for a retry.
		if (!hasLegacyEntry()) {
			const imported = await ctx.registry.addServerUnguarded("Default", baseUrl, apiKey);
			// Two windows can still interleave between the re-read and their
			// writes; the registry's versioned last-write-wins keeps one entry.
			// A same-version overwrite is invisible to our own registry
			// instance (it only adopts strictly newer snapshots), so a fresh
			// instance reads the persisted truth: if a DIFFERENT id now owns
			// the legacy base URL, we lost, the winner is canonical, and our
			// secret is unreferenced. Best-effort: a loss the overwrite has
			// not made visible yet leaves the orphaned secret behind.
			const persisted = new ServerRegistry(ctx.globalState, ctx.secrets).getServers();
			const winner = persisted.find((s) => s.baseUrl === normalized);
			if (winner !== undefined && winner.id !== imported.id) {
				orphanedSecretIds.push(imported.id);
			}
		}
	}
	// The marker written before the deletions keeps them retryable even after
	// the registry entry moves on; matching the already-migrated entry above
	// covers a run where this marker write itself failed.
	await ctx.globalState.update(LEGACY_CLEANUP_PENDING_KEY, orphanedSecretIds.length > 0 ? { orphanedSecretIds } : true);
	await finishCleanup(ctx, orphanedSecretIds);
	return "migrated";
}

/**
 * Moves the pre-registry single-server secrets into a "Default" registry entry.
 *
 * Migrates away from: the single-server secret pair of v0.2.2 and earlier
 * (the server registry shipped in v0.2.3). Deletable once installs that old
 * are judged extinct.
 */
export const legacySingleServerMigration: ExtensionMigration = {
	state: "legacy-single-server",
	description: "Migrated legacy single-server config to server registry",
	sourceRelease: "0.2.2",
	phase: "pre-registration",
	run: migrateLegacySingleServer,
};
