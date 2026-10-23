#!/bin/zsh
# 把学生端装进自己的 iPhone（免费 Apple ID，7 天签名；到期后再跑一遍即可，数据不丢）。
#
# 前提（只做一次）：
#   1. Mac 上装好 Xcode 16+，打开过一次并同意许可；Xcode ▸ Settings ▸ Accounts 里登录你的 Apple ID。
#   2. iPhone 用数据线连 Mac，解锁，信任这台电脑；iPhone 设置 ▸ 隐私与安全性 ▸ 开发者模式 打开。
#   3. 第一次安装后，iPhone 设置 ▸ 通用 ▸ VPN 与设备管理 里信任你的 Apple ID 证书。
#
# 用法（仓库根目录）：
#   SEL_IOS_TEAM_ID=XXXXXXXXXX zsh iOS/scripts/install-iphone.sh            # 自动找第一台已连接的 iPhone
#   SEL_IOS_TEAM_ID=XXXXXXXXXX zsh iOS/scripts/install-iphone.sh <设备ID>   # 指定设备（xcrun devicectl list devices）
#
# Team ID 在 https://developer.apple.com/account ▸ Membership details，或 Xcode 签名页「Team」后面的括号里。
# 免费账号每个 Bundle ID 7 天过期、同一设备最多 3 个免费签名的 App、每周最多 10 个 Bundle ID。
set -euo pipefail

cd "$(dirname "$0")/.."
team="${SEL_IOS_TEAM_ID:-}"
if [[ -z "$team" ]]; then
  echo "请设置 SEL_IOS_TEAM_ID（你的 Apple 开发者 Team ID，10 位）。" >&2
  exit 2
fi
device="${1:-}"
if [[ -z "$device" ]]; then
  device="$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null \
    | python3 -c 'import json,sys; d=[x for x in json.load(sys.stdin)["result"]["devices"] if x.get("hardwareProperties",{}).get("platform")=="iOS" and x.get("connectionProperties",{}).get("pairingState")=="paired"]; print(d[0]["identifier"] if d else "")')"
fi
if [[ -z "$device" ]]; then
  echo "没找到已连接并配对的 iPhone：先用数据线连上、解锁并信任这台电脑，或手动传设备 ID。" >&2
  exit 2
fi

symroot="build/Device"
echo "▶ 编译并签名（Team $team，自动管理描述文件）…"
xcodebuild -project SuperErrorLog.xcodeproj -scheme SuperErrorLog -configuration Debug \
  -destination "generic/platform=iOS" -allowProvisioningUpdates \
  SYMROOT="$symroot" DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic \
  -quiet build

app="$symroot/Debug-iphoneos/SuperErrorLog.app"
[[ -d "$app" ]] || { echo "没有生成 $app" >&2; exit 1; }
echo "▶ 安装到设备 $device …"
xcrun devicectl device install app --device "$device" "$app"
echo "✔ 已安装。第一次打开若提示「不受信任的开发者」：iPhone 设置 ▸ 通用 ▸ VPN 与设备管理 ▸ 信任。"
echo "  免费签名 7 天后会失效（打开闪退）；再跑一遍这个脚本即可，本机照片与服务器记录都还在。"
