/** Snippet matching and expansion. The context table is Latex Suite 1.13.3's own test. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LatexReader } from "../src/core/latex-suite/context.ts";
import { compileSnippets, defaultSnippetData, defaultSnippets, expandTabstops, findExpansion, parseSnippetSource, snippetDataErrors, snippetSetFor, unvettedSnippets, type RawSnippet, type Snippet, type SnippetSet } from "../src/core/latex-suite/snippets.ts";
import { snippetDataSource } from "../src/core/latex-suite/snippet-data.ts";
import shipped from "../src/core/latex-suite/snippets.json" with { type: "json" };

/** Type `key` at the bar and say what it does. */
function run(entries: RawSnippet[], marked: string, key: string, variables = {}) {
	const position = marked.indexOf("|"), source = marked.replace("|", "");
	const { snippets, errors } = compileSnippets(entries, variables);
	assert.deepEqual(errors, []);
	const reader = new LatexReader();
	return findExpansion(key ? snippets.automatic : snippets.onTab, snippets.macros, source, position, key, (offset) => reader.context(source, offset));
}
function typed(marked: string, keys: string) {
	const { automatic, macros } = defaultSnippets();
	const reader = new LatexReader();
	let position = marked.indexOf("|"), source = marked.replace("|", "");
	for (const key of keys) {
		const value = source;
		const found = findExpansion(automatic, macros, value, position, key, (offset) => reader.context(value, offset));
		if (found && found.snippet.guard !== "keep") {
			source = source.slice(0, found.from) + found.insert + source.slice(found.to);
			const first = [...found.tabstops].sort((a, b) => a.index[0]! - b.index[0]!)[0];
			position = found.from + (first ? first.to : found.insert.length);
		} else {
			source = source.slice(0, position) + key + source.slice(position);
			position++;
		}
	}
	return source.slice(0, position) + "|" + source.slice(position);
}

describe("context table", () => {
	const normal = [["math-text", "T"], ["math-text-specified", "Tm"], ["inline-math-text", "Tn"], ["display-math-text", "TM"], ["display-math", "M"], ["inline-math", "n"], ["code", "c"], ["math", "m"]] as const;
	const entries: (RawSnippet & { name: string })[] = [
		...normal.map(([name, options]) => ({ name, options, replacement: "", trigger: "" })),
		{ name: "math-exclude-pu", options: "m", replacement: "", trigger: "", excludedMacros: ["pu"] },
		{ name: "math-exclude-align", options: "m", replacement: "", trigger: "", excludedEnvironments: ["align"] },
		{ name: "math-include-color", options: "m", replacement: "", trigger: "", includedMacros: ["color"] },
		{ name: "math-include-begin", options: "m", replacement: "", trigger: "", includedMacros: ["begin"] },
		{ name: "math-include-pu-align", options: "m", replacement: "", trigger: "", includedMacros: ["pu"] },
	];
	const specs: { text: string; at: string; names: string[] }[] = [
		{ text: "$$\\text{}$$", at: "$$\\text{", names: ["math-text", "math-text-specified", "display-math-text"] },
		{ text: "$\\text{}$", at: "$\\text{", names: ["math-text", "inline-math-text", "math-text-specified"] },
		{ text: "$$E=mc^a$$", at: "$$E=mc^a", names: ["display-math", "math", "math-exclude-pu", "math-exclude-align"] },
		{ text: "$a$", at: "$a", names: ["inline-math", "math", "math-exclude-pu", "math-exclude-align"] },
		{ text: "```\n\n```", at: "```\n", names: ["code"] },
		{ text: "$$\\pu{}$$", at: "$$\\pu{", names: ["display-math", "math", "math-exclude-align", "math-include-pu-align"] },
		{ text: "$$\\begin{align}a&=b\\\\c&=d\\end{align}$$", at: "$$\\begin{align}a&=b\\\\c&=d", names: ["display-math", "math", "math-exclude-pu"] },
		{ text: "$$\\begin{align}a&=b\\\\c&=d\\end{align}$$", at: "$$\\begin{align", names: ["math-include-begin"] },
		{ text: "$$\\color{}$$", at: "$$\\color{", names: ["math-include-color"] },
		{ text: "$$ \\pu{ \\begin{align} &A -> B \\\\ &C -> D \\end{align} } $$", at: "$$ \\pu{ \\begin{align} &A -> B", names: ["math-include-pu-align", "display-math", "math"] },
		{ text: "$$\\pu{He2}{\\color{red}}$$", at: "$$\\pu{He2}{", names: ["display-math", "math", "math-exclude-pu", "math-exclude-align"] },
	];
	for (const { text, at, names } of specs) it(JSON.stringify(at), () => {
		const fired = entries.flatMap(({ name, ...entry }, index) => {
			const marked = `${text.slice(0, at.length)}${index}|${text.slice(at.length)}`;
			return run([{ ...entry, trigger: `(?<!\\d)${index}`, options: `r${entry.options}` }], marked, "") ? [name] : [];
		});
		assert.deepEqual(fired.sort(), [...names].sort());
	});
});

