/**
 * The dev-seed handshake between `bun run dev` and a development-mode
 * activation: the launcher (scripts/dev/dev.ts) writes this file into the
 * extension development folder, and src/extension/devSeed.ts consumes it
 * exactly once. Both sides import the filename and shape from here so the
 * contract cannot drift. Pure declarations: no vscode, no Node (the launcher
 * runs outside the extension host).
 */

/** The seed file's name, resolved against the extension development folder. */
export const DEV_SEED_FILENAME = ".dev-seed.json";

/** A matcher-keyed record set, the shape both models.* settings use. */
type DevSeedRecords = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The two model-keyed record settings a seed can carry content for. */
export interface DevSeedModels {
	readonly parameters?: DevSeedRecords;
	readonly capabilities?: DevSeedRecords;
}

/**
 * One seeded server entry beyond the main one (the dev usage demo entries).
 * Upserted by label exactly like the main entry: the seed's own labels re-pin
 * wholesale on every run, every other entry survives verbatim.
 */
export interface DevSeedEntry {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	/** The entry-level manual budget in USD (demonstrates the entry-over-key budget override). */
	readonly budget?: number;
	/** Entry-level models.parameters / models.capabilities records. */
	readonly models?: DevSeedModels;
}

/**
 * The seed file's shape. The launcher writes exactly this; the extension side
 * reads it through parseDevSeed, which tolerates missing optionals (an empty
 * label falls back, apiKey defaults to "", openDashboard to false, and the
 * demo fields to absent).
 */
export interface DevSeed {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly openDashboard: boolean;
	/** Entry-level records for the main entry (the entry-over-global demo). */
	readonly models?: DevSeedModels;
	/** Extra demo entries, upserted by label like the main one. */
	readonly entries?: readonly DevSeedEntry[];
	/**
	 * Global demo records for the models.parameters / models.capabilities
	 * settings. Seeded-ness is tracked by the keys named here, the same way
	 * the entry tracks it by label: the seed owns exactly these matcher keys
	 * (re-pinned wholesale every run), and keys it does not name are user
	 * records that survive verbatim.
	 */
	readonly records?: DevSeedModels;
}
