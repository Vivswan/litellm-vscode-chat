/**
 * Renders the extension icon, assets/logo.png, from its vector source, assets/logo.svg.
 *
 *   The PNG is a build product, never committed: `bun run compile` and `vscode:prepublish` write it, and the packaging
 *   gate (scripts/ci/packagedFiles.ts) bounds its size. The Marketplace takes PNG only, at most 1024 KB; 512 px keeps
 *   the icon crisp at every size VS Code shows it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const SOURCE = "assets/logo.svg";
const TARGET = "assets/logo.png";
const SIZE = 512;

const png = new Resvg(readFileSync(SOURCE, "utf8"), { fitTo: { mode: "width", value: SIZE } }).render();
if (png.width !== SIZE || png.height !== SIZE) {
	throw new Error(`${SOURCE} rendered ${png.width}x${png.height}, not ${SIZE}x${SIZE}; its viewBox must be square`);
}
mkdirSync("assets", { recursive: true });
const bytes = png.asPng();
writeFileSync(TARGET, bytes);
console.log(`${TARGET}: ${SIZE}x${SIZE}, ${bytes.length} bytes, from ${SOURCE}`);
