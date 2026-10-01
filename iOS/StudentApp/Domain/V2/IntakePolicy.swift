import Foundation

// T6c：新照片进门后的下一步动作（纯逻辑）。
// 同意只问一次；同意后自动上传；连接没准备好就等连接；每批最多 10 张。

/// 主页「拍这周的错题」的下一步动作。
enum IntakeAction: Equatable, Sendable {
  /// 首次上传前先问一次同意（带本次待上传名单）。
  case askConsent([String])
  /// 自动上传这几张（至多 10 张一批）。
  case upload([String])
  /// 已同意但连接没准备好：照片留在本机，等连接。
  case waitForConnection
  /// 无事可做（没有待上传照片，或已在上传中）。
  case idle
}

enum IntakePolicy {
  static func next(hasConsented: Bool, connectionReady: Bool, pendingPhotos: [String], isUploading: Bool) -> IntakeAction {
    guard !pendingPhotos.isEmpty else { return .idle }
    guard hasConsented else { return .askConsent(Array(pendingPhotos.prefix(10))) }
    guard connectionReady else { return .waitForConnection }
    guard !isUploading else { return .idle }
    return .upload(Array(pendingPhotos.prefix(10)))
  }
}
