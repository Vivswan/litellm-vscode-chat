/**
 * .github/workflows/update-release-pr.yml renders this and hands the file to the sticky-comment action. The registry is
 * a zero-import leaf, so this script's whole runtime graph is dependency-free and runs without node_modules; a bun
 * smoke test runs this executable so a break lands on the PR that introduced it.
 */

import { MIGRATION_EXPIRIES } from "../../src/extension/migrations/expiries";
import { renderMigrationExpiryTable } from "./migration-expiry-render";

process.stdout.write(renderMigrationExpiryTable(MIGRATION_EXPIRIES, new Date()));
