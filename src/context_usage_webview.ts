/**
 * Webview re-creating the visual structure of VS Code 1.120's native
 * ChatContextUsageDetails popup ("Context Window" panel) for the
 * DeepSeek-owned snapshot.
 *
 * Why a webview (not a tooltip / QuickPick):
 *   - MarkdownString cannot render a real CSS progress bar or a
 *     striped reserved-for-response region.
 *   - QuickPick items are label/description/detail strings only — no
 *     button styling.
 *   - Webview gives us full HTML/CSS, and VS Code exposes the entire
 *     theme palette as CSS variables (var(--vscode-*)) so we get
 *     light/dark/high-contrast adaptation for free without writing a
 *     single hex value.
 *
 * The webview's script builds the entire body via `createElement` +
 * `textContent` — no `innerHTML` with interpolated data — so there is
 * no XSS surface even though our data sources are entirely under our
 * own control.
 *
 * Lifecycle: a single panel per workspace. Subsequent "Show Context
 * Window" calls reveal the existing panel instead of creating a new
 * one. The panel subscribes to the service's onDidChange and re-renders
 * its body via postMessage; closing the panel disposes the subscription.
 */

import * as vscode from "vscode";
import type { ContextUsageSnapshot } from "./context_usage";
import type { ContextUsageService } from "./context_usage_service";

const COMPACT_COMMAND = "deepseekv4.compactCopilotChat";
const VIEW_TYPE = "deepseekv4.contextWindow";

let currentPanel: vscode.WebviewPanel | undefined;

export function showContextUsageWebview(
	service: ContextUsageService,
	output: vscode.OutputChannel,
): void {
	const column = vscode.ViewColumn.Beside;

	if (currentPanel) {
		currentPanel.reveal(column);
		void currentPanel.webview.postMessage({
			type: "update",
			snapshot: service.getSnapshot() ?? null,
		});
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		VIEW_TYPE,
		"DeepSeek V4 Context Window",
		{ viewColumn: column, preserveFocus: true },
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		},
	);

	currentPanel = panel;
	panel.webview.html = renderHtml(panel.webview, service.getSnapshot());

	const onChange = service.onDidChange(() => {
		void panel.webview.postMessage({
			type: "update",
			snapshot: service.getSnapshot() ?? null,
		});
	});

	const onMessage = panel.webview.onDidReceiveMessage((msg: unknown) => {
		if (msg && typeof msg === "object" && (msg as { type?: string }).type === "compact") {
			void vscode.commands.executeCommand(COMPACT_COMMAND);
		}
	});

	panel.onDidDispose(() => {
		onChange.dispose();
		onMessage.dispose();
		currentPanel = undefined;
		output.appendLine("[context-webview] disposed");
	});

	output.appendLine("[context-webview] opened");
}

