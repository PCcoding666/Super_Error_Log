import Foundation

// T6c：「不是错题」的 8 秒撤销计时状态（纯逻辑；时间在视图层注入，便于测试）。
// 同一时间只有一条撤销条：新的移出顶替旧的。

struct DiscardUndo: Equatable, Sendable {
  /// 撤销窗口（秒）。
  static let window: TimeInterval = 8

  private(set) var pendingItemID: String?
  private(set) var expiresAt: Date?

  var isVisible: Bool { pendingItemID != nil }

  /// 一次移出成功后调用：展示撤销条，8 秒后过期。
  mutating func begin(itemID: String, at now: Date = Date()) {
    pendingItemID = itemID
    expiresAt = now.addingTimeInterval(Self.window)
  }

  /// 点撤销：返回待恢复的题目 ID 并清空（无论是否过期都清空）。
  @discardableResult
  mutating func undo() -> String? {
    let itemID = pendingItemID
    clear()
    return itemID
  }

  /// 计时推进：超过窗口即消失。
  mutating func tick(now: Date = Date()) {
    if let expiresAt, now >= expiresAt { clear() }
  }

  mutating func clear() {
    pendingItemID = nil
    expiresAt = nil
  }
}
