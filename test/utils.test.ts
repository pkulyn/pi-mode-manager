import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	cleanStepText,
	columnarize,
	displayWidth,
	extractDoneSteps,
	extractTodoBlock,
	extractTodoItems,
	markCompletedSteps,
	stripAnsi,
	truncateToWidth,
} from "../utils.ts";

// ---------------------------------------------------------------------------
// extractTodoBlock
// ---------------------------------------------------------------------------

describe("extractTodoBlock", () => {
	test("extracts inner text of a <todo> block", () => {
		const msg = "prose\n\n<todo>\n1. A\n2. B\n</todo>\n\ntrailing";
		assert.equal(extractTodoBlock(msg), "\n1. A\n2. B\n");
	});

	test("returns null when no block exists", () => {
		assert.equal(extractTodoBlock("no todo block here"), null);
	});

	test("returns null when the block is unclosed", () => {
		assert.equal(extractTodoBlock("<todo>\n1. A\n"), null);
	});
});

// ---------------------------------------------------------------------------
// extractTodoItems
// ---------------------------------------------------------------------------

describe("extractTodoItems", () => {
	test("parses numbered items inside a <todo> block", () => {
		const msg = [
			"Here is my approach.",
			"",
			"<todo>",
			"1. Fix the login bug",
			"2. Add regression tests",
			"3. Update docs",
			"</todo>",
		].join("\n");
		const items = extractTodoItems(msg);
		assert.equal(items.length, 3);
		assert.deepEqual(
			items.map((i) => i.step),
			[1, 2, 3],
		);
		assert.equal(items[0].text, "Fix the login bug");
		assert.equal(items[0].completed, false);
	});

	test("parses checkbox items inside a <todo> block, keeping done state", () => {
		const msg = "<todo>\n- [x] Already done\n- [ ] Pending task\n</todo>";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 2);
		assert.equal(items[0].completed, true);
		assert.equal(items[0].text, "Already done");
		assert.equal(items[1].completed, false);
		assert.equal(items[1].text, "Pending task");
	});

	test("ignores todo-looking content OUTSIDE an existing <todo> block (anti false-positive)", () => {
		const msg = [
			"## 三、Todolist（执行顺序）",
			"[ ] A1 解析 4 个源文件，输出字段映射",
			"[ ] A2 党员基线重建，落库 670 人",
			"[ ] B1 知识库 seed 降级入库",
			"",
			"<todo>",
			"1. 真实计划第一步",
			"2. 真实计划第二步",
			"</todo>",
			"",
			"3. 原有 Plan: + 数字序号（正文里的编号，不属于 todo）",
		].join("\n");
		const items = extractTodoItems(msg);
		// 只应解析 <todo> 块内的 2 项；块外的 checkbox/编号/讨论全部忽略
		assert.equal(items.length, 2);
		assert.equal(items[0].text, "真实计划第一步");
		assert.equal(items[1].text, "真实计划第二步");
	});

	test("returns [] when no <todo> block exists, even for plan-looking prose (legacy removed)", () => {
		// 旧格式已不再被解析 —— 只认 <todo> 块；讨论/旧 plan 一律不误判
		assert.deepEqual(extractTodoItems("Plan:\n1. Read the config file\n2. Update the parser"), []);
		assert.deepEqual(
			extractTodoItems("## 三、Todolist（执行顺序）\n[ ] A1 解析 4 个源文件，输出字段映射\n[ ] A2 党员基线重建，落库 670 人"),
			[],
		);
		assert.deepEqual(extractTodoItems("- [ ] no header here\n- [ ] still no header"), []);
		assert.deepEqual(extractTodoItems("Just some text 1. numbered but no header"), []);
	});

	test("returns [] when the <todo> block has no parseable items", () => {
		const msg = "<todo>\njust some prose, no numbered/checkbox lines\n</todo>";
		assert.deepEqual(extractTodoItems(msg), []);
	});

	test("drops short, command, and dash-prefixed lines inside a <todo> block", () => {
		const msg = "<todo>\n1. ok\n2. no\n3. /command\n4. - dash\n5. `code`\n</todo>";
		assert.deepEqual(extractTodoItems(msg), []); // all filtered: too short, command, dash, code
	});

	test("parses the first <todo> block when multiple exist", () => {
		const msg = "<todo>\n1. First block A\n</todo>\n\n<todo>\n1. Second block B\n</todo>";
		const items = extractTodoItems(msg);
		assert.equal(items.length, 1);
		assert.equal(items[0].text, "First block A");
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
