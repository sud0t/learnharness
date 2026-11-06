/** The Settings rows for Auto pairs and the snippet set, and what a save writes. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { SnippetEditor, withSnippets } from "../components/settings/snippet-editor.tsx";
import { defaultSnippetData, sanitizeUserSettings, snippetDataSource, type AppearanceSettings, type SnippetData } from "../src/core/index.ts";

const own: SnippetData = { snippets: [{ trigger: "zz", replacement: "\\zeta", options: "mA" }] };

describe("withSnippets", () => {
	it("stores a set of your own", () => {
		assert.deepEqual(withSnippets({ mdRendering: { latexSnippets: true } }, own).mdRendering, { latexSnippets: true, customSnippets: own });
	});
	it("stores nothing for the defaults, so a later update of them still reaches you", () => {
		assert.deepEqual(withSnippets({ mdRendering: { customSnippets: own } }, defaultSnippetData()).mdRendering, {});
	});
	it("takes a reset out of the record", () => {
		assert.deepEqual(withSnippets({ mdRendering: { customSnippets: own, latexSnippets: false } }, null).mdRendering, { latexSnippets: false });
	});
	it("leaves the rest of the section alone", () => {
		assert.equal(withSnippets({ vimMode: true }, own).vimMode, true);
	});
	it("survives the settings sanitizer unchanged", () => {
		const stored = withSnippets({}, own);
		assert.deepEqual(sanitizeUserSettings(JSON.parse(JSON.stringify({ appearance: stored })))?.appearance?.mdRendering?.customSnippets, own);
	});
});

describe("the row", () => {
	const row = (appearance: AppearanceSettings | undefined, disabled = false) =>
		renderToStaticMarkup(<SnippetEditor appearance={appearance} onSectionChange={() => {}} disabled={disabled} />);
	it("says which set is in use", () => {
		assert.match(row(undefined), /Using the default set/);
		assert.match(row({ mdRendering: { customSnippets: own } }), /Using your own set/);
	});
	it("dims with the LaTeX snippets row", () => {
		const html = row(undefined, true);
		assert.match(html, /opacity-40/);
		assert.match(html, /disabled=""/);
	});
	it("keeps the box shut until asked", () => {
		assert.doesNotMatch(row(undefined), /snippet-editor-text/);
	});
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture(appearance: AppearanceSettings | undefined, disabled = false, answer: () => void | Promise<boolean> = () => {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	// React fills a controlled textarea through defaultValue, which linkedom leaves out.
	Object.defineProperty(Object.getPrototypeOf(doc.createElement("textarea")), "defaultValue", {
		configurable: true,
		get(this: HTMLTextAreaElement) { return this.textContent; },
		set(this: HTMLTextAreaElement, next: string) { this.textContent = next; },
	});
	Object.assign(doc, { oninput: null });
	const globals = { window: win, document: doc, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, IS_REACT_ACT_ENVIRONMENT: true };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries(globals)) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const reactRoot = createRoot(doc.getElementById("root")!);
	const writes: AppearanceSettings[] = [];
	let current = appearance;
	function draw() {
		reactRoot.render(<SnippetEditor appearance={current} disabled={disabled} onSectionChange={async (next) => {
			writes.push(next);
			const stored = await answer();
			if (stored === false) return false;
			current = next;
			draw();
			return true;
		}} />);
	}
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { reactRoot.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const find = <T extends Element = HTMLElement>(testid: string) => doc.querySelector(`[data-testid="${testid}"]`) as T | null;
	const click = async (testid: string) => { await act(async () => { (find(testid) as HTMLElement).click(); }); };
	return {
		find, click, writes,
		get text() { return (find<HTMLTextAreaElement>("snippet-editor-text")!).value; },
		/** A real change event, the one React's onChange listens for. */
		async edit(next: string) {
			const box = find<HTMLTextAreaElement>("snippet-editor-text")!;
			await act(async () => {
				const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")?.set;
				if (setter) setter.call(box, next); else box.value = next;
				box.dispatchEvent(new win.Event("input", { bubbles: true }));
			});
		},
		get errors() { return [...(find("snippet-editor-errors")?.querySelectorAll("li") ?? [])].map((item) => item.textContent); },
		get status() { return find("snippet-editor-status")?.textContent ?? null; },
	};
}

