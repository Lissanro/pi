/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	transport: "auto",
	sessionShareDestination: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	compaction: {
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
		summaryPlacement: "context",
		summaryBlockMaxTokens: 16384,
	},
	branchSummary: {
		reserveTokens: 16384,
		skipPrompt: false,
	},
	retry: {
		enabled: true,
		maxRetries: Number.POSITIVE_INFINITY,
		baseDelayMs: 2000,
		maxAgentDelayMs: 30000,
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	quietStartup: false,
	defaultProjectTrust: "ask",
	collapseChangelog: false,
	enableInstallTelemetry: true,
	enableAnalytics: false,
	enableSkillCommands: true,
	terminal: {
		showImages: true,
		imageWidthCells: 60,
		clearOnShrink: false,
		showTerminalProgress: false,
	},
	images: {
		autoResize: true,
		blockImages: false,
	},
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	editorPaddingX: 0,
	outputPad: 1,
	padLines: false,
	wrapLines: false,
	messageBackground: false,
	messageSeparator: true,
	tokenCountBase: 1024,
	swipeSummaryChars: 256,
	autocompleteMaxVisible: 5,
	markdown: {
		codeBlockIndent: "",
		mermaid: "streaming",
	},
	warnings: {
		anthropicExtraUsage: true,
	},
	codemode: {
		mode: "on",
		inlineBudget: 3000,
	},
	cacheWarming: "streaming",
	tuiMode: "regular",
	// Crystal defaults to the inline (regular) TUI, which lets the terminal
	// soft-wrap long lines instead of the fullscreen mode that disables
	// autowrap and truncates them.
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
} as const;