function renderHtml(webview: vscode.Webview, snap: ContextUsageSnapshot | undefined): string {
	const nonce = createNonce();
	const csp = [
		`default-src 'none'`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
	].join("; ");

	const initialSnapshot = JSON.stringify(snap ?? null);

	// The <script> body below uses ONLY createElement / textContent —
	// no innerHTML interpolation — so dynamic data cannot produce HTML
	// markup. Even though all of our snapshot sources are extension-
	// controlled (modelDisplayName comes from MODEL_VARIANTS literals,
	// token counts are numbers), avoiding string-based DOM construction
	// keeps the security boundary trivial to audit.
	const script = `
		const vscode = acquireVsCodeApi();
		let snapshot = ${initialSnapshot};

		function fmtK(n) {
			if (n >= 1024 * 1024) {
				const m = n / (1024 * 1024);
				return Number.isInteger(m) ? m + 'M' : m.toFixed(1) + 'M';
			}
			return (n / 1024).toFixed(1) + 'K';
		}
		function fmtNum(n) {
			return Number(n).toLocaleString();
		}
		function staleLabel(updatedAt) {
			const ageSec = Math.round((Date.now() - updatedAt) / 1000);
			if (ageSec < 60) return ageSec + 's ago';
			const ageMin = Math.round(ageSec / 60);
			if (ageMin < 60) return ageMin + 'm ago';
			return Math.round(ageMin / 60) + 'h ago';
		}

		// Tiny createElement helper. attrs may include class, id, style (string),
		// and 'data-*'. Children are appended as text nodes if string/number,
		// nodes if Element. Arrays are flattened. null/false/undefined skipped.
		function h(tag, attrs, ...children) {
			const el = document.createElement(tag);
			if (attrs) {
				for (const k of Object.keys(attrs)) {
					const v = attrs[k];
					if (v == null || v === false) continue;
					if (k === 'class') el.className = v;
					else if (k === 'id') el.id = v;
					else if (k === 'style') el.style.cssText = v;
					else el.setAttribute(k, v);
				}
			}
			const append = (c) => {
				if (c == null || c === false) return;
				if (Array.isArray(c)) { c.forEach(append); return; }
				if (typeof c === 'string' || typeof c === 'number') {
					el.appendChild(document.createTextNode(String(c)));
				} else {
					el.appendChild(c);
				}
			};
			children.forEach(append);
			return el;
		}

		function buildEmpty() {
			return [
				h('div', { class: 'empty-state' },
					'No data yet — send a chat message to populate context usage.'),
				h('div', { class: 'actions' },
					h('button', { class: 'compact-btn', id: 'compact-btn', type: 'button' },
						'Compact Conversation')),
			];
		}

		function buildUsage(snap) {
			const totalWindow = snap.maxInputTokens + snap.maxOutputTokens;
			const used = snap.usedTokens;
			const reservedOutput = snap.maxOutputTokens;
			const lastCompletion = (snap.apiCompletionTokens != null) ? snap.apiCompletionTokens : 0;
			// Single-turn footprint = prompt + completion, denominator = 1M.
			// Both are server-reported; this is the most honest "how much
			// of the shared pool did this turn use" framing.
			const footprint = used + lastCompletion;
			const usedPctOfBar = totalWindow > 0 ? (footprint / totalWindow) * 100 : 0;
			const remainingPct = Math.max(0, 100 - usedPctOfBar);
			const footprintPctStr = usedPctOfBar.toFixed(1) + '%';

			const nodes = [];

			// Header: "X / 1M total · NN.N%" — single-turn footprint.
			nodes.push(h('div', { class: 'usage-header' },
				h('div', { class: 'usage-tokens' },
					fmtK(footprint) + ' / ' + fmtK(totalWindow) + ' total'),
				h('div', { class: 'usage-percent' }, footprintPctStr),
			));

			// Progress bar — 2-segment over the 1M pool: filled + remaining.
			nodes.push(h('div', { class: 'progress-bar' },
				h('div', { class: 'filled', style: 'width:' + usedPctOfBar + '%' }),
				h('div', { style: 'width:' + remainingPct + '%' }),
			));

			// Next-turn max_tokens cap — informational, not on the bar.
			nodes.push(h('div', { class: 'reserved-legend' },
				h('span', null, 'Next response: up to ' + fmtK(reservedOutput) + ' (max_tokens cap)'),
			));

			// Model section
			nodes.push(h('div', { class: 'section' },
				h('div', { class: 'section-title' }, 'Model'),
				h('div', { class: 'row' },
					h('span', { class: 'row-label' }, snap.modelDisplayName),
					h('span', { class: 'row-value' }, snap.thinking ? 'thinking' : 'fast'),
				),
			));

			// Breakdown (estimate)
			const msgEstPctNum = snap.estimatedMessageTokens > 0
				? (snap.estimatedMessageTokens / totalWindow) * 100 : null;
			const toolEstPctNum = snap.estimatedToolTokens > 0
				? (snap.estimatedToolTokens / totalWindow) * 100 : null;
			if (msgEstPctNum !== null || toolEstPctNum !== null) {
				nodes.push(h('div', { class: 'section' },
					h('div', { class: 'section-title' },
						'Breakdown',
						h('span', { class: 'hint' }, 'local estimate'),
					),
					msgEstPctNum !== null
						? h('div', { class: 'row' },
							h('span', { class: 'row-label' }, 'Messages'),
							h('span', { class: 'row-value' }, '~' + msgEstPctNum.toFixed(1) + '%'),
						)
						: null,
					toolEstPctNum !== null
						? h('div', { class: 'row' },
							h('span', { class: 'row-label' }, 'Tools'),
							h('span', { class: 'row-value' }, '~' + toolEstPctNum.toFixed(1) + '%'),
						)
						: null,
				));
			}

			// Last API response (authoritative)
			if (snap.apiPromptTokens !== undefined && snap.apiPromptTokens !== null) {
				const cacheHit = snap.apiCacheHitTokens || 0;
				const cacheMiss = snap.apiCacheMissTokens || 0;
				const cacheHitPctStr = snap.apiPromptTokens > 0
					? ((cacheHit / snap.apiPromptTokens) * 100).toFixed(1) + '%'
					: '—';
				nodes.push(h('div', { class: 'section' },
					h('div', { class: 'section-title' },
						'Last API response',
						h('span', { class: 'hint' }, 'server-reported'),
					),
					h('div', { class: 'row' },
						h('span', { class: 'row-label' }, 'Prompt tokens'),
						h('span', { class: 'row-value' }, fmtNum(snap.apiPromptTokens)),
					),
					h('div', { class: 'row' },
						h('span', { class: 'row-label' }, 'Completion tokens'),
						h('span', { class: 'row-value' }, fmtNum(snap.apiCompletionTokens || 0)),
					),
					h('div', { class: 'row' },
						h('span', { class: 'row-label' }, 'Cache hit'),
						h('span', { class: 'row-value' }, fmtNum(cacheHit) + ' (' + cacheHitPctStr + ')'),
					),
					h('div', { class: 'row' },
						h('span', { class: 'row-label' }, 'Cache miss'),
						h('span', { class: 'row-value' }, fmtNum(cacheMiss)),
					),
					(snap.apiReasoningTokens !== undefined && snap.apiReasoningTokens !== null)
						? h('div', { class: 'row' },
							h('span', { class: 'row-label' }, 'Reasoning tokens'),
							h('span', { class: 'row-value' }, fmtNum(snap.apiReasoningTokens)),
						)
						: null,
				));
			}

			nodes.push(h('div', { class: 'stale' }, 'Last update: ' + staleLabel(snap.updatedAt)));

			nodes.push(h('div', { class: 'actions' },
				h('button', { class: 'compact-btn', id: 'compact-btn', type: 'button' },
					'Compact Conversation'),
			));

			return nodes;
		}

		function refresh() {
			const root = document.getElementById('root');
			if (!root) return;
			while (root.firstChild) root.removeChild(root.firstChild);
			const nodes = snapshot ? buildUsage(snapshot) : buildEmpty();
			nodes.forEach((n) => { if (n) root.appendChild(n); });
		}

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg && msg.type === 'update') {
				snapshot = msg.snapshot;
				refresh();
			}
		});

		document.addEventListener('click', (e) => {
			const t = e.target;
			if (t && (t.id === 'compact-btn' || (t.closest && t.closest('#compact-btn')))) {
				vscode.postMessage({ type: 'compact' });
			}
		});

		refresh();
	`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>DeepSeek V4 Context Window</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    padding: 20px 24px;
    margin: 0;
    line-height: 1.5;
  }
  h2.title {
    font-size: 1.05em;
    font-weight: 600;
    margin: 0 0 18px 0;
    color: var(--vscode-foreground);
  }
  .usage-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 10px;
  }
  .usage-tokens { font-size: 1em; color: var(--vscode-foreground); }
  .usage-percent {
    font-weight: 600;
    color: var(--vscode-foreground);
    font-variant-numeric: tabular-nums;
  }
  .progress-bar {
    height: 6px;
    background-color: var(--vscode-input-background);
    border-radius: 3px;
    overflow: hidden;
    display: flex;
    margin-bottom: 8px;
  }
  .progress-bar .filled, .progress-bar .reserved {
    height: 100%;
    transition: width 120ms linear;
  }
  .progress-bar .filled {
    background-color: var(--vscode-progressBar-background);
  }
  .progress-bar .reserved {
    background: repeating-linear-gradient(
      -45deg,
      var(--vscode-progressBar-background) 0,
      var(--vscode-progressBar-background) 4px,
      transparent 4px,
      transparent 8px
    );
    opacity: 0.7;
  }
  .reserved-legend {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 22px;
    font-size: 0.92em;
    color: var(--vscode-descriptionForeground);
  }
  .reserved-swatch {
    display: inline-block;
    width: 14px;
    height: 8px;
    border-radius: 2px;
    background: repeating-linear-gradient(
      -45deg,
      var(--vscode-progressBar-background) 0,
      var(--vscode-progressBar-background) 2px,
      transparent 2px,
      transparent 4px
    );
    opacity: 0.7;
  }
  .section { margin-top: 18px; }
  .section-title {
    font-weight: 600;
    color: var(--vscode-foreground);
    margin-bottom: 8px;
    font-size: 0.95em;
  }
  .section-title .hint {
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
    font-size: 0.9em;
  }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
  }
  .row-label { color: var(--vscode-foreground); }
  .row-value {
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
  }
  .empty-state {
    color: var(--vscode-descriptionForeground);
    padding: 24px 0;
    font-style: italic;
    text-align: center;
  }
  .stale {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    font-style: italic;
    text-align: right;
    margin-top: 12px;
  }
  .actions {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--vscode-panel-border, transparent);
    display: flex;
    justify-content: center;
  }
  button.compact-btn {
    appearance: none;
    background-color: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, var(--vscode-foreground)));
    border-radius: 4px;
    padding: 9px 16px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    cursor: pointer;
    width: 100%;
    max-width: 320px;
    box-sizing: border-box;
  }
  button.compact-btn:hover {
    background-color: var(--vscode-list-hoverBackground);
  }
  button.compact-btn:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
</style>
</head>
<body>
  <h2 class="title">Context Window</h2>
  <div id="root"></div>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

function createNonce(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 32; i++) {
		out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return out;
}
