#!/bin/zsh
# 高保真 E2E：用生产入口 dist/main.js 启动云端模式 + 学生邀请码网关，真实百炼模型，数据放在仓库 data/hf-e2e-20261107/（gitignored）。
set -u
REPO=/Users/chengpeng/MyProject/Super_Error_Log
cd "$REPO"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_USE_ENV_PROXY ALL_PROXY all_proxy
export NODE_ENV=production
export SEL_MOBILE_MODE=cloud
export SEL_STUDENT_HOST_ENABLED=1
export SEL_MOBILE_PORT=3177
export SEL_MOBILE_DATA_DIR="$REPO/data/hf-e2e-20261107/mobile"
export SEL_DATA_DIR="$REPO/data/hf-e2e-20261107/app"
export SEL_STUDENT_HOST_DIR="$REPO/data/hf-e2e-20261107/student-host"
export SEL_MAX_LIVE_WORKERS=3
# 可选：如果本机有有效的 Token Plan 密钥，放在 $HF_TOKEN_PLAN_KEY_FILE 里（一行），就按生产那样主用 Token Plan、按量备用。
if [[ -n "${HF_TOKEN_PLAN_KEY_FILE:-}" && -s "${HF_TOKEN_PLAN_KEY_FILE}" ]]; then export SEL_TOKEN_PLAN_API_KEY="$(head -1 "$HF_TOKEN_PLAN_KEY_FILE" | tr -d '\r\n')"; fi
mkdir -p "$SEL_MOBILE_DATA_DIR" "$SEL_DATA_DIR" "$SEL_STUDENT_HOST_DIR"
exec node dist/main.js
