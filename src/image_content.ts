/**
 * Pure (vscode-free) assembly of multimodal user-message content for the
 * DeepSeek Vision API (deepseek-v4-flash-vision-exp).
 *
 * The Vision endpoint keeps the OpenAI-compatible /chat/completions shape but
 * switches `content` from a plain string to an array of typed blocks:
 *   { type: "text", text: "..." }
 *   { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 *
 * Extracted from convertMessages in utils.ts — which remains the thin vscode
 * adapter (LanguageModelDataPart → ImagePartInput) — so the block assembly,
 * MIME gating, and drop accounting are importable by the Node unit harness
 * (test/unit_image_content.mjs) without a vscode mock. Same vscode-free
 * extraction pattern as tool_names.ts / tool_payload.ts / tool_limit.ts.
 */

import type { OpenAIContentPart } from "./types";

/**
 * Image formats the Vision API accepts. DeepSeek sniffs the real format from
 * the file bytes, but an unsupported container still fails the whole request
 * server-side, so we gate on the declared MIME up front and drop (with a
 * warning) rather than gamble the entire turn on one bad attachment.
 */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

/**
 * DeepSeek bills each image at up to 384 tokens. We use the ceiling as the
 * local estimate: the pre-flight overflow check must never under-count, and
 * at 384 tokens/image the overshoot is negligible against a 1M window.
 */
export const IMAGE_TOKENS_PER_IMAGE = 384;

/**
 * The Vision API caps the request body at 48 MiB — base64-encoded image
 * bytes count toward it. Checked against the serialized JSON body right
 * before fetch; the JSON is ASCII-dominated so string length ≈ bytes.
 */
export const MAX_REQUEST_BODY_BYTES = 48 * 1024 * 1024;

/** Ordered content inputs harvested from one VS Code chat message. */
export type UserContentInput = { kind: "text"; text: string } | { kind: "image"; mimeType: string; data: Uint8Array };

/**
 * Result of assembling one message's content. `content` is a plain string
 * whenever no image survived — the wire shape for text-only messages must
 * stay identical to the pre-vision extension so server prompt-cache prefixes
 * (and the reasoning-cache fingerprints derived from them) are unchanged.
 */
export interface BuiltUserContent {
	content: string | OpenAIContentPart[];
	/** Images dropped because the selected model variant has no image input. */
	droppedNoVision: number;
	/** Images dropped because the declared MIME type is not Vision-supported. */
	droppedUnsupported: number;
}

/**
 * Lower-case the MIME, strip parameters (`image/png; charset=x` → `image/png`),
 * and fold the common `image/jpg` misnomer into `image/jpeg`.
 */
export function normalizeImageMime(mimeType: string): string {
	const bare = mimeType.split(";")[0].trim().toLowerCase();
	return bare === "image/jpg" ? "image/jpeg" : bare;
}

/** Whether the declared MIME type is accepted by the Vision API. */
export function isSupportedImageMime(mimeType: string): boolean {
	return SUPPORTED_IMAGE_MIME_TYPES.has(normalizeImageMime(mimeType));
}

/** Encode raw image bytes as a `data:` URL for an image_url block. */
export function imageDataUrl(mimeType: string, data: Uint8Array): string {
	return `data:${normalizeImageMime(mimeType)};base64,${Buffer.from(data).toString("base64")}`;
}

/**
 * Assemble one message's ordered inputs into wire content.
 *
 * Adjacent text inputs are merged into a single text block so the block
 * count reflects real modality boundaries, not how the host happened to
 * chunk its text parts. When `imageInput` is false every image is dropped
 * (counted, for the caller to log) and the result degrades to the plain
 * string the non-vision variants have always sent.
 */
export function buildUserContent(inputs: readonly UserContentInput[], imageInput: boolean): BuiltUserContent {
	const blocks: OpenAIContentPart[] = [];
	let droppedNoVision = 0;
	let droppedUnsupported = 0;

	for (const input of inputs) {
		if (input.kind === "text") {
			const last = blocks[blocks.length - 1];
			if (last && last.type === "text") {
				last.text += input.text;
			} else {
				blocks.push({ type: "text", text: input.text });
			}
			continue;
		}
		if (!imageInput) {
			droppedNoVision++;
			continue;
		}
		if (!isSupportedImageMime(input.mimeType)) {
			droppedUnsupported++;
			continue;
		}
		blocks.push({ type: "image_url", image_url: { url: imageDataUrl(input.mimeType, input.data) } });
	}

	const hasImage = blocks.some((b) => b.type === "image_url");
	if (!hasImage) {
		// Text-only after drops — collapse to the legacy string shape.
		const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
		return { content: text, droppedNoVision, droppedUnsupported };
	}
	return { content: blocks, droppedNoVision, droppedUnsupported };
}

/**
 * Concatenated text of a wire content value, whatever its shape. Used by the
 * reasoning-cache fingerprint and log paths that need "the text of this
 * message" without caring about modality.
 */
export function contentText(content: string | OpenAIContentPart[] | undefined): string {
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	let text = "";
	for (const block of content) {
		if (block.type === "text") {
			text += block.text;
		}
	}
	return text;
}
