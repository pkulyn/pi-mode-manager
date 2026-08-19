import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	cleanStepText,
	columnarize,
	displayWidth,
	extractDoneSteps,
	extractTodoItems,
	markCompletedSteps,
	stripAnsi,
	truncateToWidth,
} from "../utils.ts";

// ---------------------------------------------------------------------------
// extractTodoItems
// ---------------------------------------------------------------------------

describe("extractTodoItems", () => {
	test("extracts numbered steps after a Plan: header", () => {
		const msg = "Here is my plan\n\nPlan:\n1. Read the config file\n2. Update the parser\n3. Write tests";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 3);
		assert.deepEqual(
			items.map((i) => i.step),
			[1, 2, 3],
		);
		assert.equal(items[0].text, "Config file"); // leading verb "Read the " is stripped
		assert.equal(items[0].completed, false);
	});

	test("ignores non-numbered lines", () => {
		const msg = "Plan:\n- not a numbered step\nSome prose\n1. A real step";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 1);
		assert.equal(items[0].text, "A real step");
	});

	test("returns empty when no Plan: header", () => {
		assert.deepEqual(extractTodoItems("Just some text 1. numbered but no header"), []);
	});

	test("supports bold header and parenthesized numbering", () => {
		const msg = "**Plan:**\n1) Setup environment\n2) Install dependencies";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 2);
		assert.equal(items[1].text, "Dependencies"); // leading verb "Install " is stripped
	});

	test("drops short, command, and dash-prefixed lines", () => {
		const msg = "Plan:\n1. ok\n2. no\n3. /command\n4. - dash\n5. `code`";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 0); // all filtered: too short, command, dash, code
	});

	test("collects numbered lines from the first Plan: header onward", () => {
		const msg = "Plan:\n1. Old step\n\nPlan:\n1. New step A\n2. New step B";
		const items = extractTodoItems(msg);
		// Semantics: everything after the first Plan: header is one plan section;
		// later numbered lines are appended (revisions are rare in one message).
		assert.equal(items.length, 3);
		assert.equal(items[0].text, "Old step");
	});

	test("accepts a same-line title after Plan: (## Plan: <title>)", () => {
		const msg = "## Plan: ework 收尾 + AGENTS.md 精简\n\n1. **删除已失效的 JWT 文件**\n2. **AGENTS.md 新增保密章节**\n3. 同步更新记忆文档";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 3);
		assert.deepEqual(
			items.map((i) => i.step),
			[1, 2, 3],
		);
		assert.equal(items[0].text, "删除已失效的 JWT 文件");
	});

	test("extracts checkbox steps under a Todolist header with Chinese section number", () => {
		const msg = [
			"## 一、背景",
			"Some prose here.",
			"",
			"## 三、Todolist（执行顺序）",
			"",
			"```",
			"[ ] A1 解析 4 个源文件，输出字段映射",
			"[ ] A2 党员基线重建，落库 670 人",
			"[ ] B1 知识库 seed 降级入库",
			"[ ] 收尾：全量验证 + 更新 memory.md",
			"```",
			"",
			"## 四、风险提示",
			"- 注意外键关联，任何一步不符即回滚",
		].join("\n");
		const items = extractTodoItems(msg);
		assert.equal(items.length, 4);
		assert.deepEqual(
			items.map((i) => i.step),
			[1, 2, 3, 4],
		);
		assert.equal(items[0].text, "A1 解析 4 个源文件，输出字段映射");
		assert.equal(items[0].completed, false);
		assert.equal(items[3].text, "收尾：全量验证 + 更新 memory.md");
	});

	test("supports bullet-checkbox and keeps done state ([x])", () => {
		const msg = "Todolist\n- [x] Already done step\n- [ ] Pending step";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 2);
		assert.equal(items[0].completed, true);
		assert.equal(items[1].completed, false);
		assert.equal(items[1].text, "Pending step");
	});

	test("supports 任务清单 header", () => {
		const msg = "## 三、任务清单\n[ ] 准备开发环境\n[ ] 编写核心代码";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 2);
		assert.equal(items[0].text, "准备开发环境");
	});

	test("checkbox lines without a recognized header are ignored", () => {
		assert.deepEqual(extractTodoItems("- [ ] no header here\n- [ ] still no header"), []);
	});

	test("prose with brackets but no checkbox syntax is not matched", () => {
		const msg = "Plan:\n- use [config] as the source of truth\n1. Real numbered step";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 1);
		assert.equal(items[0].text, "Real numbered step");
	});
});

// ---------------------------------------------------------------------------
// cleanStepText
// ---------------------------------------------------------------------------

describe("cleanStepText", () => {
	test("strips markdown emphasis and code", () => {
		assert.equal(cleanStepText("**Bold** and `code`"), "Bold and code");
	});

	test("removes leading action verbs", () => {
		assert.equal(cleanStepText("Update the config file"), "Config file");
	});

	test("collapses whitespace and trims", () => {
		assert.equal(cleanStepText("  Fix   the   bug  "), "Fix the bug");
	});

	test("capitalizes the first character", () => {
		assert.equal(cleanStepText("improve performance"), "Improve performance");
	});

	test("truncates over-long text with ellipsis", () => {
		const long = "a".repeat(80);
		assert.equal(cleanStepText(long).length, 60); // 57 chars + "..."
	});
});

