"use strict";
// Minimal `vscode` replacement for adapter tests. Records calls, returns preset
// answers, adds no behaviour of its own. Only the API surface used by
// src/utils.ts, src/provider.ts and src/extension.ts exists here.

class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}
class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
	static json(value, mime = "application/json") {
		return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime);
	}
	static image(data, mime) {
		return new LanguageModelDataPart(data, mime);
	}
	static text(value, mime = "text/plain") {
		return new LanguageModelDataPart(new TextEncoder().encode(value), mime);
	}
}
class MarkdownString {
	constructor(value = "") {
		this.value = value;
		this.isTrusted = false;
		this.supportThemeIcons = false;
	}
	appendMarkdown(s) {
		this.value += s;
		return this;
	}
}
class ThemeIcon {
	constructor(id) {
		this.id = id;
	}
}
class ThemeColor {
	constructor(id) {
		this.id = id;
	}
}
class Disposable {
	constructor(fn) {
		this._fn = fn;
	}
	dispose() {
		if (this._fn) {
			this._fn();
			this._fn = undefined;
		}
	}
}
class EventEmitter {
	constructor() {
		this._listeners = new Set();
		this.event = (listener) => {
			this._listeners.add(listener);
			return new Disposable(() => this._listeners.delete(listener));
		};
	}
	fire(e) {
		for (const l of [...this._listeners]) {
			l(e);
		}
	}
	dispose() {
		this._listeners.clear();
	}
}
class CancellationTokenSource {
	constructor() {
		this._em = new EventEmitter();
		this.token = { isCancellationRequested: false, onCancellationRequested: this._em.event };
	}
	cancel() {
		this.token.isCancellationRequested = true;
		this._em.fire();
	}
	dispose() {
		this._em.dispose();
	}
}
const Uri = {
	parse: (s) => ({ scheme: s.split(":")[0], value: s, toString: () => s }),
};

