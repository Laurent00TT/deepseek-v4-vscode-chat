// Tests for the pure multimodal content assembly in image_content.ts —
// the Vision (deepseek-v4-flash-vision-exp) wire format:
//
//   - MIME normalization + the supported-format gate (JPEG/PNG/GIF/WebP)
//   - base64 `data:` URL encoding for image_url blocks
//   - buildUserContent: ordered text/image block assembly, adjacent-text
//     merging, drop accounting (no-vision vs unsupported-MIME), and the
//     critical collapse-to-plain-string invariant for text-only results
//     (wire shape of text-only messages must be byte-identical to the
//     pre-vision extension — server prompt-cache prefix stability)
//   - contentText: flattening the (string | block-array) union
//   - the billing/transport constants pinned so drift is a deliberate edit
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import {
	IMAGE_TOKENS_PER_IMAGE,
	MAX_IMAGE_BYTES,
	MAX_REQUEST_BODY_BYTES,
	SUPPORTED_IMAGE_MIME_TYPES,
	normalizeImageMime,
	isSupportedImageMime,
	imageDataUrl,
	buildUserContent,
	contentText,
} from "../out/image_content.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, got, expected) {
	const g = typeof got === "object" ? JSON.stringify(got) : got;
	const e = typeof expected === "object" ? JSON.stringify(expected) : expected;
	const ok = Object.is(g, e);
	if (ok) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${JSON.stringify(e)} got=${JSON.stringify(g)}`);
	}
}

// "Hello" — bytes whose base64 ("SGVsbG8=") is a well-known fixture.
const HELLO = new Uint8Array([72, 101, 108, 108, 111]);
const img = (mimeType, data = HELLO) => ({ kind: "image", mimeType, data });
const txt = (text) => ({ kind: "text", text });

// === 1. Constants pinned to the DeepSeek Vision API contract ===
check("IMAGE_TOKENS_PER_IMAGE is 384", IMAGE_TOKENS_PER_IMAGE, 384);
check("MAX_REQUEST_BODY_BYTES is 48 MiB", MAX_REQUEST_BODY_BYTES, 48 * 1024 * 1024);
check("MAX_IMAGE_BYTES is 32 MiB", MAX_IMAGE_BYTES, 32 * 1024 * 1024);
check("per-image cap is below the body cap", MAX_IMAGE_BYTES < MAX_REQUEST_BODY_BYTES, true);
check("exactly 4 supported formats", SUPPORTED_IMAGE_MIME_TYPES.size, 4);

// === 2. MIME normalization ===
check("lower-cases", normalizeImageMime("IMAGE/PNG"), "image/png");
check("strips parameters", normalizeImageMime("image/png; charset=binary"), "image/png");
check("folds image/jpg into image/jpeg", normalizeImageMime("image/jpg"), "image/jpeg");
check("trims whitespace around the bare type", normalizeImageMime(" image/webp ; q=1"), "image/webp");

// === 3. The supported-format gate ===
for (const mime of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
	check(`${mime} supported`, isSupportedImageMime(mime), true);
}
check("image/jpg supported via normalization", isSupportedImageMime("image/jpg"), true);
check("IMAGE/PNG supported via normalization", isSupportedImageMime("IMAGE/PNG"), true);
for (const mime of ["image/bmp", "image/tiff", "image/svg+xml", "application/pdf", "cache_control", ""]) {
	check(`${mime || "(empty)"} rejected`, isSupportedImageMime(mime), false);
}

// === 4. data: URL encoding ===
check("encodes bytes as base64 data URL", imageDataUrl("image/png", HELLO), "data:image/png;base64,SGVsbG8=");
check("data URL carries the NORMALIZED mime", imageDataUrl("IMAGE/JPG", HELLO), "data:image/jpeg;base64,SGVsbG8=");
check("empty payload encodes to empty base64", imageDataUrl("image/gif", new Uint8Array(0)), "data:image/gif;base64,");

// === 5. buildUserContent — the collapse-to-string invariant ===
// Text-only results MUST come back as a plain string (never a one-block
// array): the block-array shape for text-only messages would change the
// serialized request for every existing conversation, breaking the server
// prompt-cache prefix and the reasoning fingerprints derived from it.
const textOnly = buildUserContent([txt("hello "), txt("world")], true);
check("text-only stays a plain string (vision on)", typeof textOnly.content, "string");
check("adjacent text inputs are joined", textOnly.content, "hello world");
check("text-only drops nothing", textOnly.droppedNoVision + textOnly.droppedUnsupported, 0);

const empty = buildUserContent([], true);
check("no inputs → empty string, not an array", empty.content, "");

// vision OFF: images are dropped and counted; result collapses to string.
const visionOff = buildUserContent([txt("look: "), img("image/png")], false);
check("vision off → plain string", visionOff.content, "look: ");
check("vision off → dropped image counted as no-vision", visionOff.droppedNoVision, 1);
check("vision off → not counted as unsupported", visionOff.droppedUnsupported, 0);

// unsupported MIME on a vision model: dropped and counted separately; a
// message whose ONLY image was unsupported collapses back to string.
const unsupported = buildUserContent([txt("chart: "), img("image/bmp")], true);
check("unsupported-only → plain string", unsupported.content, "chart: ");
check("unsupported image counted", unsupported.droppedUnsupported, 1);
check("unsupported not counted as no-vision", unsupported.droppedNoVision, 0);

// === 6. buildUserContent — multimodal block assembly ===
const mixed = buildUserContent([txt("before "), img("image/png"), txt("after")], true);
check("mixed content is a block array", Array.isArray(mixed.content), true);
check("mixed content has 3 blocks (text, image, text)", mixed.content.length, 3);
check("block order preserved: text first", mixed.content[0], { type: "text", text: "before " });
check("block order preserved: image second", mixed.content[1], {
	type: "image_url",
	image_url: { url: "data:image/png;base64,SGVsbG8=" },
});
check("block order preserved: text last", mixed.content[2], { type: "text", text: "after" });

const imageOnly = buildUserContent([img("image/jpeg")], true);
check("image-only message is a single image block", imageOnly.content, [
	{ type: "image_url", image_url: { url: "data:image/jpeg;base64,SGVsbG8=" } },
]);

// Adjacent text around a DROPPED image merges into one block — the block
// boundary must reflect what is actually sent, not what was attached.
const droppedBetween = buildUserContent([txt("a"), img("image/bmp"), txt("b"), img("image/png")], true);
check("dropped image doesn't split text blocks", droppedBetween.content, [
	{ type: "text", text: "ab" },
	{ type: "image_url", image_url: { url: "data:image/png;base64,SGVsbG8=" } },
]);
check("mixed drop accounting: 1 unsupported", droppedBetween.droppedUnsupported, 1);

const twoImages = buildUserContent([img("image/png"), img("image/webp")], true);
check("consecutive images stay separate blocks", twoImages.content.length, 2);

// === 7. contentText — flattening the union ===
check("undefined → empty", contentText(undefined), "");
check("plain string passes through", contentText("plain"), "plain");
check(
	"block array → concatenated text blocks only",
	contentText([
		{ type: "text", text: "a" },
		{ type: "image_url", image_url: { url: "data:image/png;base64,SGVsbG8=" } },
		{ type: "text", text: "b" },
	]),
	"ab",
);
check("image-only array → empty text", contentText([{ type: "image_url", image_url: { url: "x" } }]), "");

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
	console.log("");
	console.log("Failures:");
	for (const f of failures) {
		console.log(f);
	}
	process.exit(1);
}
process.exit(0);
