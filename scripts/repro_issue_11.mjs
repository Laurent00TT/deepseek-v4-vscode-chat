// Repro + verify for issue #11 — cache_control sentinel pollution.
// Mirrors the BUGGY pre-fix logic and the FIXED post-fix logic of
// `collectToolResultText` in src/utils.ts. Does not import vscode (only
// available inside the extension host).

// Local stub matching vscode.LanguageModelTextPart's shape — the script does
// not import vscode (only available inside the extension host). The mirrored
// `collectToolResultText_*` functions below use `instanceof` against this
// local class to model the same dispatch the production code does against
// the real vscode class.
class LanguageModelTextPart {
    constructor(value) {
        this.value = value;
    }
}

// BUGGY version — what 0.3.4 ships. else-branch JSON.stringify pollutes output.
function collectToolResultText_buggy(pr) {
    let text = "";
    for (const c of pr.content ?? []) {
        if (c instanceof LanguageModelTextPart) {
            text += c.value;
        } else if (typeof c === "string") {
            text += c;
        } else {
            try {
                text += JSON.stringify(c);
            } catch {
                /* ignore */
            }
        }
    }
    return text;
}

// FIXED version — defensive whitelist. Drops anything not text/string,
// including the LanguageModelDataPart cache_control sentinel.
function collectToolResultText_fixed(pr) {
    let text = "";
    for (const c of pr.content ?? []) {
        if (c instanceof LanguageModelTextPart) {
            text += c.value;
        } else if (typeof c === "string") {
            text += c;
        }
        // Drop anything else (cache_control sentinel, future unknown parts).
    }
    return text;
}

const realFileContent = `import QtQuick

ApplicationWindow {
    width: 800
    height: 600
}
`;

const cacheControlPart = {
    $mid: 24,
    mimeType: "cache_control",
    data: "ZXBoZW1lcmFs",
};

const fakeToolResult = {
    content: [
        new LanguageModelTextPart(realFileContent),
        cacheControlPart,
    ],
};

const buggy = collectToolResultText_buggy(fakeToolResult);
const fixed = collectToolResultText_fixed(fakeToolResult);

console.log("=== BUGGY (0.3.4) output ===");
console.log(buggy);
console.log("=== END ===\n");

console.log("=== FIXED output ===");
console.log(fixed);
console.log("=== END ===\n");

const buggyOk = buggy.includes("cache_control") && buggy.includes("ZXBoZW1lcmFs");
const fixedOk =
    fixed === realFileContent &&
    !fixed.includes("cache_control") &&
    !fixed.includes("ZXBoZW1lcmFs") &&
    !fixed.includes("$mid");

console.log("Buggy reproduces pollution:", buggyOk ? "YES" : "NO");
console.log("Fixed eliminates pollution:", fixedOk ? "YES" : "NO");
console.log("Fixed equals raw file content:", fixed === realFileContent ? "YES" : "NO");

process.exit(buggyOk && fixedOk ? 0 : 1);
