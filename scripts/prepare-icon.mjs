// Generates the marketplace icon variants from the master artwork.
//
// Input:  assets/icon-source.png  (any square image, ideally 512+ px)
// Output:
//   assets/icon.png      — 128×128, the canonical icon used by package.json
//   assets/icon@2x.png   — 256×256, kept for higher-DPI surfaces (optional)
//
// Run:
//   npm run prepare-icon

import sharp from "sharp";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = resolve(root, "assets/icon-source.png");
const out128 = resolve(root, "assets/icon.png");
const out256 = resolve(root, "assets/icon@2x.png");

if (!existsSync(source)) {
	console.error(`Missing source icon: ${source}`);
	console.error("Save your master artwork (square, 512+ px PNG) there and re-run.");
	process.exit(1);
}

const meta = await sharp(source).metadata();
console.log(`Source: ${meta.width}×${meta.height} (${meta.format}, ${(statSync(source).size / 1024).toFixed(1)} KB)`);

// The source artwork is now full-bleed (blue extends to every edge), so we
// just resize it down to the two marketplace target sizes. No trim, no inset
// — those would corrupt a full-bleed image because trim() samples the
// top-left pixel as the "background" to cut.
await sharp(source)
	.resize(128, 128, { fit: "cover", position: "center" })
	.png({ compressionLevel: 9 })
	.toFile(out128);

await sharp(source)
	.resize(256, 256, { fit: "cover", position: "center" })
	.png({ compressionLevel: 9 })
	.toFile(out256);

console.log(`Wrote ${out128} (${(statSync(out128).size / 1024).toFixed(1)} KB)`);
console.log(`Wrote ${out256} (${(statSync(out256).size / 1024).toFixed(1)} KB)`);
