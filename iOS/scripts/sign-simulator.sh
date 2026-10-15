#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
cd "$project_dir"
# Xcode embeds simulated Keychain entitlements in the simulator binary. Direct
# codesign entitlements are incorrect here: macOS rejects restricted iOS keys.
# No developer identity, physical-device profile or global setting is changed.
xcodebuild -project SuperErrorLog.xcodeproj -target SuperErrorLog -configuration Debug \
  -sdk iphonesimulator SYMROOT=build/Manual build CODE_SIGNING_ALLOWED=YES \
  CODE_SIGN_IDENTITY=- CODE_SIGN_ENTITLEMENTS=scripts/Simulator.entitlements -quiet
