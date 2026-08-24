/**
 * Prints the migration-expiry sticky comment for the release PR to stdout:
 * every MIGRATION_EXPIRIES row with its days remaining as of today.
 * .github/workflows/release-pr-comment.yml renders this and posts/updates the
 * comment. The registry is a zero-import leaf, so this script's whole runtime
 * graph is dependency-free and runs without node_modules; a bun smoke test
 * runs this executable so a break lands on the PR that introduced it.
 */

import { MIGRATION_EXPIRIES } from "../../src/extension/migrations/expiries";
import { renderMigrationExpiryTable } from "./migration-expiry-render";

process.stdout.write(renderMigrationExpiryTable(MIGRATION_EXPIRIES, new Date()));
