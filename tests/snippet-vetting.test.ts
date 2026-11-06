/** The regex check, with its real worker file on a real thread. A browser's Worker and
 *  the file's URL were driven in Chrome and in Electron 44. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { snippetRefusals, vetSnippets, type ProbeWorker } from "../components/snippet-vetting.ts";
import { patternKey, snippetSetFor, unvettedSnippets, defaultSnippets, type SnippetData, type TriggerPattern } from "../src/core/index.ts";

/** The worker file as it stands, with Node's port where a browser has `self`. */
const threaded = `
const { parentPort } = require("node:worker_threads");
globalThis.self = { postMessage: (message) => parentPort.postMessage(message) };
parentPort.on("message", (data) => self.onmessage({ data }));
${readFileSync(new URL("../public/workers/regex-probe.js", import.meta.url), "utf8")}`;

const live = new Set<Worker>();
function threadWorker(): ProbeWorker {
	const thread = new Worker(threaded, { eval: true });
	live.add(thread);
	const worker: ProbeWorker = {
		onmessage: null,
		onerror: null,
		postMessage: (message) => thread.postMessage(message),
		terminate() { live.delete(thread); void thread.terminate(); },
	};
	thread.on("message", (data) => worker.onmessage?.({ data }));
	thread.on("error", (error) => worker.onerror?.(error));
	return worker;
}
after(() => { for (const thread of live) void thread.terminate(); });

const setOf = (...triggers: string[]): SnippetData => ({ snippets: triggers.map((trigger) => ({ trigger, replacement: "Y", options: "rA" })) });

async function check(...triggers: string[]) {
	const data = setOf(...triggers);
	const verdicts = await vetSnippets(data, threadWorker);
	return { data, verdicts, refusals: snippetRefusals(data, verdicts) };
}

describe("a regex that would hang", () => {
	const reported = ["(\\w|\\d)+x", "(a|a)+x", ".*.*.*.*.*.*.*.*.*.*!x", "(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)!x"];
	const others = ["(a+)+x", "(a?){40}a{40}x", "(a*)\\1*\\1*\\1*x", "(ab|ab)+x", "\\\\foo{(.*,)+x", "(?:a|a)+", "(\\s|\\s*)+$", "([a-m]|[k-z])+!", "(aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|mm)+!"];
	for (const trigger of [...reported, ...others]) {
		it(`is refused: ${trigger}`, async () => {
			const started = performance.now();
			const { refusals } = await check(trigger);
			assert.equal(refusals.length, 1);
			assert.match(refusals[0]!, /^Snippet 1: this trigger can take too long/);
			assert.ok(performance.now() - started < 5000);
		});
	}
});

describe("a regex that is fine", () => {
	for (const trigger of ["(\\d+\\.)+", "([a-z])(\\d)", "\\\\frac{(.*)}{(.*)}", "[A-Za-z]+x", "(foo|bar)+", "(ab)+c", "\\b(\\w+)\\s\\1", "(?<=\\s)x+", "^(\\s*)-", "(\\d{1,3},)*\\d{3}", "[^\\n]*!"]) {
		it(`passes: ${trigger}`, async () => assert.deepEqual((await check(trigger)).refusals, []));
	}
});

describe("what the check cannot see", () => {
	// Its texts do not satisfy a backreference or a lookahead before the bad repeat.
	// docs/keyboard.md says so, and if this ever fails it can say less.
	for (const trigger of ["(b)\\1(a+)+x", "(?=.*z)(a+)+x"]) {
		it(`passes: ${trigger}`, async () => assert.deepEqual((await check(trigger)).refusals, []));
	}
});

describe("verdicts", () => {
	it("cost one entry, not the set", async () => {
		const { data, verdicts } = await check("(a|a)+q", "(b|c)+q");
		const set = snippetSetFor(data, (pattern) => verdicts.get(patternKey(pattern)) === "passed");
		assert.deepEqual([...set.automatic, ...set.onTab].flatMap(({ entry }) => (entry === undefined ? [] : [entry])), [1]);
	});
	it("name each entry that failed", async () => {
		const { refusals } = await check("(b|c)+r", "(d|d)+r");
		assert.equal(refusals.length, 1);
		assert.match(refusals[0]!, /^Snippet 2: .*\(trigger: \(d\|d\)\+r\)$/);
	});
	it("are kept for the session", async () => {
		let made = 0;
		const counting = () => { made++; return threadWorker(); };
		const data = setOf("(e|f)+s");
		await vetSnippets(data, counting);
		await vetSnippets(data, counting);
		assert.equal(made, 1);
	});
	it("stay unchecked if no worker can start, and are tried again", async () => {
		const data = setOf("(g|h)+t");
		const nothing = await vetSnippets(data, () => { throw new Error("no worker"); });
		assert.match(snippetRefusals(data, nothing)[0]!, /could not be checked/);
		assert.deepEqual(snippetRefusals(data, await vetSnippets(data, threadWorker)), []);
	});
	it("treat a worker that breaks as unchecked", async () => {
		const data = setOf("(i|j)+u");
		const broken = (): ProbeWorker => {
			const worker: ProbeWorker = {
				onmessage: null,
				onerror: null,
				postMessage() { queueMicrotask(() => worker.onerror?.(new Error("gone"))); },
				terminate() {},
			};
			queueMicrotask(() => worker.onmessage?.({ data: { ready: true } }));
			return worker;
		};
		assert.match(snippetRefusals(data, await vetSnippets(data, broken))[0]!, /could not be checked/);
	});
	it("ask about nothing the app ships", async () => {
		const asked: string[] = [];
		const data = { snippets: [{ trigger: "([A-Za-z])(\\d)", replacement: "[[0]]_{[[1]]}", options: "rmA" }] };
		await vetSnippets(data, () => { asked.push("started"); return threadWorker(); });
		assert.deepEqual(unvettedSnippets(data).length, 1 - Number(snippetSetFor(data).automatic.some(({ entry }) => entry === 0)));
		assert.ok(asked.length <= 1);
	});
});

describe("every regex the app ships", () => {
	it("passes, so that a good regex has room", async () => {
		const { automatic, onTab } = defaultSnippets();
		const patterns = new Map<string, TriggerPattern>();
		for (const { trigger, triggerAfter } of [...automatic, ...onTab]) {
			for (const regex of [trigger, triggerAfter]) if (regex instanceof RegExp) patterns.set(patternKey(regex), { source: regex.source, flags: regex.flags });
		}
		assert.ok(patterns.size > 20);
		const worker = threadWorker();
		await new Promise<void>((resolve) => { worker.onmessage = () => resolve(); });
		const slow: string[] = [];
		for (const pattern of patterns.values()) {
			const verdict = await new Promise((resolve) => {
				worker.onmessage = ({ data }) => { if (data.verdict) resolve(data.verdict); };
				worker.postMessage(pattern);
			});
			if (verdict !== "passed") slow.push(pattern.source);
		}
		worker.terminate();
		assert.deepEqual(slow, []);
	});
});
