/**
 * Renders the extension icon, assets/logo.png, from its vector source, assets/logo.svg.
 *
 *   The PNG is a build product, never committed: every bundle (scripts/dev/bundle.mts, so bundle, bundle:dev,
 *   bundle:watch, and vscode:prepublish through bundle) renders it first, `bun run icon:render` renders it alone, and
 *   the packaging gate (scripts/ci/packagedFiles.ts) bounds its size. The chat participant and the Marketplace read
 *   the PNG; the Marketplace takes PNG only, at most 1024 KB, and 512 px keeps the icon crisp at every size VS Code
 *   shows it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const SOURCE = "assets/logo.svg";
const TARGET = "assets/logo.png";
const SIZE = 512;

/**
 * Write assets/logo.png from assets/logo.svg at 512 px.
 *
 * @returns the one-line summary of what was written
 * @throws {Error} the source did not render square, so its viewBox is wrong
 */
export function renderIcon(): string {
	const png = new Resvg(readFileSync(SOURCE, "utf8"), { fitTo: { mode: "width", value: SIZE } }).render();
	if (png.width !== SIZE || png.height !== SIZE) {
		throw new Error(`${SOURCE} rendered ${png.width}x${png.height}, not ${SIZE}x${SIZE}; its viewBox must be square`);
	}
	mkdirSync("assets", { recursive: true });
	const bytes = png.asPng();
	writeFileSync(TARGET, bytes);
	return `${TARGET}: ${SIZE}x${SIZE}, ${bytes.length} bytes, from ${SOURCE}`;
}

if (import.meta.main) {
	console.log(renderIcon());
}
