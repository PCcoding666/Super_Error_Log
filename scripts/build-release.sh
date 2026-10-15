#!/bin/bash
# 发布打包（Task 6）：白名单方式产出云端部署包（单一 tar.gz）。
# 只打包：dist/、package.json、package-lock.json、.env.example、deploy/。
# 严禁出现：.env、照片、data/、fixtures/、node_modules、src/、tests/、iOS/、docs/、
# .git/.ai/.superpowers/.workbuddy-ai 等 VCS/工程目录。
# 用法：
#   scripts/build-release.sh [--output <dir>] [--dist <dir>] [--version <version>]
# 退出码：0 成功；1 用法/前置检查失败（不产包）。
set -euo pipefail

output_dir="."
dist_dir="dist"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
cd "${project_root}"

# 版本号必须在项目根内解析（此前的相对路径 require 在外部调用目录下会静默变成 unspecified）。
default_version() { node -p 'require("./package.json").version' 2>/dev/null || echo unspecified; }
version="${RELEASE_VERSION:-}"

usage() {
  cat <<'USAGE'
用法：scripts/build-release.sh [--output <dir>] [--dist <dir>] [--version <version>]
  --output   产包目录（默认项目根目录：脚本先切到项目根再工作）
  --dist     构建产物目录（默认 dist；须已存在且非空；包内路径固定为 dist/）
  --version  版本号（默认读 package.json 的 version 字段）
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) [[ $# -ge 2 ]] || { echo "错误：--output 需要一个参数" >&2; usage >&2; exit 1; }; output_dir="$2"; shift 2 ;;
    --dist) [[ $# -ge 2 ]] || { echo "错误：--dist 需要一个参数" >&2; usage >&2; exit 1; }; dist_dir="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || { echo "错误：--version 需要一个参数" >&2; usage >&2; exit 1; }; version="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "错误：未知参数 $1" >&2; usage >&2; exit 1 ;;
  esac
done

# --version 未给出时在项目根内解析 package.json 的 version 字段。
if [[ -z "${version}" ]]; then version="$(default_version)"; fi
# 解析失败（如 node 不在 PATH）必须 fail-hard，绝不产 unspecified 兜底包。
if [[ "${version}" == "unspecified" ]]; then
  echo "错误：无法从 package.json 解析版本号（node 不在 PATH？）；用 --version 显式指定" >&2
  exit 1
fi

# 前置检查：dist 产物必须存在且非空（fail-fast，绝不产空包）。
if [[ ! -d "${dist_dir}" ]]; then
  echo "错误：构建产物目录 ${dist_dir} 不存在；请先运行 npm run build" >&2
  exit 1
fi
if [[ -z "$(ls -A "${dist_dir}")" ]]; then
  echo "错误：构建产物目录 ${dist_dir} 为空；请先运行 npm run build" >&2
  exit 1
fi
for must_exist in package.json package-lock.json .env.example deploy/caddy/Caddyfile \
                  deploy/systemd/super-error-log.service deploy/systemd/super-error-log-caddy.service \
                  deploy/prepare-caddy-migration.mjs deploy/README.md; do
  if [[ ! -f "${must_exist}" ]]; then
    echo "错误：缺少发布白名单文件 ${must_exist}" >&2
    exit 1
  fi
done

# 版本号安全检查：产包文件名只允许字母数字、点、连字符。
if [[ ! "${version}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "错误：版本号含不安全字符：${version}" >&2
  exit 1
fi

mkdir -p "${output_dir}"
output_dir="$(cd "${output_dir}" && pwd)"
artifact="${output_dir}/super-error-log-${version}.tar.gz"

# 组装（staging 目录复制 + 白名单清单）。
staging="$(mktemp -d "${TMPDIR:-/tmp}/sel-release-staging-XXXXXX")"
trap 'rm -rf "${staging}"' EXIT
package_dir="${staging}/super-error-log"
mkdir -p "${package_dir}"

# 白名单拷贝（目录随 whitelist.txt 追加；缺任一文件即失败，绝不产残缺包）。
# fail-closed：白名单文件缺失/空 = 致命错误（否则会产出一个合法的"空包"）。
whitelist="${script_dir}/release-whitelist.txt"
if [[ ! -f "${whitelist}" ]] || [[ -z "$(grep -v '^#' "${whitelist}" | sed 's/[[:space:]]*$//' | grep -v '^$')" ]]; then
  echo "错误：发布白名单 ${whitelist} 缺失或为空" >&2
  exit 1
fi
# --dist 的语义是"打包哪个构建产物目录"：白名单中的 dist 条目按该值替换，
# 其余条目照抄。dist 目录名任意（测试注入临时合成目录走这条路径）。
effective_dist="${dist_dir}"
while IFS= read -r entry; do
  [[ -z "${entry}" ]] && continue
  if [[ "${entry}" == "dist" ]]; then
    # dist 条目：来源由 --dist 替换（合成/任意路径），包内路径固定为 dist/。
    mkdir -p "${package_dir}/dist"
    cp -R "${effective_dist}/." "${package_dir}/dist/"
    continue
  fi
  [[ -d "${entry}" ]] && { mkdir -p "${package_dir}/${entry}"; cp -R "${entry}/." "${package_dir}/${entry}/"; continue; }
  [[ -f "${entry}" ]] && { mkdir -p "${package_dir}/$(dirname "${entry}")"; cp "${entry}" "${package_dir}/${entry}"; continue; }
  echo "错误：白名单文件缺失：${entry}" >&2
  exit 1
done < <(grep -v '^#' "${whitelist}" | sed 's/[[:space:]]*$//' | grep -v '^$')
# 合成 dist（非默认值）必须真的被拷贝了：防止 --dist 指到白名单外路径时空包漏网。
if [[ ! -d "${package_dir}/dist" || -z "$(ls -A "${package_dir}/dist")" ]]; then
  echo "错误：打包产物中没有 dist 内容（--dist=${effective_dist}）" >&2
  exit 1
fi

# 归档：固定顶层目录 super-error-log/，无绝对路径。
# --no-xattrs 防平台元数据（macOS xattr）混入；--format ustar 保跨平台兼容。
if command -v tar >/dev/null 2>&1; then
  if bsdtar --help >/dev/null 2>&1 && tar --version 2>/dev/null | grep -q 'bsdtar'; then
    TAR_ARGS=(--format ustar --no-xattrs)
  else
    TAR_ARGS=(--format ustar --owner=0 --group=0 --numeric-owner)
  fi
  tar -czf "${artifact}" -C "${staging}" "${TAR_ARGS[@]}" super-error-log
else
  echo "错误：系统缺少 tar" >&2
  exit 1
fi

# 产包后自检：白名单正检——任何不在允许清单内的条目都中止（防未来白名单误加/误改）。
allowed_pattern='^super-error-log/($|dist/|deploy/|package\.json$|package-lock\.json$|\.env\.example$)'
violations="$(tar -tzf "${artifact}" | grep -Ev "${allowed_pattern}" || true)"
if [[ -n "${violations}" ]] ; then
  echo "错误：发布包出现白名单之外的条目，中止：" >&2
  echo "${violations}" >&2
  rm -f "${artifact}"
  exit 1
fi

echo "发布包已产出：${artifact}"
echo "清单：$(tar -tzf "${artifact}" | wc -l | tr -d ' ') 个条目"
