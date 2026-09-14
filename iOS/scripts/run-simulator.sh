#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
device_id="${1:?Pass a simulator UDID from: xcrun simctl list devices available}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
cd "$project_dir"

zsh scripts/prepare-examples.sh
# Direct target build avoids the missing default iOS 26.5 runtime on this Mac.
# It does not change xcode-select or simulator runtime matching rules.
xcodebuild -project SuperErrorLog.xcodeproj -target SuperErrorLog -configuration Debug \
  -sdk iphonesimulator SYMROOT=build/Manual build CODE_SIGNING_ALLOWED=NO -quiet
zsh scripts/sign-simulator.sh
xcrun simctl boot "$device_id" 2>/dev/null || xcrun simctl bootstatus "$device_id" -b
xcrun simctl bootstatus "$device_id" -b
xcrun simctl install "$device_id" build/Manual/Debug-iphonesimulator/SuperErrorLog.app
xcrun simctl launch "$device_id" com.supererrorlog.student.prototype
open -a "$DEVELOPER_DIR/Applications/Simulator.app"
