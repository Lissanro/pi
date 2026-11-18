import {
	type ChildLines,
	type Component,
	dispatchMouseToChildLines,
	renderChildLines,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";
import { applyBackgroundToLine, flattenLines, isPadLinesToWidth, padLineToWidth } from "../utils.ts";

type RenderCache = {
	childLines: readonly string[];
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
	private childLines?: ChildLines;

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

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = undefined;
		this.childLines = undefined;
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const padEnabled = isPadLinesToWidth();
		const contentWidth = padEnabled ? Math.max(1, event.width - this.paddingX * 2) : event.width;
		const contentY = event.y - this.paddingY;
		const contentX = padEnabled ? event.x - this.paddingX : event.x;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		const layout =
			this.childLines?.width === contentWidth
				? this.childLines
				: renderChildLines(this.children, contentWidth, undefined);
		return dispatchMouseToChildLines(layout, { ...event, x: contentX, y: contentY, width: contentWidth });
	}

	render(width: number): readonly string[] {
		if (this.children.length === 0) {
			return [];
		}

		const padEnabled = isPadLinesToWidth();
		const contentWidth = padEnabled ? Math.max(1, width - this.paddingX * 2) : width;
		const leftPad = " ".repeat(this.paddingX);

		// Keep the child lines unpadded: unchanged children keep their line array, so the cache check
		// below is one identity comparison. Padding here would create new strings every frame.
		this.childLines = renderChildLines(this.children, contentWidth, this.childLines);
		const childLines = this.childLines.lines;

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;
		const separatorBgSample = this.separatorBgFn ? this.separatorBgFn("test") : undefined;

		// Check cache validity
		const cache = this.cache;
		if (
			cache?.childLines === childLines &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.separatorBgSample === separatorBgSample
		) {
			return cache.lines;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applySeparatorBg("", width));
		}

		// Content. leftPad is added only when padLinesToWidth is enabled: without it lines keep
		// only their own content (trailing spaces pollute terminal copy/paste), while a set
		// background still spans the full width.
		for (const line of childLines) {
			result.push(this.applyBg(padEnabled ? leftPad + line : line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applySeparatorBg("", width));
		}

		// Update cache
		flattenLines(result);
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
