#!/usr/bin/env bash
set -euo pipefail

# Isolate user resources, credentials, temporary files, and tool configuration.
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/pi-test.XXXXXX")"
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# Mark the generated root so cleanup can verify ownership before deleting it.
touch "$test_root/.pi-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/pi-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.pi-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

# Start from an empty environment and allow only required platform and test settings.
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$test_root/home"
	"USERPROFILE=$test_root/home"
	"TMPDIR=$test_root/tmp"
	"TMP=$test_root/tmp"
	"TEMP=$test_root/tmp"
	"XDG_CONFIG_HOME=$test_root/home/.config"
	"XDG_CACHE_HOME=$test_root/cache"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$test_root/npm-userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_root/npm-globalconfig"
	"NPM_CONFIG_CACHE=$test_root/cache/npm"
	"PI_NO_LOCAL_LLM=1"
	"PI_DISABLE_CLOUD_PROVIDERS=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Native Windows needs these inherited values to launch child processes.
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# Preserve CI detection only for runner behavior and test reporting.
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# NOTE: behavior-changing PI_* vars (PI_OFFLINE, PI_SKIP_VERSION_CHECK) are
# intentionally NOT unset: tests gate themselves on these vars. PI_DISABLE_CLOUD_PROVIDERS
# is set to 1 by default so cloud-provider tests never run unless a developer
# explicitly overrides it (e.g. PI_DISABLE_CLOUD_PROVIDERS=0 ./test.sh).

# Unset API keys (see packages/ai/src/stream.ts getEnvApiKey)
unset ANTHROPIC_API_KEY
unset ANTHROPIC_OAUTH_TOKEN
unset ANT_LING_API_KEY
unset NVIDIA_API_KEY
unset OPENAI_API_KEY
unset AZURE_OPENAI_API_KEY
unset DEEPSEEK_API_KEY
unset GEMINI_API_KEY
unset GOOGLE_CLOUD_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset ZAI_CODING_CN_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset MOONSHOT_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset FIREWORKS_API_KEY
unset TOGETHER_API_KEY
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset CLOUDFLARE_API_KEY
unset CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_GATEWAY_ID
unset XIAOMI_API_KEY
unset XIAOMI_TOKEN_PLAN_CN_API_KEY
unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
unset RADIUS_API_KEY
unset PI_GATEWAY
unset PI_EXPERIMENTAL
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS
unset GOOGLE_CLOUD_PROJECT
unset GCLOUD_PROJECT
unset GOOGLE_CLOUD_LOCATION
unset AWS_PROFILE
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset AWS_REGION
unset AWS_DEFAULT_REGION
unset AWS_BEARER_TOKEN_BEDROCK
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_WEB_IDENTITY_TOKEN_FILE
unset BEDROCK_EXTENSIVE_MODEL_TEST
unset GOOGLE_API_KEY
unset GITLAB_API_PRIVATE_TOKEN
unset BINANCE_API_KEY
unset BINANCE_API_SECRET
unset BSCSCAN_API_KEY

echo "Running tests without API keys in isolated home: $test_root/home"

# Run the suite, capturing every package's vitest summary so we can aggregate a
# final total. The pipe exit status is taken from npm test (via PIPESTATUS),
# not from tee or the aggregator.
summary_file="$test_root/summary.log"
set -o pipefail
set +e
env -i "${test_env[@]}" npm test 2>&1 | tee "$summary_file"
run_status=${PIPESTATUS[0]}
set -e

# Aggregate per-package vitest tallies. Every package prints lines shaped like:
#   Test Files  241 passed | 11 skipped (252)
#       Tests  2025 passed | 143 skipped (2168)
# We sum the passed/failed/skipped numbers across all packages for a single total.
awk '
/^[[:space:]]+Tests[[:space:]]/ {
	line = $0
	# Normalize the count labels so we can total them regardless of order.
	passed = 0; failed = 0; skipped = 0
	while (match(line, /[0-9]+ (passed|failed|skipped)/)) {
		count = substr(line, RSTART, RLENGTH)
		num = count; sub(/ .*/, "", num)
		if (count ~ /passed/) passed += num
		else if (count ~ /failed/) failed += num
		else skipped += num
		line = substr(line, RSTART + RLENGTH)
	}
	TP += passed; TF += failed; TS += skipped
}
END {
	printf "\n=== TOTAL: %d passed, %d failed, %d skipped ===\n", TP, TF, TS
	if (TF > 0) exit 1
}
' "$summary_file"
summary_status=$?

# Prefer the npm test exit status; fall back to the aggregate when npm did not
# report a failure explicitly.
if [[ $run_status -ne 0 ]]; then
	exit $run_status
fi
exit $summary_status
