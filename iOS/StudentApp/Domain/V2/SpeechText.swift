import Foundation

// T6c-R1：语音输入的纯逻辑。识别回填是「相对基底的整句替换」，不是追加；
// 权限状态到界面呈现的判定与界面无关，便于单测。

enum SpeechText {
  /// 基底 + 本次整句 → 输入框内容。基底为空直接用整句；整句为空不改基底；
  /// 基底非空时直接接上（中文之间不加空格）。中间结果与最终结果都走这里（替换语义）。
  static func merge(base: String, transcript: String) -> String {
    if base.isEmpty { return transcript }
    if transcript.isEmpty { return base }
    return base + transcript
  }
}

enum SpeechGate {
  /// 授权状态（还没问过 / 已允许 / 被拒绝或受限）。
  enum Auth: Equatable, Sendable {
    case notAsked, allowed, denied
  }

  /// 界面呈现：按住即可说 / 显示按钮但第一次按下先请求权限（本次不录音）/ 只留键盘。
  enum Presentation: Equatable, Sendable {
    case holdToTalk, askOnPress, keyboardOnly
  }

  /// 识别器存在且两项授权都「还没问过」或「已允许」时显示「按住说话」按钮；
  /// 任一项被拒绝或设备不支持时隐藏按钮。两项都已允许才按住即录，否则按下先请求。
  static func presentation(recognizerExists: Bool, speech: Auth, mic: Auth) -> Presentation {
    guard recognizerExists else { return .keyboardOnly }
    if speech == .denied || mic == .denied { return .keyboardOnly }
    if speech == .allowed, mic == .allowed { return .holdToTalk }
    return .askOnPress
  }
}
