/**
 * Pure utility functions for mode-manager.
 * Extracted for testability.
 */

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

/** Normalize step text: strip markdown, prefixes, collapse whitespace. */
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 60) {
		cleaned = `${cleaned.slice(0, 57)}...`;
	}
	return cleaned;
}

/** Extract plan steps from a "Plan:" section or a Todolist/任务清单 checklist.
 *
 * Supported headers (optionally prefixed by a heading marker and/or a Chinese
 * section number, e.g. "## 三、Todolist（执行顺序）"):
 *   - "Plan:" / "## Plan: <title>"
 *   - "Todolist" / "任务清单" / "待办事项" / "待办清单"
 *
 * Supported item syntax:
 *   - numbered: "1. step" / "1) step"
 *   - checkbox: "- [ ] step" / "[ ] step" / "- [x] step" (done state kept)
 */
export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerPattern =
		/^\s*(?:#{1,6}\s*)?\*{0,2}(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:Plan\s*:|Todolist|任务清单|待办事项|待办清单)[^\n]*$/im;
	const headerMatch = message.match(headerPattern);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
	const checkboxPattern = /^\s*(?:[-*]\s+)?\[\s*([ xX]?)\s*\]\s+([^*\n]+)/gm;

	const pushStep = (raw: string, done: boolean): void => {
		const text = raw
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: done });
			}
		}
	};

	for (const match of planSection.matchAll(numberedPattern)) pushStep(match[2], false);
	for (const match of planSection.matchAll(checkboxPattern)) pushStep(match[2], /[xX]/.test(match[1]));
	return items;
}

/** Strip ANSI escape sequences (256-color etc). */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Display width: CJK/wide chars count as 2 columns. */
export function displayWidth(text: string): number {
	let w = 0;
	for (const ch of stripAnsi(text)) {
		w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
	}
	return w;
}

/**
 * Layout widget lines as up to two side-by-side columns when the list would
 * be too tall. Returns lines unchanged when <= maxSingleColumn entries.
 * Right column is padded to align with the left column (CJK-aware).
 * When maxColWidth is given, each column is truncated to that display width
 * (CJK-aware, ANSI-preserving, appends "…") so rows never overflow the
 * editor width.
 */
export function columnarize(lines: string[], maxSingleColumn: number, maxColWidth?: number): string[] {
	const clamp = (s: string) => (maxColWidth ? truncateToWidth(s, maxColWidth) : s);
	if (lines.length <= maxSingleColumn) return lines.map(clamp);
	const colSize = Math.ceil(lines.length / 2);
	const left = lines.slice(0, colSize).map(clamp);
	const right = lines.slice(colSize).map(clamp);
	const leftWidth = Math.max(...left.map(displayWidth));
	const out: string[] = [];
	for (let i = 0; i < left.length; i++) {
		const l = left[i];
		const r = right[i] ?? "";
		const pad = " ".repeat(Math.max(2, leftWidth - displayWidth(l) + 2));
		out.push(`${l}${pad}${r}`);
	}
	return out;
}

/** Truncate a line to the given display width (CJK-aware, ANSI-preserving). */
export function truncateToWidth(text: string, maxWidth: number): string {
	if (displayWidth(text) <= maxWidth) return text;
	let out = "";
	let w = 0;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\x1b") {
			const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (m) {
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		const cw = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
		if (w + cw > maxWidth - 1) break;
		out += ch;
		w += cw;
		i++;
	}
	// Reset any unterminated style sequences introduced before the cut point
	return `${out}\x1b[0m…`;
}

/** Extract [DONE:n] / [DONE:all] markers from an assistant message.
 *
 * Only standalone markers count: markers inside range/list expressions such
 * as "[DONE:1]~[DONE:5]" or "[DONE:1]-[DONE:3]" (prose examples) are
 * ignored, so mentioning marker syntax in text cannot false-complete steps.
 */
export function extractDoneSteps(message: string): Array<number | "all"> {
	const steps: Array<number | "all"> = [];
	for (const match of message.matchAll(/(?<![~\-])\[DONE:(\d+|all|\*)\](?![~\-])/gi)) {
		const raw = match[1].toLowerCase();
		if (raw === "all" || raw === "*") {
			steps.push("all");
			continue;
		}
		const step = Number(raw);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/** Mark todo items completed per [DONE:n] markers. Returns number updated.
 *
 * Cumulative semantics: [DONE:n] marks steps 1..n complete (plan steps are
 * executed in order). n may exceed the current list length (agent reports its
 * own step counter); [DONE:all] marks every item complete.
 */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	let updated = 0;
	for (const step of doneSteps) {
		const upper = step === "all" ? Number.POSITIVE_INFINITY : step;
		for (const item of items) {
			if (item.step <= upper && !item.completed) {
				item.completed = true;
				updated += 1;
			}
		}
	}
	return updated;
}
