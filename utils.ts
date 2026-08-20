/**
 * Pure utility functions for pi-plan-mode.
 * Extracted for testability.
 */

import { visibleWidth, truncateToWidth as tuiTruncateToWidth } from "@earendil-works/pi-tui";

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

/** Extract the inner text of an explicit <todo>...</todo> block.
 * Returns null when no well-formed block exists in the message. */
export function extractTodoBlock(message: string): string | null {
	const m = message.match(/<todo>([\s\S]*?)<\/todo>/i);
	return m ? m[1] : null;
}

/** Parse numbered/checkbox todo lines from a text section into TodoItems. */
function parseTodoSection(section: string): TodoItem[] {
	const items: TodoItem[] = [];
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

	for (const match of section.matchAll(numberedPattern)) pushStep(match[2], false);
	for (const match of section.matchAll(checkboxPattern)) pushStep(match[2], /[xX]/.test(match[1]));
	return items;
}

/** Extract todo items from an assistant message.
 *
 * ONLY an explicit <todo>...</todo> block is parsed. When a block is present
 * and yields items, ONLY the block is used — anything outside the tags is
 * ignored, so ordinary prose that merely discusses plan/todo syntax can
 * never be mistaken for a plan. Returns [] when there is no block or the
 * block contains no parseable items.
 *
 * This is the format the Plan-mode instructions tell the model to emit
 * (marker convention), so mis-detection is structurally impossible for
 * well-behaved output. Legacy header heuristics ("Plan:" / Todolist /
 * checkbox guessing) were deliberately removed: no regex can exhaust all
 * LLM output formats, and any fallback reintroduces the false-positive risk.
 */
export function extractTodoItems(message: string): TodoItem[] {
	const block = extractTodoBlock(message);
	if (block === null) return [];
	return parseTodoSection(block);
}

/** Strip ANSI escape sequences (256-color etc). */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Display width: delegate to pi-tui's visibleWidth (CJK + emoji aware) so
 * layout math matches the widget renderer exactly. This fixes right-column
 * misalignment when a line contains emoji (e.g. 🎉) that terminals render at
 * 2 cells but a hand-rolled regex counted as 1. */
export function displayWidth(text: string): number {
	return visibleWidth(text);
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

/** Truncate a line to the given display width (CJK + emoji aware, ANSI-preserving).
 * Delegates to pi-tui's truncateToWidth so width semantics match rendering. */
export function truncateToWidth(text: string, maxWidth: number): string {
	return tuiTruncateToWidth(text, maxWidth, "…");
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
