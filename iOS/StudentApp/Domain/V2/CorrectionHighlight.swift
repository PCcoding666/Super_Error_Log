import Foundation

// T6c：修改面板「改前 → 改后」的高亮分段（纯逻辑）。
// 用 find/replace 把被替换的片段在改前全文中定位出来；找不到时退化为整体对照。

/// 一段对照文本：普通（未动）/ 被替换（改前片段）/ 替换后（改后片段）。
enum CorrectionSegment: Equatable, Sendable {
  case plain(String)
  case removed(String)
  case added(String)
}

enum CorrectionHighlight {
  /// 在改前全文中定位 find，产出 普通/被替换/替换后 分段。
  /// find 缺失、为空、或在全文中找不到时退化为整体对照（整段改前 + 整段改后）。
  static func segments(before: String, after: String, find: String?, replace: String?) -> [CorrectionSegment] {
    guard let find, !find.isEmpty, let range = before.range(of: find) else {
      return [.removed(before), .added(after)]
    }
    var result: [CorrectionSegment] = []
    let prefix = String(before[..<range.lowerBound])
    if !prefix.isEmpty { result.append(.plain(prefix)) }
    result.append(.removed(find))
    if let replace, !replace.isEmpty { result.append(.added(replace)) }
    let suffix = String(before[range.upperBound...])
    if !suffix.isEmpty { result.append(.plain(suffix)) }
    return result
  }
}