/** A probe that answers at once, and what it was asked. */
function fakeWorker(verdict: "passed" | "slow") {
	const asked: string[] = [];
	class FakeWorker {
		onmessage: ((event: { data: unknown }) => void) | null = null;
		onerror = null;
		constructor() { queueMicrotask(() => this.onmessage?.({ data: { ready: true } })); }
		postMessage({ source }: { source: string }) {
			asked.push(source);
			queueMicrotask(() => this.onmessage?.({ data: { verdict } }));
		}
		terminate() {}
	}
	Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker });
	return asked;
}
const regexSet = (trigger: string): SnippetData => ({ snippets: [{ trigger, replacement: "Y", options: "rA" }] });
/** Lets a check that crossed several awaits land. */
const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

describe("what a save reports", () => {
	afterEach(() => { delete (globalThis as Record<string, unknown>).Worker; });
	it("does not say Saved when the server refused", async () => {
		const f = await fixture(undefined, false, async () => false);
		await f.click("snippet-editor-toggle");
		await f.edit(JSON.stringify(own));
		await f.click("snippet-editor-save");
		await settled();
		assert.equal(f.writes.length, 1);
		assert.equal(f.status, "Not saved");
		assert.equal(f.text, JSON.stringify(own));
		assert.match(f.find("row-snippet-editor")?.textContent ?? "", /Using the default set/);
	});
	it("does not say Saved when the write never landed", async () => {
		const f = await fixture(undefined, false, async () => { throw new Error("no network"); });
		await f.click("snippet-editor-toggle");
		await f.edit(JSON.stringify(own));
		await f.click("snippet-editor-save");
		await settled();
		assert.equal(f.status, "Not saved");
	});
	it("waits for the server", async () => {
		let answer: (stored: boolean) => void = () => {};
		const f = await fixture(undefined, false, () => new Promise((resolve) => { answer = resolve; }));
		await f.click("snippet-editor-toggle");
		await f.edit(JSON.stringify(own));
		await f.click("snippet-editor-save");
		await settled();
		assert.notEqual(f.status, "Saved");
		await act(async () => { answer(true); });
		await settled();
		assert.equal(f.status, "Saved");
	});
	it("says nothing of a save the learner has typed past", async () => {
		let answer: (stored: boolean) => void = () => {};
		const f = await fixture(undefined, false, () => new Promise((resolve) => { answer = resolve; }));
		await f.click("snippet-editor-toggle");
		await f.edit(JSON.stringify(own));
		await f.click("snippet-editor-save");
		await settled();
		await f.edit("{ still typing");
		await act(async () => { answer(true); });
		await settled();
		assert.equal(f.status, null);
		assert.equal(f.text, "{ still typing");
	});
	it("does not say the defaults are back when the reset was refused", async () => {
		const f = await fixture({ mdRendering: { customSnippets: own } }, false, async () => false);
		await f.click("snippet-editor-toggle");
		await f.click("snippet-editor-reset");
		await settled();
		assert.equal(f.status, "Not saved");
		assert.equal(f.text, snippetDataSource(own));
	});
	it("refuses a trigger the check found too slow", async () => {
		const asked = fakeWorker("slow");
		const f = await fixture(undefined);
		await f.click("snippet-editor-toggle");
		await f.edit(JSON.stringify(regexSet("(z|z)+q")));
		await f.click("snippet-editor-save");
		await settled();
		assert.deepEqual(asked, ["(?:(z|z)+q)$"]);
		assert.equal(f.writes.length, 0);
		assert.match(f.errors[0] ?? "", /^Snippet 1: this trigger can take too long/);
		assert.equal(f.status, null);
	});
	it("saves a trigger that passes", async () => {
		fakeWorker("passed");
		const f = await fixture(undefined);
		await f.click("snippet-editor-toggle");
		await f.edit(JSON.stringify(regexSet("(\\\\d+\\\\.)+q")));
		await f.click("snippet-editor-save");
		await settled();
		assert.equal(f.writes.length, 1);
		assert.equal(f.status, "Saved");
	});
	it("refuses a trigger it could not check", async () => {
		const f = await fixture(undefined);
		await f.click("snippet-editor-toggle");
		await f.edit(JSON.stringify(regexSet("nope+q")));
		await f.click("snippet-editor-save");
		await settled();
		assert.equal(f.writes.length, 0);
		assert.match(f.errors[0] ?? "", /could not be checked/);
	});
	it("shows what a check found against a set already stored", async () => {
		fakeWorker("slow");
		const f = await fixture({ mdRendering: { customSnippets: regexSet("(y|y)+q") } });
		await f.click("snippet-editor-toggle");
		await settled();
		assert.match(f.errors[0] ?? "", /^Snippet 1: this trigger can take too long/);
	});
});

