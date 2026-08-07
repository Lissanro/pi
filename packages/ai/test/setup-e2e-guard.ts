// Runs before every test file (vitest setupFiles). Cloud e2e tests activate
// on endpoint/auth env vars (`describe.skipIf(!apiKey)` and friends); stray
// API keys or base URLs in the environment must never activate them, and must
// never redirect requests (OPENAI_API_BASE pointing at a local server would
// otherwise make "openai" e2e tests hit local inference with wrong models).
// Set PI_E2E_TESTS=1 to keep the environment and run cloud e2e tests.

if (process.env.PI_E2E_TESTS !== "1") {
	const cloudEnvVars = [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"ANT_LING_API_KEY",
		"NVIDIA_API_KEY",
		"OPENAI_API_KEY",
		"OPENAI_API_BASE",
		"OPENAI_BASE_URL",
		"AZURE_OPENAI_API_KEY",
		"DEEPSEEK_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_API_KEY",
		"GOOGLE_CLOUD_API_KEY",
		"GROQ_API_KEY",
		"CEREBRAS_API_KEY",
		"XAI_API_KEY",
		"OPENROUTER_API_KEY",
		"ZAI_API_KEY",
		"ZAI_CODING_CN_API_KEY",
		"MISTRAL_API_KEY",
		"MINIMAX_API_KEY",
		"MINIMAX_CN_API_KEY",
		"MOONSHOT_API_KEY",
		"KIMI_API_KEY",
		"HF_TOKEN",
		"FIREWORKS_API_KEY",
		"TOGETHER_API_KEY",
		"AI_GATEWAY_API_KEY",
		"OPENCODE_API_KEY",
		"CLOUDFLARE_API_KEY",
		"CLOUDFLARE_ACCOUNT_ID",
		"CLOUDFLARE_GATEWAY_ID",
		"XIAOMI_API_KEY",
		"XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
		"RADIUS_API_KEY",
		"PI_GATEWAY",
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GITLAB_API_PRIVATE_TOKEN",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"AWS_PROFILE",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"BEDROCK_EXTENSIVE_MODEL_TEST",
		"BINANCE_API_KEY",
		"BINANCE_API_SECRET",
		"BSCSCAN_API_KEY",
	];
	for (const name of cloudEnvVars) {
		delete process.env[name];
	}
}
