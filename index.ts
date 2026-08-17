/**
 * Mode Manager Extension
 *
 * Claude Code-style mode workflow for pi:
 *   - /plan toggles mode management on/off
 *   - Alt+M cycles: Plan → Auto → Edit → Plan
 *
 * Modes:
 *   Plan  — read-only exploration + planning (edit/write/bash disabled)
 *   Auto  — full tool access, executes directly
 *   Edit  — read/write tools + search; bash requires per-command approval
 *
 * Features:
 *   - Extracts numbered plan steps from "Plan:" sections
 *   - [DONE:n] markers complete steps during execution
 *   - Footer status shows current mode
 *   - Progress widget (below editor) tracks todo completion
 *   - Session persistence via appendEntry
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractTodoItems, markCompletedSteps, columnarize, type TodoItem } from "./utils.ts";

// ---------------------------------------------------------------------------
// Mode definitions
// ---------------------------------------------------------------------------

type Mode = "plan" | "auto" | "edit";

const MODE_CYCLE: Mode[] = ["plan", "auto", "edit"];

const READ_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["edit", "write"];
const PLAN_MODE_DISABLED = new Set<string>(["edit", "write", "bash"]);
const MANAGED_TOOLS = new Set<string>([...READ_TOOLS, ...WRITE_TOOLS, "bash"]);

const MODE_LABEL: Record<Mode, string> = {
	plan: "◉ Plan",
	auto: "◉ Auto",
	edit: "◉ Edit",
};

// ANSI colors for mode status (theme-independent)
// plan = teal #009688, auto = orange-red #F37021, edit = dark blue 26
const MODE_ANSI: Record<Mode, string> = {
	plan: "\x1b[38;2;0;150;136m",
	auto: "\x1b[38;2;243;112;33m",
	edit: "\x1b[38;5;26m",
};
const ANSI_RESET = "\x1b[39m";

const MODE_INSTRUCTIONS: Record<Mode, string> = {
	plan: `[MODE: PLAN — read-only]
You are in Plan mode: analyze and plan, do NOT execute.

Restrictions (enforced by hard gate):
- edit, write, and bash are DISABLED
- Available tools: read, grep, find, ls, and other extension tools
- Any attempt to edit/write/run commands is rejected

Before planning, explore the codebase to understand the problem.
Ask clarifying questions with the questionnaire tool if needed.

Then produce a detailed numbered plan under a "Plan:" header:

# Short plan title

Plan:
1. First step description
2. Second step description
...

EXECUTION RULES:
- Do NOT start executing the plan on your own.
- Do NOT modify files or run commands — just describe what you would do.
- Present the plan and wait. The user switches to Auto or Edit mode (Alt+M) to execute.`,
	auto: `[MODE: AUTO — full access]
You are in Auto mode: full tool access. Execute the task directly.

If a plan exists (from Plan mode), execute it in order.
After completing each step, include the [DONE:n] tag in your response.`,
	edit: `[MODE: EDIT — focused editing]
You are in Edit mode: focus on locating and modifying code.

- Available tools: read, edit, write, grep, find, ls, and other extension tools
- bash commands require user approval before each execution

If a plan exists (from Plan mode), execute it step by step.
After completing each step, include the [DONE:n] tag in your response.
Work in small steps and verify after each change.`,
};

const MODE_CONTEXT_TYPES: Record<Mode, string> = {
	plan: "mode-manager-plan-context",
	auto: "mode-manager-auto-context",
	edit: "mode-manager-edit-context",
};

interface ModeManagerState {
	enabled: boolean;
	mode: Mode;
	todos?: TodoItem[];
	toolsBeforeModeManager?: string[];
	planExtractedAt?: number;
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Find the most recent assistant message containing a "Plan:" list. */
function scanForLatestPlan(ctx: ExtensionContext): { items: TodoItem[]; afterIndex: number } | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "message" &&
			"message" in entry &&
			isAssistantMessage(entry.message as AgentMessage)
		) {
			const text = getTextContent(entry.message as AssistantMessage);
			const extracted = extractTodoItems(text);
			if (extracted.length > 0) {
				return { items: extracted, afterIndex: i + 1 };
			}
		}
	}
	return null;
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function modeManagerExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let mode: Mode = "plan";
	let todoItems: TodoItem[] = [];
	let toolsBeforeModeManager: string[] | undefined;
	let planExtractedAt: number | undefined;
	let allDoneNotified = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// -----------------------------------------------------------------------
	// Tool set management
	// -----------------------------------------------------------------------

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED.has(name)),
			...READ_TOOLS,
		]);
	}

	function getEditModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => name !== "bash"),
			...READ_TOOLS,
			...WRITE_TOOLS,
		]);
	}

	function getAutoModeTools(): string[] {
		return toolsBeforeModeManager ?? [];
	}

	function applyModeTools(): void {
		const active = toolsBeforeModeManager ?? pi.getActiveTools();
		switch (mode) {
			case "plan":
				pi.setActiveTools(getPlanModeTools(active));
				break;
			case "edit":
				pi.setActiveTools(getEditModeTools(active));
				break;
			case "auto":
				pi.setActiveTools(getAutoModeTools());
				break;
		}
	}

	// -----------------------------------------------------------------------
	// UI
	// -----------------------------------------------------------------------

	function updateStatus(ctx: ExtensionContext): void {
		if (enabled) {
			ctx.ui.setStatus("mode-manager", `${MODE_ANSI[mode]}${MODE_LABEL[mode]}${ANSI_RESET}`);
		} else {
			ctx.ui.setStatus("mode-manager", undefined);
		}

		if (!enabled || todoItems.length === 0) {
			ctx.ui.setWidget("mode-manager-todos", undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const completed = todoItems.filter((t) => t.completed).length;

		// All steps done → hide the widget (it no longer conveys progress)
		if (completed >= todoItems.length) {
			ctx.ui.setWidget("mode-manager-todos", undefined);
			return;
		}

		const headingColor = MODE_ANSI[mode];
		const heading = `${headingColor}●${ANSI_RESET} ${headingColor}Plan (${completed}/${todoItems.length})${ANSI_RESET}`;
		const firstPending = todoItems.find((t) => !t.completed);
		const itemLines: string[] = [];

		todoItems.forEach((item, index) => {
			const isLast = index === todoItems.length - 1;
			const connector = theme.fg("dim", isLast ? "└─" : "├─");
			let glyph: string;
			let subject: string;
			if (item.completed) {
				glyph = `${MODE_ANSI[mode]}✓${ANSI_RESET}`; // follows active mode color
				subject = theme.fg("dim", theme.strikethrough(item.text));
			} else if (item === firstPending) {
				glyph = `${MODE_ANSI[mode]}◐${ANSI_RESET}`; // follows active mode color
				subject = theme.fg("text", item.text);
			} else {
				glyph = theme.fg("dim", "○");
				subject = theme.fg("text", item.text);
			}
			itemLines.push(`${connector} ${glyph} ${subject}`);
		});

		// Task lines may split into two side-by-side columns when the
		// single-column list would be too tall. The heading stays on its own
		// line (never part of the column layout), and each column is width-
		// capped so rows do not overflow the editor width.
		const MAX_SINGLE_COLUMN = 5;
		const MAX_COL_WIDTH = 36;
		const laidOutItems = columnarize(itemLines, MAX_SINGLE_COLUMN, MAX_COL_WIDTH);
		ctx.ui.setWidget("mode-manager-todos", [heading, ...laidOutItems], {
			placement: "belowEditor",
		});
	}

	// -----------------------------------------------------------------------
	// State transitions
	// -----------------------------------------------------------------------

	function persistState(): void {
		pi.appendEntry("mode-manager", {
			enabled,
			mode,
			todos: todoItems,
			toolsBeforeModeManager,
			planExtractedAt,
		});
	}

	// Re-scan assistant messages after planExtractedAt to rebuild completion
	// state (cumulative [DONE:n] semantics). No-op when there is no plan yet.
	function rebuildCompletionState(ctx: ExtensionContext): void {
		if (planExtractedAt === undefined || todoItems.length === 0) return;
		const entries = ctx.sessionManager.getEntries();
		const messages: AssistantMessage[] = [];
		for (let i = planExtractedAt; i < entries.length; i++) {
			const entry = entries[i];
			if (
				entry.type === "message" &&
				"message" in entry &&
				isAssistantMessage(entry.message as AgentMessage)
			) {
				messages.push(entry.message as AssistantMessage);
			}
		}
		const allText = messages.map(getTextContent).join("\n");
		markCompletedSteps(allText, todoItems);
	}

	// Recover the latest plan from session history when none is loaded (e.g.
	// the plan was produced before mode-manager was enabled, or the state
	// entry was lost after a restart). Also rebuilds completion state.
	function recoverPlanFromHistory(ctx: ExtensionContext): void {
		if (todoItems.length > 0) return;
		const recovered = scanForLatestPlan(ctx);
		if (!recovered) return;
		todoItems = recovered.items;
		planExtractedAt = recovered.afterIndex;
		allDoneNotified = false;
		rebuildCompletionState(ctx);
	}

	function enableModeManager(ctx: ExtensionContext): void {
		if (enabled) return;
		if (toolsBeforeModeManager === undefined) {
			toolsBeforeModeManager = pi.getActiveTools();
		}
		enabled = true;
		mode = "plan";
		todoItems = [];
		planExtractedAt = undefined;
		allDoneNotified = false;
		// Recover a plan produced before mode-manager was enabled
		recoverPlanFromHistory(ctx);
		applyModeTools();
		ctx.ui.notify(
			"Plan mode ON. Alt+M: switch Plan→Auto→Edit. /plan: exit.",
			"info",
		);
		updateStatus(ctx);
		persistState();
	}

	function disableModeManager(ctx: ExtensionContext): void {
		if (!enabled) return;
		enabled = false;
		mode = "plan";
		todoItems = [];
		if (toolsBeforeModeManager !== undefined) {
			pi.setActiveTools(toolsBeforeModeManager);
		}
		toolsBeforeModeManager = undefined;
		ctx.ui.notify("Mode manager disabled. Full tool access restored.", "info");
		updateStatus(ctx);
		persistState();
	}

	function toggleModeManager(ctx: ExtensionContext): void {
		if (enabled) disableModeManager(ctx);
		else enableModeManager(ctx);
	}

	function cycleMode(ctx: ExtensionContext): void {
		if (!enabled) {
			enableModeManager(ctx);
			return;
		}
		const idx = MODE_CYCLE.indexOf(mode);
		mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
		// Recover a plan when switching modes without one loaded
		recoverPlanFromHistory(ctx);
		applyModeTools();
		ctx.ui.notify(`Mode: ${MODE_LABEL[mode]}`, "info");
		updateStatus(ctx);
		persistState();
	}

	// -----------------------------------------------------------------------
	// Commands & shortcuts
	// -----------------------------------------------------------------------

	pi.registerCommand("plan", {
		description: "Toggle mode manager (Plan/Auto/Edit; Alt+M to cycle)",
		handler: async (_args, ctx) => toggleModeManager(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems
				.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
				.join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.alt("m"), {
		description: "Cycle mode: Plan → Auto → Edit",
		handler: async (ctx) => cycleMode(ctx),
	});

	// -----------------------------------------------------------------------
	// Hard gate: tool enforcement
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;

		// Plan mode: block write tools AND bash entirely
		if (mode === "plan") {
			if (WRITE_TOOLS.includes(event.toolName)) {
				return {
					block: true,
					reason: `Plan mode: ${event.toolName} blocked. Switch to Auto or Edit mode (Alt+M) to make changes.`,
				};
			}
			if (event.toolName === "bash") {
				return {
					block: true,
					reason: "Plan mode: bash disabled. Switch to Auto or Edit mode (Alt+M) to run commands.",
				};
			}
			return;
		}

		// Edit mode: bash requires per-command approval
		if (mode === "edit" && event.toolName === "bash") {
			const command = event.input?.command as string | undefined;
			if (typeof command !== "string") return;
			if (!ctx.hasUI) {
				return { block: true, reason: "Edit mode: bash requires approval (no UI available)." };
			}
			const choice = await ctx.ui.select(
				`⚠️ Edit mode: run bash command?\n\n  ${command}\n\nAllow?`,
				["Allow", "Deny"],
			);
			if (choice !== "Allow") {
				return { block: true, reason: "bash command denied by user." };
			}
		}
	});

	// -----------------------------------------------------------------------
	// Context injection & filtering
	// -----------------------------------------------------------------------

	// Filter out stale mode instructions from previous modes
	pi.on("context", async (event) => {
		if (!enabled) return;

		const currentType = MODE_CONTEXT_TYPES[mode];
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType && Object.values(MODE_CONTEXT_TYPES).includes(msg.customType)) {
					return msg.customType === currentType;
				}
				return true;
			}),
		};
	});

	// Inject mode instructions before agent starts
	pi.on("before_agent_start", async () => {
		if (!enabled) return;
		return {
			message: {
				customType: MODE_CONTEXT_TYPES[mode],
				content: MODE_INSTRUCTIONS[mode],
				display: false,
			},
		};
	});

	// -----------------------------------------------------------------------
	// Plan progress tracking
	// -----------------------------------------------------------------------

	pi.on("turn_end", async (event, ctx) => {
		if (!enabled || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		// Count how many NEW steps this turn's [DONE:n] markers marked complete
		const updated = markCompletedSteps(text, todoItems);
		const completed = todoItems.filter((t) => t.completed).length;

		// Notify ONLY when THIS turn transitioned the plan to fully complete.
		// (allDoneNotified is not persisted: after a restart/session restore the
		// todos come back already-completed, so without the `updated > 0` guard a
		// stale completed plan would re-fire the completion toast on every turn.)
		if (completed === todoItems.length && updated > 0 && !allDoneNotified) {
			allDoneNotified = true;
			if (ctx.hasUI) {
				ctx.ui.notify("🎉 Plan completed — todo list collapsed (/todos to review)", "info");
			}
		}

		updateStatus(ctx);
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!enabled) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		const text = getTextContent(lastAssistant);
		const extracted = extractTodoItems(text);
		if (extracted.length > 0 && mode === "plan") {
			todoItems = extracted;
			planExtractedAt = ctx.sessionManager.getEntries().length;
			allDoneNotified = false;
			persistState();
			updateStatus(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Plan captured (${todoItems.length} steps). Switch to Auto/Edit (Alt+M) to execute.`,
					"info",
				);
			}
		}
	});

	// -----------------------------------------------------------------------
	// Session restore
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			enabled = true;
			mode = "plan";
		}

		const entries = ctx.sessionManager.getEntries();
		const modeManagerEntry = entries
			.filter(
				(e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "mode-manager",
			)
			.pop() as { data?: ModeManagerState } | undefined;

		if (modeManagerEntry?.data) {
			enabled = modeManagerEntry.data.enabled ?? enabled;
			mode = modeManagerEntry.data.mode ?? mode;
			todoItems = modeManagerEntry.data.todos ?? todoItems;
			toolsBeforeModeManager = modeManagerEntry.data.toolsBeforeModeManager ?? toolsBeforeModeManager;
			planExtractedAt = modeManagerEntry.data.planExtractedAt;

			// Re-scan assistant messages after the plan was extracted to rebuild
			// completion state (cumulative [DONE:n] semantics)
			rebuildCompletionState(ctx);
		}

		// Fall back to scanning history for the latest plan (e.g. the state
		// entry is missing after a restart, or the plan was produced before
		// mode-manager was enabled)
		recoverPlanFromHistory(ctx);

		if (enabled) {
			applyModeTools();
		}
		updateStatus(ctx);
	});
}