describe("matching", () => {
	it("runs before the key lands, with the key part of the trigger", () => {
		const found = run([{ trigger: "ab", replacement: "X", options: "tA" }], "a|", "b")!;
		assert.deepEqual([found.from, found.to, found.insert, found.key], [0, 1, "X", "b"]);
	});
	it("takes priority, then the longer trigger, then file order", () => {
		const entries = (a: Partial<RawSnippet>, b: Partial<RawSnippet>): RawSnippet[] => [{ trigger: "b", replacement: "first", options: "tA", ...a }, { trigger: "b", replacement: "second", options: "tA", ...b }];
		assert.equal(run(entries({}, {}), "a|", "b")!.insert, "first");
		assert.equal(run(entries({}, { priority: 1 }), "a|", "b")!.insert, "second");
		assert.equal(run(entries({}, { trigger: "ab" }), "a|", "b")!.insert, "second");
		assert.equal(run(entries({ priority: 1 }, { trigger: "ab" }), "a|", "b")!.insert, "first");
	});
	it("expands regex captures, leaving a number past them alone", () => {
		assert.equal(run([{ trigger: "(a)(b)", replacement: "[[1]][[0]][[2]]", options: "rtA" }], "a|", "b")!.insert, "ba[[2]]");
	});
	it("uses a regex's flags and substitutes variables", () => {
		assert.equal(run([{ trigger: "${V}", replacement: "X", options: "rtA", flags: "i" }], "A|", "B", { "${V}": "ab" })!.insert, "X");
	});
	it("treats captures as text only in a regex snippet", () => {
		assert.equal(run([{ trigger: "ab", replacement: "[[0]]", options: "tA" }], "a|", "b")!.insert, "[[0]]");
	});
	it("needs a delimiter on both sides for `w`", () => {
		const entries: RawSnippet[] = [{ trigger: "ab", replacement: "X", options: "tAw" }];
		assert.ok(run(entries, "a|", "b"));
		assert.ok(run(entries, " a| ", "b"));
		assert.equal(run(entries, "xa|", "b"), null);
		assert.equal(run(entries, "a|x", "b"), null);
	});
	it("keeps a Tab snippet out of typing, and the other way round", () => {
		const entries: RawSnippet[] = [{ trigger: "ab", replacement: "X", options: "t" }];
		assert.equal(run(entries, "a|", "b"), null);
		assert.equal(run(entries, "ab|", "")!.key, null);
	});
	it("is no undo step with `U`", () => assert.equal(run([{ trigger: "ab", replacement: "X", options: "tAU" }], "a|", "b")!.key, null));
	it("skips macros and environments a snippet leaves out", () => {
		const entry: RawSnippet = { trigger: "ab", replacement: "X", options: "mA", excludedMacros: ["pu"], excludedEnvironments: ["cases"] };
		assert.ok(run([entry], "$a|$", "b"));
		assert.equal(run([entry], "$\\pu{a|}$", "b"), null);
		assert.equal(run([entry], "$\\begin{cases}a|\\end{cases}$", "b"), null);
	});
	it("does not let the upstream exclusions go", () => {
		assert.equal(run([{ trigger: "([A-Za-z])(\\d)", replacement: "[[0]]_[[1]]", options: "rmA" }], "$\\ce{a|}$", "1"), null);
		assert.equal(run([{ trigger: "->", replacement: "X", options: "mA" }], "$\\ce{-|}$", ">"), null);
	});
});

