import * as fs from "node:fs";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
import { type TUI, TuiBase, type TuiStopOptions } from "./tui.ts";
import { shouldWrapLinesToWidth, visibleWidth } from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private previousLayout: { offsets: number[]; totalRows: number } | null = null;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
		this.previousLayout = this.previousWidth > 0 ? this.rowLayout(this.previousLines, this.previousWidth) : null;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
		this.previousLayout = null;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	private lineRows(line: string, width: number): number {
		if (isImageLine(line)) return 1;
		if (!line.includes("\n")) {
			return Math.max(1, Math.ceil(visibleWidth(line) / width));
		}
		// A line may contain embedded newlines (e.g. a markdown paragraph with a hard line
		// break or inline latex spanning lines). Simulate the terminal: a bare \n advances
		// a row AND resets the column to 0 (the pty translates LF to CR+LF), so each
		// segment starts at column 0 regardless of the previous segment's width. Keeping
		// the column across a newline would overcount rows for embedded-newline lines.
		// Miscounting here is not harmless: an overcount makes the differential renderer
		// scroll a stale blank row into the scrollback, an undercount leaves stale
		// fragments behind (duplicated lines).
		const segments = line.split("\n");
		let row = 0;
		let col = 0; // column in [0, width]; col === width means a pending wrap
		for (let s = 0; s < segments.length; s++) {
			const segmentWidth = visibleWidth(segments[s]);
			if (segmentWidth > 0) {
				if (col === width) {
					row += 1; // pending wrap materialized by the next character
					col = 0;
				}
				row += Math.floor((col + segmentWidth - 1) / width);
				col = (col + segmentWidth) % width;
				if (col === 0) {
					col = width; // pending wrap at the exact row boundary
				}
			}
			if (s < segments.length - 1) {
				// A bare \n is translated to CR+LF by the terminal pty (onlcr), so it always
				// advances a row AND resets the column to 0, whether or not a pending wrap
				// was latched. Keeping the column across a newline overcounts rows for
				// embedded-newline lines (e.g. a markdown paragraph with a hard break).
				row += 1;
				col = 0;
			}
		}
		return Math.max(1, row + 1);
	}

	/**
	 * Start row (terminal) and total rows for a rendered line array. With line wrapping
	 * disabled (the default), wide lines reflow in the terminal, so each logical line
	 * maps to one or more terminal rows. Image lines occupy their reserved rows (see
	 * getKittyImageReservedRows) and their blank placeholder lines do not add rows.
	 */
	private computeRowsFrom(lines: string[], width: number, from: number, totalRows: number, offsets: number[]): number {
		let i = from;
		while (i < lines.length) {
			offsets[i] = totalRows;
			if (isImageLine(lines[i])) {
				const reservedRows = this.getKittyImageReservedRows(lines, i);
				totalRows += reservedRows;
				for (let k = 1; k < reservedRows && i + k < lines.length; k++) {
					offsets[i + k] = totalRows;
				}
				i += reservedRows;
			} else {
				totalRows += this.lineRows(lines[i], width);
				i += 1;
			}
		}
		return totalRows;
	}

	/**
	 * Start row (terminal) and total rows for a rendered line array. With line wrapping
	 * disabled (the default), wide lines reflow in the terminal, so each logical line
	 * maps to one or more terminal rows. Image lines occupy their reserved rows (see
	 * getKittyImageReservedRows) and their blank placeholder lines do not add rows.
	 */
	private rowLayout(lines: string[], width: number): { offsets: number[]; totalRows: number } {
		const offsets = new Array<number>(lines.length);
		const totalRows = this.computeRowsFrom(lines, width, 0, 0, offsets);
		return { offsets, totalRows };
	}

	/**
	 * Build the terminal-row layout for `lines`, reusing `prevLayout` for the identical
	 * prefix before `firstChanged`. Only lines at or after `firstChanged` are measured
	 * with visibleWidth, so typing or appending to a long log stays O(changed lines)
	 * instead of O(total log). Returns prevLayout itself when nothing changed.
	 */
	private buildLayout(
		lines: string[],
		width: number,
		firstChanged: number,
		prevLayout: { offsets: number[]; totalRows: number } | null,
	): { offsets: number[]; totalRows: number } {
		if (firstChanged === -1 && prevLayout) return prevLayout;
		if (prevLayout && firstChanged > 0 && firstChanged <= prevLayout.offsets.length) {
			const offsets = new Array<number>(lines.length);
			for (let i = 0; i < firstChanged; i++) {
				offsets[i] = prevLayout.offsets[i];
			}
			const prefixTotal =
				firstChanged >= prevLayout.offsets.length ? prevLayout.totalRows : prevLayout.offsets[firstChanged];
			const totalRows = this.computeRowsFrom(lines, width, firstChanged, prefixTotal, offsets);
			return { offsets, totalRows };
		}
		return this.rowLayout(lines, width);
	}

	/**
	 * Whether the terminal offset of any line in the common prefix differs between the
	 * two renderings. A shift means the previous differential position bookkeeping is
	 * invalid, so a full re-render is required. Appends and end-deletions leave the
	 * common prefix offsets unchanged and stay on the differential path.
	 */
	private rowLayoutChanged(newOffsets: number[], prevOffsets: number[], firstChanged: number): boolean {
		const from = Math.max(0, firstChanged);
		const min = Math.min(newOffsets.length, prevOffsets.length);
		for (let i = from; i < min; i++) {
			if (newOffsets[i] !== prevOffsets[i]) return true;
		}
		return false;
	}

	protected override doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		let newLines = this.render(width);

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// Terminal-row layout. With line wrapping disabled (the default), wide lines reflow
		// in the terminal into multiple rows. The identical prefix before firstChanged is
		// reused from the previous layout, so measuring visibleWidth stays proportional to
		// the changed lines rather than the whole log (a long log makes typing sluggish
		// otherwise). A width change forces a full re-measure because wrapping changes.
		const newLayout =
			widthChanged || this.previousLayout === null
				? this.rowLayout(newLines, width)
				: this.buildLayout(newLines, width, firstChanged, this.previousLayout);
		const prevLayout = this.previousLayout ?? this.rowLayout(this.previousLines, width);

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				buffer += "\x1b[2J\x1b[H\x1b[3J"; // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						buffer += "\r\n";
					}
					buffer += `\x1b[${imageReservedRows - 1}A`;
					buffer += line;
					buffer += `\x1b[${imageReservedRows - 1}B`;
					i += imageReservedRows - 1;
					continue;
				}
				buffer += line;
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLayout.totalRows - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLayout.totalRows;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLayout.totalRows);
			}
			const bufferLength = Math.max(height, newLayout.totalRows);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLayout);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousLayout = newLayout;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(this.logDirectory, "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// When line wrapping is disabled (default), wide lines reflow in the terminal
		// into multiple rows. If any line's row count changed, the previous differential
		// position bookkeeping is invalid (lines have shifted). A line's terminal row
		// count changed (it crossed a wrap boundary). The terminal has
		// NOT reflowed the content: a growing wrapped line simply overwrites the next row
		// (soft wrap is a linefeed, not an insertion), so every line below the changed line
		// is still at its old position. A full re-render here would emit \x1b[3J (clear
		// scrollback), which resets Kitty's scroll position to the bottom and yanks the
		// user out of scrolled-up history mid-stream on every wrap. Instead fall through to
		// the differential renderer and rewrite the whole tail (changed line through the
		// end): the shifted-but-unchanged lines below must be rewritten at their new rows
		// because the terminal did not move them.
		const layoutChanged = this.rowLayoutChanged(newLayout.offsets, prevLayout.offsets, firstChanged);
		if (layoutChanged) {
			logRedraw("line wrapping layout changed; rewriting tail");
		}

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLayout);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (prevLayout.totalRows > newLayout.totalRows) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLayout.totalRows - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra rows without scrolling
				const extraRows = prevLayout.totalRows - newLayout.totalRows;
				if (extraRows > height) {
					logRedraw(`extraRows > height (${extraRows} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLayout.totalRows === 0 ? 0 : 1;
				if (extraRows > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraRows; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraRows - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraRows - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLayout);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			this.previousLayout = newLayout;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line's terminal row is above the previous viewport, we need
		// a full redraw. (offsets are terminal rows, so compare against prevViewportTop.)
		const firstChangedRow = newLayout.offsets[firstChanged];
		if (firstChangedRow < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChangedRow} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		// Terminal row where the first changed logical line starts (appendStart targets
		// the last previous row so the \r\n below advances onto the new content).
		const moveTargetRow = appendStart && !layoutChanged ? prevLayout.totalRows - 1 : newLayout.offsets[firstChanged];
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		// On a layout change the unchanged lines below the changed line sit at stale rows
		// (the terminal did not shift them), so the render range must extend to the end of
		// content instead of stopping at the last textually-changed line.
		const renderEnd = layoutChanged ? newLines.length - 1 : Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				buffer += "\x1b[2K";
				for (let row = 1; row < imageReservedRows; row++) {
					buffer += "\r\n\x1b[2K";
				}
				buffer += `\x1b[${imageReservedRows - 1}A`;
				buffer += line;
				buffer += `\x1b[${imageReservedRows - 1}B`;
				i += imageReservedRows - 1;
				continue;
			}

			// Clear every terminal row the NEW version of this line will occupy, so no
			// stale columns survive on wrapped rows (the previous content at those rows
			// may be a different line entirely after mid-array edits, and a wrapped row
			// is only overwritten up to the columns the new content covers). Clearing is
			// capped at the bottom screen row: rows beyond it do not exist on screen yet
			// (the content write below creates them by scrolling, pushing real content
			// into the scrollback), and emitting extra "\r\n" pairs past the bottom row
			// would scroll a freshly-cleared blank row into the scrollback instead,
			// permanently misaligning it by one row.
			const newLineRows = this.lineRows(line, width);
			const clearRows = Math.max(1, Math.min(newLineRows, viewportTop + height - 1 - newLayout.offsets[i] + 1));
			buffer += "\x1b[2K";
			for (let r = 1; r < clearRows; r++) {
				buffer += "\r\n\x1b[2K";
			}
			if (clearRows > 1) buffer += `\x1b[${clearRows - 1}A`;
			// When line wrapping is disabled, message content is written unwrapped so the
			// terminal itself may reflow long lines - allow lines wider than the terminal.
			if (!isImage && visibleWidth(line) > width && shouldWrapLinesToWidth()) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(this.logDirectory, "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering. In the stable-layout differential
		// path the cursor ends on the last terminal row of the last changed line: the row
		// just before the start of the next line (or the content end if it is the last).
		const finalCursorRow =
			renderEnd + 1 < newLayout.offsets.length ? newLayout.offsets[renderEnd + 1] - 1 : newLayout.totalRows - 1;

		// If the previous content spanned more terminal rows, clear the extra rows.
		if (prevLayout.totalRows > newLayout.totalRows) {
			const extraRows = prevLayout.totalRows - newLayout.totalRows;
			for (let i = 0; i < extraRows; i++) {
				buffer += "\r\n\x1b[2K";
			}
			buffer += `\x1b[${extraRows}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLayout.totalRows - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLayout.totalRows);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLayout);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.previousLayout = newLayout;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param layout Terminal-row layout of the rendered lines
	 */
	private positionHardwareCursor(
		cursorPos: { row: number; col: number } | null,
		layout: { offsets: number[]; totalRows: number },
	): void {
		if (!cursorPos || layout.totalRows <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// The cursor position is logical (line index + column). Convert to the actual
		// terminal row/column, accounting for wrapped (multi-row) lines.
		const width = this.terminal.columns;
		const logicalRow = Math.max(0, Math.min(cursorPos.row, layout.offsets.length - 1));
		const wrappedRow = Math.floor(cursorPos.col / width);
		const wrappedCol = cursorPos.col % width;
		const targetRow = Math.max(0, Math.min(layout.offsets[logicalRow] + wrappedRow, layout.totalRows - 1));
		const targetCol = Math.max(0, wrappedCol);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
