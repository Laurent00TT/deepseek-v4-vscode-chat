/**
 * Tool-name validation and wire-aliasing against the OpenAI / DeepSeek
 * function-name spec:
 *
 *   "Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a
 *    maximum length of 64."
 *
 * Pure (zero vscode dependency) so unit tests can import it via Node ESM
 * without a VS Code mock.
 *
 * Names that violate the spec are NOT rejected anymore (issue #20: VS Code's
 * MCP prefixing routinely produces 70+ char names, and a single bad name used
 * to hard-fail the whole request). Instead, `toWireName` maps every host name
 * onto a deterministic spec-legal alias ("wire name"), and the stream layer
 * maps the model's echoed alias back to the host name before reporting — so
 * VS Code's tool registry only ever sees its own names.
 *
 * Determinism matters beyond dispatch: reasoning-cache fingerprints hash
 * `name:id` pairs on both the emit side and the history-replay side. Both
 * sides key on wire names, which only stay equal across requests and sessions
 * because `toWireName` is a pure function of the host name (no per-request
 * counters, no randomness).
 *
 * Earlier revisions carried a `sanitizeFunctionName` helper with
 * over-defensive rules beyond the official spec (leading-letter, collapsed
 * underscores) inherited from an upstream fork; validation anchors directly
 * on the spec instead. See
 * https://api-docs.deepseek.com/api/create-chat-completion (tools.function.name).
 */

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Over-long names compress to HEAD + "_" + TAIL + "_" + HASH = 64 chars.
 * The tail gets the larger share: VS Code MCP prefixes
 * (`activate_fallback_mcp_<server>_mcp_s_...`) are templated noise, while the
 * discriminating semantics ("...CheckSignatureCompatibility_1") sit at the
 * end — keeping them legible helps the model pick the right tool.
 */
const WIRE_NAME_MAX = 64;
const WIRE_HEAD_LEN = 22;
const WIRE_TAIL_LEN = 32;
const WIRE_HASH_LEN = 8;

export function isValidToolName(name: unknown): boolean {
	return typeof name === "string" && TOOL_NAME_RE.test(name);
}

/** FNV-1a 32-bit over UTF-16 code units, zero-padded to 8 hex chars. */
function fnv1a32Hex(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(WIRE_HASH_LEN, "0");
}

/**
 * Deterministically map a host tool name onto a DeepSeek-legal wire name.
 *
 *   - spec-legal names pass through UNCHANGED (the overwhelmingly common
 *     case — aliasing is invisible unless a name actually violates the spec);
 *   - illegal characters become `_`, and the alias carries an FNV-1a hash of
 *     the ORIGINAL name;
 *   - names too long for `sanitized_hash` compress to head + tail + hash.
 *
 * EVERY alias that differs from the host name carries the hash — not just
 * the over-long ones. Sanitization alone is lossy: `weather.get` would
 * emerge as `weather_get` and silently collide with a legitimate sibling
 * tool literally named `weather_get`, and equal-length CJK names would ALL
 * collapse to the same underscore run (`获取天气` / `发送邮件` → `____`).
 * The first-wins collision guard would then drop real tools on mundane
 * inputs. With the hash, distinct host names collide only on an FNV-32
 * collision (or a host name that happens to literally equal another name's
 * hash-suffixed alias) — vanishingly rare, and still guarded first-wins.
 *
 * Pure, deterministic, and idempotent: every output is itself spec-legal, so
 * `toWireName(toWireName(x)) === toWireName(x)`. The only unrepresentable
 * input is the empty string, which returns "" — callers must skip it (it was
 * never routable anyway).
 */
export function toWireName(name: string): string {
	if (isValidToolName(name)) {
		return name;
	}
	if (name === "") {
		return "";
	}
	const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "_");
	const hash = fnv1a32Hex(name);
	// Reaching here means the name is spec-illegal, so the alias always
	// differs from the host name and always needs the hash. When even
	// `sanitized_hash` would blow the cap, fall back to head+tail+hash.
	if (sanitized.length + 1 + WIRE_HASH_LEN <= WIRE_NAME_MAX) {
		return `${sanitized}_${hash}`;
	}
	const head = sanitized.slice(0, WIRE_HEAD_LEN);
	const tail = sanitized.slice(-WIRE_TAIL_LEN);
	return `${head}_${tail}_${hash}`;
}

/**
 * Build the wire→host reverse map for one request's tool set.
 *
 * First-wins on collision: if two DISTINCT host names produce the same wire
 * name (an FNV-32 collision on identically-sanitized names, or a host name
 * literally equal to another name's hash-suffixed alias — vanishingly rare,
 * but cheap to guard), only the first is routable; `convertTools` drops the
 * later one from the advertised tool list so the model can never call a name
 * that would dispatch to the wrong tool. Unusable names (empty / non-string)
 * are skipped entirely.
 */
export function buildWireNameMap(names: readonly unknown[]): Map<string, string> {
	const wireToHost = new Map<string, string>();
	for (const name of names) {
		if (typeof name !== "string") {
			continue;
		}
		const wire = toWireName(name);
		if (!isValidToolName(wire)) {
			continue;
		}
		if (!wireToHost.has(wire)) {
			wireToHost.set(wire, name);
		}
	}
	return wireToHost;
}
