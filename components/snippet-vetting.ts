"use client";
/**
 * Whether a learner's snippet regexes are safe to run in a box. A regex cannot be
 * stopped once it runs, so no regex of theirs reaches a box before a worker has timed
 * it on the texts most likely to make it hang: public/workers/regex-probe.js. A regex
 * the worker cannot finish is one this ends, by ending the worker. One that could not
 * be checked at all stays off, and is tried again the next time.
 */

import { useEffect, useMemo, useState } from "react";
import { patternKey, snippetSetFor, unvettedSnippets, type LatexSnippetSet, type SnippetData, type TriggerPattern } from "@/src/core";

const PROBE_URL = "/workers/regex-probe.js";
const READY_MS = 10000;
/** How late a beat can be, then again for a machine that was only busy. */
const STALL_LIMITS_MS = [300, 1500];

type Verdict = "passed" | "slow" | "unchecked";
export type Verdicts = ReadonlyMap<string, Verdict>;
type ProbeMessage = { ready?: true; beat?: true; verdict?: "passed" | "slow" };
/** What this needs of a Worker. */
export type ProbeWorker = {
	onmessage: ((event: { data: ProbeMessage }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	postMessage(message: TriggerPattern): void;
	terminate(): void;
};
type Outcome = "passed" | "slow" | "stalled" | "failed";

const browserWorker = (): ProbeWorker => new Worker(PROBE_URL) as unknown as ProbeWorker;

function started(create: () => ProbeWorker): Promise<ProbeWorker | null> {
	return new Promise((resolve) => {
		let worker: ProbeWorker;
		try { worker = create(); }
		catch { resolve(null); return; }
		const finish = (ready: boolean) => {
			clearTimeout(timer);
			worker.onmessage = worker.onerror = null;
			if (!ready) worker.terminate();
			resolve(ready ? worker : null);
		};
		const timer = setTimeout(() => finish(false), READY_MS);
		worker.onmessage = ({ data }) => { if (data.ready) finish(true); };
		worker.onerror = () => finish(false);
	});
}

function timePattern(worker: ProbeWorker, pattern: TriggerPattern, stallMs: number): Promise<Outcome> {
	return new Promise((resolve) => {
		const finish = (outcome: Outcome) => {
			clearTimeout(timer);
			worker.onmessage = worker.onerror = null;
			resolve(outcome);
		};
		let timer = setTimeout(() => finish("stalled"), stallMs);
		worker.onmessage = ({ data }) => {
			clearTimeout(timer);
			if (data.verdict) finish(data.verdict);
			else timer = setTimeout(() => finish("stalled"), stallMs);
		};
		worker.onerror = () => finish("failed");
		worker.postMessage(pattern);
	});
}

let verdicts: Verdicts = new Map();
let queue: Promise<unknown> = Promise.resolve();

function record(pattern: TriggerPattern, verdict: Verdict) {
	verdicts = new Map(verdicts).set(patternKey(pattern), verdict);
}

async function vetPatterns(patterns: readonly TriggerPattern[], create: () => ProbeWorker) {
	let worker: ProbeWorker | null = null;
	for (const pattern of patterns) {
		const known = verdicts.get(patternKey(pattern));
		if (known === "passed" || known === "slow") continue;
		let verdict: Verdict = "unchecked";
		for (const stallMs of STALL_LIMITS_MS) {
			worker ??= await started(create);
			if (!worker) break;
			const outcome: Outcome = await timePattern(worker, pattern, stallMs);
			if (outcome === "passed" || outcome === "slow") {
				verdict = outcome;
				break;
			}
			worker.terminate();
			worker = null;
			if (outcome === "failed") break;
			verdict = "slow";
		}
		record(pattern, verdict);
	}
	worker?.terminate();
}

/** One at a time, so that every box asking about one set costs one check. */
export function vetSnippets(data: SnippetData, create: () => ProbeWorker = browserWorker): Promise<Verdicts> {
	const patterns = unvettedSnippets(data).flatMap((snippet) => snippet.patterns);
	if (patterns.every((pattern) => verdicts.get(patternKey(pattern)) === "passed")) return Promise.resolve(verdicts);
	queue = queue.then(() => vetPatterns(patterns, create)).catch(() => {});
	return queue.then(() => verdicts);
}

/** What a check found against a set, entry by entry. */
export function snippetRefusals(data: SnippetData, decided: Verdicts): string[] {
	return unvettedSnippets(data).flatMap(({ entry, trigger, patterns }) => {
		const found = patterns.map((pattern) => decided.get(patternKey(pattern)));
		const at = `Snippet ${entry + 1}: `, named = ` (trigger: ${trigger})`;
		if (found.includes("slow")) return [`${at}this trigger can take too long to run, which would freeze the box${named}`];
		return found.includes("unchecked") ? [`${at}this trigger could not be checked, so it stays off${named}`] : [];
	});
}

/** A set for a box, with any regex that has not passed left out. The rest work
 *  from the start, and each regex joins them once it passes. */
export function useVettedSnippets(data: SnippetData | null | undefined): { set: LatexSnippetSet; refusals: string[] } {
	const [decided, setDecided] = useState(verdicts);
	useEffect(() => {
		if (!data) return;
		let current = true;
		void vetSnippets(data).then((next) => { if (current) setDecided(next); });
		return () => { current = false; };
	}, [data]);
	return useMemo(() => ({
		set: snippetSetFor(data, (pattern) => decided.get(patternKey(pattern)) === "passed"),
		refusals: data ? snippetRefusals(data, decided) : [],
	}), [data, decided]);
}
