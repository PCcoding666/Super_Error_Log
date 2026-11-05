import Foundation

/// 本地解码 / 状态错误。旧版的复盘、练习包相关的几种错误随旧界面一起删了，只留还在用的两种。
enum StudyError: Error, Equatable, LocalizedError {
  case selectionNotReady, unsupportedState

  var errorDescription: String? {
    switch self {
    case .selectionNotReady: "这道题还没准备好，请稍后再试。"
    case .unsupportedState: "服务器返回的内容看不懂，请稍后再试。"
    }
  }
}
