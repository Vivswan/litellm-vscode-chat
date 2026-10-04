/**
 * The dev-seed handshake between `bun run dev` and a development-mode activation: the launcher writes this file into
 * the extension development folder and src/extension/devSeed.ts consumes it exactly once.
 * Pure declarations: no vscode, no Node (the launcher runs outside the host).
 *
 *   Both sides import the filename and shape from here -> the contract cannot drift
 */

export const DEV_SEED_FILENAME = ".dev-seed.json";

/** A matcher-keyed record set, the shape both models.* settings use. */
type DevSeedRecords = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface DevSeedModels {
	readonly parameters?: DevSeedRecords;
	readonly capabilities?: DevSeedRecords;
}

export interface DevSeedEntry {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly budget?: number;
	readonly models?: DevSeedModels;
}

export interface DevSeed {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly openDashboard: boolean;
	/** Entry-level records for the main entry (the entry-over-global demo). */
	readonly models?: DevSeedModels;
	readonly entries?: readonly DevSeedEntry[];
	/**
	 * Global demo records for the models.parameters / models.capabilities settings. The seed owns exactly the matcher
	 * keys named here (re-pinned wholesale every run); keys it does not name are user records that survive verbatim.
	 */
	readonly records?: DevSeedModels;
}
