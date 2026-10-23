#!/bin/bash
# Claude Code 云端会话启动脚本：装好 Node 24、npm 依赖和 Playwright Chromium，
# 让 typecheck / build / vitest / playwright 开箱即用。只在云端运行，本机直接退出。
# 等价于 docs/CODEX_CLOUD_HANDOFF.md「Cloud环境启动与验证」和 .github/workflows/ci.yml 的安装步骤。
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# package.json engines 要求 node >= 24（用到 node:sqlite）；云端镜像默认是 Node 22，用镜像自带的 nvm 安装。
# 已装过就直接用，不再联网查最新版本。nvm.sh 不兼容 set -eu，加载期间临时关闭。
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
set +eu
. "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null 2>&1 || nvm install 24 >&2
NODE_BIN="$(dirname "$(nvm which 24)")"
set -eu
export PATH="$NODE_BIN:$PATH"

# 锁文件里的下载地址都指向 registry.npmmirror.com；与 CI 一样改从官方源下载，sha512 校验照常执行。
export NPM_CONFIG_REPLACE_REGISTRY_HOST=always

# 让会话里后续的命令也用 Node 24。
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PATH=\"$NODE_BIN:\$PATH\""
    echo "export NPM_CONFIG_REPLACE_REGISTRY_HOST=always"
  } >> "$CLAUDE_ENV_FILE"
fi

# 用 install 而不是 ci：容器缓存里已有 node_modules 时几乎不用重装。--no-save 保证不改写 package-lock.json。
npm install --no-save --no-audit --no-fund >&2

# 必须在 Vitest 之前装：tests/globalSetup.ts 用 Chromium 生成合成试卷，pdfService 也用它生成 PDF。
# 镜像预装的 Chromium 版本与仓库锁定的 @playwright/test 不一致，按锁定版本下载到 PLAYWRIGHT_BROWSERS_PATH；已装过则跳过。
npx playwright install chromium >&2

echo "Cloud dev environment ready: node $(node --version), npm deps installed, Playwright $(npx playwright --version | awk '{print $2}') Chromium installed."