describe("the box", () => {
	it("opens on the set in use", async () => {
		const f = await fixture(undefined);
		await f.click("snippet-editor-toggle");
		assert.equal(f.text, snippetDataSource(defaultSnippetData()));
		await f.click("snippet-editor-toggle");
		assert.equal(f.find("snippet-editor-text"), null);
	});
	it("opens on your own", async () => {
		const f = await fixture({ mdRendering: { customSnippets: own } });
		await f.click("snippet-editor-toggle");
		assert.equal(f.text, snippetDataSource(own));
	});
	it("will not open while it is dimmed", async () => {
		const f = await fixture(undefined, true);
		assert.equal((f.find<HTMLButtonElement>("snippet-editor-toggle"))!.hasAttribute("disabled"), true);
		assert.equal(f.find("snippet-editor-text"), null);
	});
	it("saves a good set", async () => {
		const f = await fixture(undefined);
		await f.click("snippet-editor-toggle");
		await f.edit(JSON.stringify(own));
		await f.click("snippet-editor-save");
		assert.deepEqual(f.writes.at(-1)?.mdRendering?.customSnippets, own);
		assert.equal(f.status, "Saved");
		assert.deepEqual(f.errors, []);
	});
	for (const [name, source, error] of [
		["broken JSON", "{", /JSON/i],
		["a bad entry", `{"snippets":[{"trigger":"","replacement":"x"}]}`, /^Snippet 1:/],
		["a bad regex", `{"snippets":[{"trigger":"(","replacement":"x","options":"r"}]}`, /^Snippet 1:/],
		["a function", `{"snippets":[{"trigger":"a","replacement":"(m) => m","options":"mA"}, {"trigger":"b","replacement":5,"options":"mA"}]}`, /^Snippet 2:/],
		["no snippets at all", "[]", /./],
	] as const) {
		it(`refuses ${name}, shows why, and keeps what you wrote`, async () => {
			const f = await fixture(undefined);
			await f.click("snippet-editor-toggle");
			await f.edit(source);
			await f.click("snippet-editor-save");
			assert.equal(f.writes.length, 0);
			assert.equal(f.text, source);
			assert.match(f.errors[0] ?? "", error);
			assert.equal(f.status, null);
		});
	}
	it("takes the error away with the next keystroke", async () => {
		const f = await fixture(undefined);
		await f.click("snippet-editor-toggle");
		await f.edit("{");
		await f.click("snippet-editor-save");
		assert.equal(f.errors.length, 1);
		await f.edit("{}");
		assert.deepEqual(f.errors, []);
	});
	it("shows what is wrong with a set that was stored bad", async () => {
		const f = await fixture({ mdRendering: { customSnippets: { snippets: [{ trigger: "", replacement: "x", options: "mA" }] } } });
		await f.click("snippet-editor-toggle");
		assert.match(f.errors[0] ?? "", /^Snippet 1:/);
	});
	it("resets to the defaults and takes the set out of the record", async () => {
		const f = await fixture({ mdRendering: { customSnippets: own, latexSnippets: true } });
		await f.click("snippet-editor-toggle");
		await f.edit("{");
		await f.click("snippet-editor-reset");
		assert.deepEqual(f.writes.at(-1)?.mdRendering, { latexSnippets: true });
		assert.equal(f.text, snippetDataSource(defaultSnippetData()));
		assert.deepEqual(f.errors, []);
		assert.equal(f.status, "Back to the defaults");
	});
});