describe("bounded matching", () => {
	it("still finds a trigger at the end of a long draft", () => {
		const start = "word ".repeat(4000);
		assert.ok(run([{ trigger: "ab", replacement: "X", options: "mA" }], `${start}$a|$`, "b"));
	});
	it("does not read a cut in the text as its start", () => {
		const entries: RawSnippet[] = [{ trigger: "^ab", replacement: "X", options: "rtA" }];
		assert.ok(run(entries, "a|", "b"));
		assert.equal(run(entries, `${"z".repeat(1023)}a|`, "b"), null);
		assert.equal(run(entries, `${"z\n".repeat(600)}a|`, "b"), null);
		assert.equal(run(entries, `${"z".repeat(1022)}\na|`, "b"), null);
	});
	it("still sees a line's start at a cut", () => {
		const entries: RawSnippet[] = [{ trigger: "(?<=\\n|^)ab", replacement: "X", options: "rtA" }];
		assert.ok(run(entries, `${"z".repeat(1022)}\na|`, "b"));
	});
});

describe("replacements", () => {
	it("reads stops, placeholders and literal dollars as upstream does", () => {
		assert.deepEqual(expandTabstops("${}$0{}$"), { insert: "${}{}$", tabstops: [{ index: [0], from: 3, to: 3 }] });
		assert.deepEqual(expandTabstops("${1:ab}c$2"), { insert: "abc", tabstops: [{ index: [1], from: 0, to: 2 }, { index: [2], from: 3, to: 3 }] });
		assert.deepEqual(expandTabstops("$$\n$0\n$$"), { insert: "$$\n\n$$", tabstops: [{ index: [0], from: 3, to: 3 }] });
	});
	it("trims the end in inline math only, keeping stops inside", () => {
		const entries: RawSnippet[] = [{ trigger: "ab", replacement: "x $0 ", options: "mA" }];
		const inline = run(entries, "$a|$", "b")!;
		assert.equal(inline.insert, "x");
		assert.deepEqual([inline.tabstops[0]!.from, inline.tabstops[0]!.to], [1, 1]);
		assert.equal(run(entries, "$$\na|\n$$", "b")!.insert, "x  ");
	});
	it("gives new lines the indent and quote marks of the line", () => {
		const entries: RawSnippet[] = [{ trigger: "ab", replacement: "x\n\ty$0\nz", options: "tA" }];
		assert.equal(run(entries, "\ta|", "b")!.insert, "x\n\t\ty\n\tz");
		assert.equal(run(entries, ">a|", "b")!.insert, "x\n>\ty\n>z");
		const stop = run(entries, "\ta|", "b")!.tabstops[0]!;
		assert.equal("x\n\t\ty\n\tz".slice(0, stop.from), "x\n\t\ty");
	});
});

describe("the macro guard", () => {
	it("leaves a macro being typed alone, swallowing other snippets", () => {
		assert.equal(typed("$|$", "\\alpha"), "$\\alpha|$");
		assert.equal(typed("$|$", "\\sum"), "$\\sum|$");
		assert.equal(typed("$|$", "\\top"), "$\\top|$");
	});
	it("spaces out a macro that has gone past any real one", () => {
		assert.equal(typed("$|$", "\\tox"), "$\\to x|$");
		assert.equal(typed("$|$", "\\alphax"), "$\\alpha x|$");
	});
	it("is no part of text", () => assert.equal(typed("|", "\\tox"), "\\tox|"));
	it("survives its own compile: a list with bad entries still has it", () => {
		const { snippets, errors } = compileSnippets([{ trigger: "", replacement: "x", options: "tA" }], {});
		assert.equal(errors.length, 1);
		assert.equal(snippets.automatic.filter((snippet) => snippet.guard).length, 2);
	});
});

