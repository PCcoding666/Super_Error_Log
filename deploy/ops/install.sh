#!/usr/bin/env bash
# 安装运维脚本与 systemd 定时器（管理员 root 执行；详见 deploy/ops/RUNBOOK.md）。
#
#   sudo bash /opt/super-error-log/current/deploy/ops/install.sh --dry-run   # 先看会做什么
#   sudo bash /opt/super-error-log/current/deploy/ops/install.sh             # 安装（不启用定时器）
#   sudo bash /opt/super-error-log/current/deploy/ops/install.sh --enable    # 安装并启用三个定时器
#
# 脚本被复制成 root 所有的固定副本（/usr/local/lib/sel-ops），定时任务只运行这份副本；
# 以后合并到 main 的新版本不会自动生效，需要再执行一次本脚本（与 deploy/ci 的发布程序同一原则）。
# 不会覆盖已有的 /etc/super-error-log/ops.env、alert.env。不删除任何数据。
# SEL_OPS_PREFIX 只给测试用：把所有目标路径放到一个临时目录下。
set -euo pipefail

dry_run=0
enable=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --enable) enable=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${SEL_OPS_PREFIX:-}"
lib_dir="${prefix}/usr/local/lib/sel-ops"
unit_dir="${prefix}/etc/systemd/system"
etc_dir="${prefix}/etc/super-error-log"
backup_dir="${prefix}/var/backups/super-error-log-daily"
state_dir="${prefix}/var/lib/sel-ops"
app_user="${SEL_OPS_APP_USER:-supererrorlog}"

if [[ "$dry_run" -eq 0 && -z "$prefix" && "$(id -u)" -ne 0 ]]; then
  echo "需要 root（或先加 --dry-run 看计划）" >&2
  exit 1
fi

run() {
  if [[ "$dry_run" -eq 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

owner_args=()
if [[ -z "$prefix" ]]; then owner_args=(-o root -g root); fi

run install -d -m 0755 "${owner_args[@]}" "$lib_dir"
for file in lib.mjs sel-backup.mjs sel-restore.mjs sel-healthcheck.mjs; do
  run install -m 0755 "${owner_args[@]}" "$source_dir/$file" "$lib_dir/$file"
done
run install -d -m 0755 "$unit_dir"
for unit in sel-backup.service sel-backup.timer sel-healthcheck.service sel-healthcheck.timer sel-daily-report.service sel-daily-report.timer; do
  run install -m 0644 "${owner_args[@]}" "$source_dir/systemd/$unit" "$unit_dir/$unit"
done

run install -d -m 0755 "$etc_dir"
if [[ ! -e "$etc_dir/ops.env" ]]; then
  run install -m 0644 "${owner_args[@]}" "$source_dir/ops.env.example" "$etc_dir/ops.env"
fi
if [[ ! -e "$etc_dir/alert.env" ]]; then
  run install -m 0600 "${owner_args[@]}" /dev/null "$etc_dir/alert.env"
fi

# 本机备份目录归应用用户（快照以它运行），只有它和 root 能进。
if [[ -z "$prefix" ]]; then
  run install -d -m 0700 -o "$app_user" -g "$app_user" "$backup_dir"
  run install -d -m 0700 -o root -g root "$state_dir"
else
  run install -d -m 0700 "$backup_dir"
  run install -d -m 0700 "$state_dir"
fi

if [[ -z "$prefix" ]]; then
  run systemctl daemon-reload
  if [[ "$enable" -eq 1 ]]; then
    run systemctl enable --now sel-backup.timer sel-healthcheck.timer sel-daily-report.timer
  fi
fi

echo "完成。下一步：编辑 $etc_dir/ops.env 与 $etc_dir/alert.env，然后按 RUNBOOK.md 手动跑一次备份、巡检和恢复演练。"