const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
const LanguageModelChatToolMode = { Auto: 1, Required: 2 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const ViewColumn = { Active: -1, Beside: -2, One: 1 };

function freshCalls() {
	return {
		showErrorMessage: [],
		showWarningMessage: [],
		showInformationMessage: [],
		showInputBox: [],
		setStatusBarMessage: [],
		executeCommand: [],
		registerCommand: [],
		registerProvider: [],
		openExternal: [],
		withProgress: [],
	};
}
function freshAnswers() {
	return {
		showErrorMessage: undefined,
		showWarningMessage: undefined,
		showInformationMessage: undefined,
		showInputBox: undefined,
		getConfiguration: {},
		getCommands: [],
		extension: undefined,
	};
}
const __shim = {
	calls: freshCalls(),
	answers: freshAnswers(),
	registeredCommands: new Map(),
	outputChannels: [],
	statusBarItems: [],
	reset() {
		this.calls = freshCalls();
		this.answers = freshAnswers();
		this.registeredCommands.clear();
		this.outputChannels.length = 0;
		this.statusBarItems.length = 0;
		this.removeThinkingPart();
	},
	// `LanguageModelThinkingPart` is pre-declared as an own property of
	// module.exports (value `undefined`) so TS's `__importStar` — which
	// snapshots Object.getOwnPropertyNames once, at the first
	// `require("vscode")` — installs a LIVE forwarding getter for it. These
	// two therefore only ever ASSIGN; `delete` would drop the own property
	// and, after the snapshot, the getter could never see it come back.
	installThinkingPart() {
		module.exports.LanguageModelThinkingPart = class LanguageModelThinkingPart {
			constructor(value, id, metadata) {
				this.value = value;
				this.id = id;
				this.metadata = metadata;
			}
		};
	},
	removeThinkingPart() {
		module.exports.LanguageModelThinkingPart = undefined;
	},
};

// A preset answer may be a value or a function of (message, items).
function answer(name, message, items) {
	const a = __shim.answers[name];
	return typeof a === "function" ? a(message, items) : a;
}

function makeOutputChannel(name) {
	const ch = {
		name,
		lines: [],
		appendLine(s) {
			this.lines.push(String(s));
		},
		append(s) {
			this.lines.push(String(s));
		},
		show() {},
		hide() {},
		clear() {
			this.lines.length = 0;
		},
		dispose() {},
		text() {
			return this.lines.join("\n");
		},
	};
	__shim.outputChannels.push(ch);
	return ch;
}
function makeStatusBarItem() {
	const item = {
		text: "",
		tooltip: undefined,
		color: undefined,
		backgroundColor: undefined,
		command: undefined,
		shown: 0,
		show() {
			this.shown++;
		},
		hide() {},
		dispose() {},
	};
	__shim.statusBarItems.push(item);
	return item;
}

const window = {
	showErrorMessage: async (message, ...rest) => {
		const items = rest.filter((r) => typeof r === "string");
		__shim.calls.showErrorMessage.push({ message, items });
		return answer("showErrorMessage", message, items);
	},
	showWarningMessage: async (message, ...rest) => {
		const items = rest.filter((r) => typeof r === "string");
		__shim.calls.showWarningMessage.push({ message, items });
		return answer("showWarningMessage", message, items);
	},
	showInformationMessage: async (message, ...rest) => {
		const items = rest.filter((r) => typeof r === "string");
		__shim.calls.showInformationMessage.push({ message, items });
		return answer("showInformationMessage", message, items);
	},
	showInputBox: async (opts) => {
		__shim.calls.showInputBox.push(opts);
		return answer("showInputBox", opts, []);
	},
	setStatusBarMessage: (text, ms) => {
		__shim.calls.setStatusBarMessage.push({ text, ms });
		return new Disposable();
	},
	withProgress: async (opts, task) => {
		__shim.calls.withProgress.push(opts);
		return task({ report() {} }, new CancellationTokenSource().token);
	},
	createOutputChannel: (name) => makeOutputChannel(name),
	createStatusBarItem: () => makeStatusBarItem(),
	createWebviewPanel: () => {
		throw new Error("createWebviewPanel is not available in the test shim");
	},
};
const commands = {
	// Divergence: an UNREGISTERED id resolves to undefined here, whereas real
	// VS Code rejects with `command '<id>' not found`. Suites that need the
	// rejection must register a throwing handler.
	executeCommand: async (id, ...args) => {
		__shim.calls.executeCommand.push({ id, args });
		const handler = __shim.registeredCommands.get(id);
		return handler ? handler(...args) : undefined;
	},
	registerCommand: (id, handler) => {
		__shim.registeredCommands.set(id, handler);
		__shim.calls.registerCommand.push(id);
		return new Disposable(() => __shim.registeredCommands.delete(id));
	},
	getCommands: async () => [...__shim.answers.getCommands],
};
const workspace = {
	getConfiguration: (section) => ({
		get: (key, def) => {
			const s = __shim.answers.getConfiguration[section] ?? {};
			return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : def;
		},
	}),
};
const env = {
	openExternal: async (uri) => {
		__shim.calls.openExternal.push(String(uri));
		return true;
	},
};
const lm = {
	registerLanguageModelChatProvider: (vendor, provider) => {
		__shim.calls.registerProvider.push({ vendor, provider });
		return new Disposable();
	},
};
const extensions = {
	getExtension: () => __shim.answers.extension,
};

module.exports = {
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelDataPart,
	// Declared up front (value `undefined` = "host without ThinkingPart", the
	// default) purely so __importStar sees the key. __shim.installThinkingPart()
	// / removeThinkingPart() flip it; __shim.reset() restores the default.
	LanguageModelThinkingPart: undefined,
	MarkdownString,
	ThemeIcon,
	ThemeColor,
	Disposable,
	EventEmitter,
	CancellationTokenSource,
	Uri,
	LanguageModelChatMessageRole,
	LanguageModelChatToolMode,
	StatusBarAlignment,
	ProgressLocation,
	ViewColumn,
	window,
	commands,
	workspace,
	env,
	lm,
	extensions,
	version: "1.106.0-shim",
	__shim,
};