describe("a bad entry", () => {
	it("is reported and leaves the others working", () => {
		const entries = [{ trigger: "(", replacement: "x", options: "rtA" }, { trigger: "ab", replacement: 3, options: "tA" }, { trigger: "ok", replacement: "y", options: "tA" }] as RawSnippet[];
		const { snippets, errors } = compileSnippets(entries, {});
		assert.equal(errors.length, 2);
		assert.match(errors[0]!, /^Snippet 1:/);
		assert.ok(snippets.automatic.some((snippet) => snippet.trigger === "ok"));
	});
});

describe("a learner's own set", () => {
	const good = { trigger: "ok", replacement: "y", options: "tA" };
	const errorsFor = (entry: unknown) => compileSnippets([entry as RawSnippet], {}).errors;
	it("names what is wrong with each kind of bad entry", () => {
		const cases: [unknown, RegExp][] = [
			[null, /is an object/],
			["text", /is an object/],
			[[], /is an object/],
			[{ ...good, trigger: "" }, /needs a trigger/],
			[{ replacement: "y", options: "tA" }, /needs a trigger/],
			[{ ...good, trigger: 3 }, /"trigger" has the wrong type/],
			[{ ...good, replacement: 3 }, /"replacement" has the wrong type/],
			[{ ...good, options: ["t"] }, /"options" has the wrong type/],
			[{ ...good, priority: "high" }, /"priority" has the wrong type/],
			[{ ...good, priority: null }, /"priority" has the wrong type/],
			[{ ...good, flags: 1 }, /"flags" has the wrong type/],
			[{ ...good, description: 1 }, /"description" has the wrong type/],
			[{ ...good, triggerAfter: 1 }, /"triggerAfter" has the wrong type/],
			[{ ...good, excludedEnvironments: "pmatrix" }, /"excludedEnvironments" has the wrong type/],
			[{ ...good, excludedMacros: [3] }, /"excludedMacros" has the wrong type/],
			[{ ...good, includedMacros: [{ arguments: [0] }] }, /"includedMacros" has the wrong type/],
			[{ ...good, includedMacros: [{ name: "x", arguments: ["a"] }] }, /"includedMacros" has the wrong type/],
			[{ ...good, replacment: "typo" }, /"replacment" is not a snippet field/],
			[{ ...good, constructor: "x" }, /"constructor" is not a snippet field/],
			[{ ...good, trigger: "(", options: "rtA" }, /Invalid regular expression/i],
			[{ ...good, trigger: "ab", options: "vtA" }, /single character/],
		];
		for (const [entry, message] of cases) {
			const errors = errorsFor(entry);
			assert.equal(errors.length, 1, JSON.stringify(entry));
			assert.match(errors[0]!, message);
		}
	});
	it("takes every field a snippet can have", () => {
		const entry = { trigger: "a", replacement: "b", options: "tA", flags: "i", priority: -1, description: "d", triggerAfter: "c", excludedMacros: ["x", { name: "y", arguments: [0] }], excludedEnvironments: ["pmatrix"], includedMacros: [{ name: "z" }] };
		assert.deepEqual(errorsFor(entry), []);
	});
	it("says which entry, with its trigger", () => {
		const { errors } = compileSnippets([good, { ...good, trigger: "bad", priority: "x" }] as unknown as RawSnippet[], {});
		assert.match(errors[0]!, /^Snippet 2: .* \(trigger: bad\)$/);
	});
	it("runs an entry that passes", () => {
		const { snippets, errors } = compileSnippets([good], {});
		assert.deepEqual(errors, []);
		assert.ok(snippets.automatic.some(({ trigger }) => trigger === "ok"));
	});
	it("never trips the shipped snippets on that", () => assert.deepEqual(compileSnippets(shipped.snippets as RawSnippet[], shipped.variables).errors, []));

	describe("a regex the app did not ship", () => {
		const regex = (trigger: string, options = "rmA"): RawSnippet => ({ trigger, replacement: "Y", options });
		const regexes = (set: SnippetSet) => [...set.automatic, ...set.onTab].filter((snippet) => snippet.entry !== undefined);
		const counted = (snippet: Snippet) => {
			const regexp = snippet.trigger as RegExp, exec = regexp.exec.bind(regexp);
			const log = { runs: 0 };
			regexp.exec = (text) => { log.runs++; return exec(text); };
			return log;
		};
		const fire = (set: SnippetSet, marked: string, key: string) => {
			const position = marked.indexOf("|"), source = marked.replace("|", ""), reader = new LatexReader();
			return findExpansion(set.automatic, set.macros, source, position, key, (offset) => reader.context(source, offset));
		};

		it("stays out of a set until it passes", () => {
			const data = { snippets: [good, regex("q+"), regex("w+")] };
			const held = snippetSetFor(data);
			assert.deepEqual(regexes(held).map(({ entry }) => entry).sort(), [0]);
			const some = snippetSetFor(data, ({ source }) => source.includes("q"));
			assert.deepEqual(regexes(some).map(({ entry }) => entry).sort(), [0, 1]);
		});
		it("counts its triggerAfter too", () => {
			const data = { snippets: [{ ...regex("q+"), triggerAfter: "w+" }] };
			assert.deepEqual(unvettedSnippets(data)[0]!.patterns.map(({ source }) => source), ["(?:q+)$", "^(?:w+)"]);
			assert.deepEqual(regexes(snippetSetFor(data, ({ source }) => source.includes("q"))), []);
		});
		it("lists a set by entry, and nothing the app ships", () => {
			const { snippets } = defaultSnippetData();
			const data = { snippets: [good, regex("q+"), ...snippets] };
			assert.deepEqual(unvettedSnippets(data).map(({ entry, trigger }) => [entry, trigger]), [[1, "q+"]]);
			assert.equal(regexes(snippetSetFor(data)).length, regexes(snippetSetFor(data, () => true)).length - 1);
		});
		it("does not run in prose when it only fires in math", () => {
			const { snippets } = compileSnippets([regex("q+")], {});
			const log = counted(regexes(snippets)[0]!);
			assert.equal(fire(snippets, "some prose |", "q"), null);
			assert.equal(log.runs, 0);
			assert.equal(fire(snippets, "$q|$", "q")?.insert, "Y");
			assert.equal(log.runs, 1);
		});
		it("does not run in a macro it excludes", () => {
			const { snippets } = compileSnippets([{ ...regex("q+"), excludedMacros: ["text"] }], {});
			const log = counted(regexes(snippets)[0]!);
			assert.equal(fire(snippets, "$\\text{|}$", "q"), null);
			assert.equal(log.runs, 0);
		});
		it("is left alone for the session once it takes too long", (t) => {
			t.mock.method(console, "warn", () => {});
			const { snippets } = compileSnippets([regex("q+")], {});
			const snippet = regexes(snippets)[0]!, log = counted(snippet), exec = (snippet.trigger as RegExp).exec;
			(snippet.trigger as RegExp).exec = (text) => {
				const started = performance.now();
				while (performance.now() - started < 120);
				return exec(text);
			};
			assert.equal(fire(snippets, "$q|$", "q")?.insert, "Y");
			assert.equal(log.runs, 1);
			assert.equal(fire(snippets, "$q|$", "q"), null);
			assert.equal(log.runs, 1);
		});
		it("reads no context for a set of shipped regexes", () => {
			const { automatic, macros } = defaultSnippets();
			assert.equal(findExpansion(automatic, macros, "plain", 5, "!", () => { throw new Error("read"); }), null);
		});
	});

	describe("as text from the editor", () => {
		it("round-trips the shipped set exactly", () => {
			const { data, errors } = parseSnippetSource(snippetDataSource(defaultSnippetData()));
			assert.deepEqual(errors, []);
			assert.deepEqual(data, defaultSnippetData());
		});
		it("shows one snippet to a line", () => {
			assert.equal(snippetDataSource({ snippets: [good, good] }).split("\n").filter((line) => line.includes('"trigger"')).length, 2);
		});
		it("reports text that is not JSON", () => {
			const { data, errors } = parseSnippetSource("{ snippets: [ ");
			assert.equal(data, null);
			assert.match(errors[0]!, /not valid JSON/);
		});
		it("takes no code, since JSON cannot hold it", () => {
			assert.equal(parseSnippetSource('{"snippets": [{"trigger": "a", "replacement": () => 1, "options": "tA"}]}').data, null);
		});
		it("reports the wrong outer shape", () => {
			for (const text of ["[]", "3", "null", "{}", '{"snippets": 1}', '{"snippets": [], "variables": {"a": 1}}']) {
				const { data, errors } = parseSnippetSource(text);
				assert.equal(data, null, text);
				assert.match(errors[0]!, /"snippets" list/);
			}
		});
		it("gives no data while any entry is bad, and names every one", () => {
			const { data, errors } = parseSnippetSource(JSON.stringify({ snippets: [good, { trigger: "" }, { ...good, replacement: 1 }] }));
			assert.equal(data, null);
			assert.equal(errors.length, 2);
		});
		it("uses the shipped variables when it names none", () => {
			const set = snippetSetFor({ snippets: [{ trigger: "${GREEK}x", replacement: "y", options: "rmA" }] }, () => true);
			const list = set.automatic.filter((snippet) => !snippet.guard);
			assert.match((list[0]!.trigger as RegExp).source, /alpha/);
		});
		it("uses its own variables when it names some", () => {
			const set = snippetSetFor({ variables: { "${V}": "q" }, snippets: [{ trigger: "${V}", replacement: "y", options: "rtA" }] }, () => true);
			assert.match((set.automatic.find((snippet) => !snippet.guard)!.trigger as RegExp).source, /q/);
		});
	});

	describe("at run time", () => {
		it("falls back to the shipped set with none saved", () => {
			assert.equal(snippetSetFor(null), defaultSnippets());
			assert.equal(snippetSetFor(undefined), defaultSnippets());
		});
		it("loses only the bad entry", () => {
			const set = snippetSetFor({ snippets: [good, { trigger: "(", replacement: "x", options: "rtA" }, 3, null] as unknown as RawSnippet[] });
			assert.ok(set.automatic.some(({ trigger }) => trigger === "ok"));
			assert.equal(set.automatic.filter((snippet) => snippet.guard).length, 2);
		});
		it("reads the same object once", () => {
			const data = { snippets: [good] };
			assert.equal(snippetSetFor(data), snippetSetFor(data));
		});
		it("reports a stored set's errors", () => {
			assert.equal(snippetDataErrors({ snippets: [{ trigger: 3 }] as unknown as RawSnippet[] }).length, 1);
		});
		it("runs a custom snippet through the engine", () => {
			const set = snippetSetFor({ snippets: [good] });
			const found = findExpansion(set.automatic, set.macros, "o", 1, "k", (offset) => new LatexReader().context("o", offset));
			assert.equal(found?.insert, "y");
		});
	});
});