// ---------------------------------------------------------------------------
// extractDoneSteps / markCompletedSteps
// ---------------------------------------------------------------------------

	describe("extractDoneSteps", () => {
		test("parses multiple markers, case-insensitive", () => {
			assert.deepEqual(extractDoneSteps("[DONE:1] [done:2] [DONE:ALL]"), [1, 2, "all"]);
		});

		test("supports * wildcard", () => {
			assert.deepEqual(extractDoneSteps("[DONE:*]"), ["all"]);
		});

		test("ignores non-marker text", () => {
			assert.deepEqual(extractDoneSteps("no markers here"), []);
		});

		test("ignores markers inside range expressions (prose examples)", () => {
			assert.deepEqual(extractDoneSteps("from [DONE:1]~[DONE:5] markers"), []);
			assert.deepEqual(extractDoneSteps("[DONE:1]-[DONE:3]"), []);
			assert.deepEqual(extractDoneSteps("[DONE:5]~ continues"), []);
		});

		test("still parses standalone markers adjacent to text", () => {
			assert.deepEqual(extractDoneSteps("Step 3 done [DONE:3]"), [3]);
			assert.deepEqual(extractDoneSteps("[DONE:all] everything"), ["all"]);
		});
	});

describe("markCompletedSteps", () => {
	const items = () => [
		{ step: 1, text: "A", completed: false },
		{ step: 2, text: "B", completed: false },
		{ step: 3, text: "C", completed: false },
	];

	test("[DONE:n] marks steps 1..n cumulatively", () => {
		const copy = items();
		const updated = markCompletedSteps("[DONE:2]", copy);
		assert.equal(updated, 2);
		assert.deepEqual(
			copy.map((i) => i.completed),
			[true, true, false],
		);
	});

	test("n beyond list length marks all items", () => {
		const copy = items();
		markCompletedSteps("[DONE:5]", copy);
		assert.deepEqual(
			copy.map((i) => i.completed),
			[true, true, true],
		);
	});

	test("[DONE:all] and [DONE:*] mark everything", () => {
		for (const marker of ["[DONE:all]", "[DONE:*]"]) {
			const copy = items();
			markCompletedSteps(marker, copy);
			assert.deepEqual(
				copy.map((i) => i.completed),
				[true, true, true],
			);
		}
	});

	test("already-completed items are not double counted", () => {
		const copy = items();
		copy[0].completed = true;
		const updated = markCompletedSteps("[DONE:2]", copy);
		assert.equal(updated, 1);
	});
});

// ---------------------------------------------------------------------------
// stripAnsi / displayWidth
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
	test("removes SGR sequences", () => {
		assert.equal(stripAnsi("\x1b[38;5;130mPlan\x1b[39m"), "Plan");
		assert.equal(stripAnsi("\x1b[38;2;243;112;33m●\x1b[39m"), "●");
	});

	test("handles text without ANSI", () => {
		assert.equal(stripAnsi("plain"), "plain");
	});
});

describe("displayWidth", () => {
	test("CJK chars count as 2 columns", () => {
		assert.equal(displayWidth("abc"), 3);
		assert.equal(displayWidth("中文"), 4);
		assert.equal(displayWidth("a中b"), 4);
	});

	test("ignores ANSI escape codes", () => {
		assert.equal(displayWidth("\x1b[38;5;130mPlan\x1b[39m"), 4);
	});
});

// ---------------------------------------------------------------------------
// truncateToWidth
// ---------------------------------------------------------------------------

describe("truncateToWidth", () => {
	test("returns text unchanged when within width", () => {
		assert.equal(truncateToWidth("abc", 10), "abc");
	});

	test("truncates with ellipsis, CJK-aware", () => {
		const out = truncateToWidth("abcdefghij", 5);
		assert.equal(out, "abcd\x1b[0m…");
		assert.ok(displayWidth(out) <= 5);
	});

	test("does not split a wide char across the cut", () => {
		const out = truncateToWidth("a中bcdef", 4);
		assert.equal(out, "a中\x1b[0m…"); // a(1) + 中(2) fits in 3, b would exceed
		assert.ok(displayWidth(out) <= 4);
	});

	test("preserves ANSI sequences across the cut", () => {
		const out = truncateToWidth("\x1b[38;5;130mabcdefghij", 6);
		assert.ok(out.startsWith("\x1b[38;5;130m"));
		assert.ok(out.endsWith("\x1b[0m…"));
	});
});

// ---------------------------------------------------------------------------
// columnarize
// ---------------------------------------------------------------------------

describe("columnarize", () => {
	test("returns lines unchanged when at or below maxSingleColumn", () => {
		const lines = ["a", "b", "c"];
		assert.deepEqual(columnarize(lines, 5), lines);
	});

	test("splits into two balanced side-by-side columns", () => {
		const lines = ["1", "2", "3", "4", "5", "6"];
		const out = columnarize(lines, 5);
		assert.equal(out.length, 3);
		assert.ok(out[0].startsWith("1"));
		assert.ok(out[0].includes("4"));
		assert.ok(out[1].startsWith("2"));
		assert.ok(out[2].startsWith("3"));
	});

	test("right column padded with CJK-aware alignment", () => {
		const out = columnarize(["aa", "中文", "bb"], 2);
		assert.equal(out.length, 2);
		// "aa" padded to width of "中文" (4) + gap → first line starts "aa  bb"
		assert.ok(out[0].startsWith("aa"));
		assert.ok(out[0].includes("bb"));
	});

	test("truncates each column to maxColWidth", () => {
		const long = "x".repeat(50);
		const out = columnarize([long], 5, 36);
		assert.ok(out[0].includes("…"));
		assert.ok(displayWidth(out[0]) <= 37); // 36 + ellipsis
	});
});
