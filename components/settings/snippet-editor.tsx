"use client";
/**
 * The LaTeX snippets as JSON. The set saves in the appearance section with the
 * other math settings, so it reaches every box the way they do and stays out of
 * the record until it differs from what ships. Nothing here can break a box:
 * text with anything wrong in it never saves, and the boxes keep the last good set.
 * Saying "Saved" waits for the server to say so.
 */

import { useRef, useState } from "react";
import { defaultSnippetData, parseSnippetSource, snippetDataErrors, snippetDataSource, type AppearanceSettings, type SnippetData } from "@/src/core";
import { snippetRefusals, useVettedSnippets, vetSnippets } from "@/components/snippet-vetting";
import { SettingsRow } from "./controls.tsx";

const isDefault = (data: SnippetData) => snippetDataSource(data) === snippetDataSource(defaultSnippetData());

/** The section with this set in place, or with none where the default will do. */
export function withSnippets(appearance: AppearanceSettings | undefined, data: SnippetData | null): AppearanceSettings {
	const { customSnippets: _replaced, ...rendering } = appearance?.mdRendering ?? {};
	return { ...appearance, mdRendering: data && !isDefault(data) ? { ...rendering, customSnippets: data } : rendering };
}

export function SnippetEditor({
	appearance,
	onSectionChange,
	disabled,
}: {
	appearance: AppearanceSettings | undefined;
	/** False if the write was refused. */
	onSectionChange: (next: AppearanceSettings) => void | Promise<boolean>;
	disabled: boolean;
}) {
	const stored = appearance?.mdRendering?.customSnippets;
	const saved = snippetDataSource(stored ?? defaultSnippetData());
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<string | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [status, setStatus] = useState<string | null>(null);
	/** Taking a new action drops whatever the last one is still waiting on. */
	const action = useRef(0);
	const { refusals } = useVettedSnippets(stored);
	const text = draft ?? saved;
	const shown = errors.length ? errors : (draft === null && stored ? [...snippetDataErrors(stored), ...refusals] : []);

	function edit(next: string) {
		action.current++;
		setDraft(next);
		setErrors([]);
		setStatus(null);
	}
	async function stores(next: AppearanceSettings) {
		try { return (await onSectionChange(next)) !== false; }
		catch { return false; }
	}
	async function save() {
		const ticket = ++action.current;
		const { data, errors: found } = parseSnippetSource(text);
		setErrors(found);
		setStatus(null);
		if (!data) return;
		setStatus("Checking");
		const refused = snippetRefusals(data, await vetSnippets(data));
		if (ticket !== action.current) return;
		if (refused.length) {
			setErrors(refused);
			setStatus(null);
			return;
		}
		const done = await stores(withSnippets(appearance, data));
		if (ticket !== action.current) return;
		if (done) setDraft(snippetDataSource(data));
		setStatus(done ? "Saved" : "Not saved");
	}
	async function reset() {
		const ticket = ++action.current;
		const done = await stores(withSnippets(appearance, null));
		if (ticket !== action.current) return;
		if (done) {
			setDraft(null);
			setErrors([]);
		}
		setStatus(done ? "Back to the defaults" : "Not saved");
	}

	return (
		<>
			<SettingsRow
				label="Your snippets"
				hint={stored ? "Using your own set" : "Using the default set"}
				testid="row-snippet-editor"
				dimmed={disabled}
			>
				<button
					type="button"
					disabled={disabled}
					onClick={() => setOpen(!open)}
					data-testid="snippet-editor-toggle"
					className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed"
				>
					{open ? "Hide" : "Edit"}
				</button>
			</SettingsRow>
			{open && !disabled && (
				<div className="flex flex-col gap-2" data-testid="snippet-editor">
					<textarea
						value={text}
						onChange={(e) => edit(e.target.value)}
						aria-label="Your snippets as JSON"
						spellCheck={false}
						wrap="off"
						data-testid="snippet-editor-text"
						className="h-72 w-full resize-y rounded-sm border border-border bg-background p-2 font-mono text-xs text-foreground outline-none"
					/>
					{shown.length > 0 && (
						<ul role="alert" data-testid="snippet-editor-errors" className="max-h-32 overflow-y-auto text-xs text-red-500">
							{shown.map((error) => <li key={error}>{error}</li>)}
						</ul>
					)}
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={() => void save()}
							data-testid="snippet-editor-save"
							className="text-xs text-foreground underline-offset-2 hover:underline"
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => void reset()}
							data-testid="snippet-editor-reset"
							className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
						>
							Reset to defaults
						</button>
						{status && <span className="text-xs text-muted-foreground/70" data-testid="snippet-editor-status">{status}</span>}
					</div>
				</div>
			)}
		</>
	);
}