describe("the shipped snippets", () => {
	const entries = shipped.snippets as RawSnippet[];
	const triggers = entries.map((entry) => entry.trigger);
	it("compile with no errors", () => assert.deepEqual(compileSnippets(entries, shipped.variables).errors, []));
	it("leave out what was dropped", () => {
		for (const trigger of ["chk", "prob", "K"]) assert.equal(triggers.includes(trigger), false, trigger);
		assert.equal(triggers.some((trigger) => trigger.includes("(?<marker>")), false);
	});
	it("hold no code", () => {
		for (const entry of entries) assert.equal(typeof entry.replacement, "string");
	});
	it("keep the guard out of the data, as the engine's own rule", () => assert.equal(triggers.includes(String.raw`\\[A-Za-z]{2,}`), false));
	it("leave code alone, closed or not", () => {
		for (const marked of ["Use `|", "`a|b`", "```\n|", "```\n|\n```", "~~~\n|", "``a`|", "a\n\n`|"]) {
			for (const keys of ["mk", "dm"]) {
				const position = marked.indexOf("|");
				assert.equal(typed(marked, keys), `${marked.slice(0, position)}${keys}|${marked.slice(position + 1)}`, marked);
			}
		}
	});
	it("still fire right after code, and past a backtick that opens nothing", () => {
		assert.equal(typed("`a` |", "mk"), "`a` ${}|{}$");
		assert.equal(typed("\\` |", "mk"), "\\` ${}|{}$");
		assert.equal(typed("```\nx\n```\n|", "mk"), "```\nx\n```\n${}|{}$");
		assert.equal(typed("`a\n\n|", "mk"), "`a\n\n${}|{}$");
		assert.equal(typed("$`$ |", "mk"), "$`$ ${}|{}$");
	});
	it("guard mk against firing mid-word", () => {
		assert.equal(typed("|", "mk"), "${}|{}$");
		assert.equal(typed("x|", "mk"), "xmk|");
		assert.equal(typed("|x", "mk"), "mk|x");
		assert.equal(typed("a |", "mk"), "a ${}|{}$");
	});
	it("converted the subscript rule, and in its order", () => {
		assert.equal(typed("$|$", "x2"), "$x_{2}|$");
		assert.equal(typed("$|$", "x23"), "$x_{23}|$");
		assert.equal(typed("$|$", "\\alpha2"), "$\\alpha_{2}|$");
		assert.equal(typed("$|$", "\\leq2"), "$\\leq 2|$");
		assert.equal(typed("$\\ce{|}$", "H2"), "$\\ce{H2|}$");
		assert.equal(typed("$\\pu{|}$", "m2"), "$\\pu{m2|}$");
	});
	it("converted iden", () => {
		assert.equal(typed("$|$", "iden2"), "$\\begin{pmatrix}\n1 & 0 \\\\\n0 & 1\n\\end{pmatrix}|$");
		assert.equal(typed("$|$", "iden0"), "$\\begin{pmatrix}\n\n\\end{pmatrix}|$");
	});
	it("converted the empty-line dm", () => {
		assert.equal(typed("|", "dm"), "$$\n|\n$$");
		assert.equal(typed("  |", "dm"), "  $$\n  |\n  $$");
		assert.equal(typed("> |", "dm"), "> $$\n> |\n> $$");
		assert.equal(typed("a |", "dm"), "a \n$$\n|\n$$");
	});
	it("keeps a chain working through several snippets", () => {
		assert.equal(typed("$|$", "exists"), "$\\exists|$");
		assert.equal(typed("$a|$", " alpha"), "$a \\alpha|$");
		assert.equal(typed("$x|$", "hat"), "$\\hat{x}|$");
	});
});

describe("the example in docs/keyboard.md", () => {
	const doc = readFileSync(new URL("../docs/keyboard.md", import.meta.url), "utf8");
	const { data, errors } = parseSnippetSource(/```json\n([\s\S]*?)```/.exec(doc)![1]!);
	it("is a set the editor takes", () => assert.deepEqual(errors, []));
	it("fires", () => {
		assert.equal(run(data!.snippets, "$e|$", "e", data!.variables)?.insert, "e^{  }");
		assert.equal(run(data!.snippets, "$alpha|$", "h", data!.variables)?.insert, "\\hat{\\alpha}");
	});
});
