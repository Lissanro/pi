import type { Component } from "../tui.ts";
import { applyBackgroundToLine, isPadLinesToWidth, padLineToWidth } from "../utils.ts";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	separatorBgSample: string | undefined;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;
	// Background applied only to the top/bottom padding lines, used as a visual separator.
	private separatorBgFn?: (text: string) => string;

	// Cache for rendered output
	private cache?: RenderCache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	/** Set a background applied only to the first/last padding lines (visual separator). */
	setSeparatorBg(bgFn?: (text: string) => string): void {
		this.separatorBgFn = bgFn;
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(
		width: number,
		childLines: string[],
		bgSample: string | undefined,
		separatorBgSample: string | undefined,
	): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.separatorBgSample === separatorBgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const padEnabled = isPadLinesToWidth();
		const contentWidth = padEnabled ? Math.max(1, width - this.paddingX * 2) : width;
		const leftPad = " ".repeat(this.paddingX);

		// Render all children
		const childLines: string[] = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			for (const line of lines) {
				childLines.push(padEnabled ? leftPad + line : line);
			}
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;
		const separatorBgSample = this.separatorBgFn ? this.separatorBgFn("test") : undefined;

		// Check cache validity
		if (this.matchCache(width, childLines, bgSample, separatorBgSample)) {
			return this.cache!.lines;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applySeparatorBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applySeparatorBg("", width));
		}

		// Update cache
		this.cache = { childLines, width, bgSample, separatorBgSample, lines: result };

		return result;
	}

	private applyBg(line: string, width: number): string {
		if (this.bgFn) {
			// Background must span the full width, so pad unconditionally.
			return applyBackgroundToLine(line, width, this.bgFn);
		}
		return padLineToWidth(line, width);
	}

	private applySeparatorBg(line: string, width: number): string {
		if (this.separatorBgFn) {
			return applyBackgroundToLine(line, width, this.separatorBgFn);
		}
		return this.applyBg(line, width);
	}
}
