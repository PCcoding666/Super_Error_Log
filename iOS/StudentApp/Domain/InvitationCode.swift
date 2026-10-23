import Foundation

/// 邀请码（2026-10-23）：与服务端 `studentHost/registry.ts` 的 normalizeInviteCode 同一规则——
/// 去空格/短横线、转大写、12 位、32 字母表（无 I/L/O/U）。真正的校验在服务器；这里只决定
/// 登录按钮什么时候可点、输入框怎么分组显示，绝不区分「不存在」与「格式错」。
enum InvitationCode {
  static let length = 12
  static let alphabet: Set<Character> = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

  /// 规范化：合法返回 12 位大写码，否则 nil。
  static func normalize(_ input: String) -> String? {
    let cleaned = input.uppercased().filter { !$0.isWhitespace && $0 != "-" }
    guard cleaned.count == length, cleaned.allSatisfy({ alphabet.contains($0) }) else { return nil }
    return cleaned
  }

  /// 输入框里是否已经是一个形状完整的码（登录按钮可点）。
  static func looksComplete(_ input: String) -> Bool { normalize(input) != nil }

  /// 展示形态 XXXX-XXXX-XXXX（与网页「我的邀请码」一致）；不完整时原样返回。
  static func formatted(_ input: String) -> String {
    guard let code = normalize(input) else { return input }
    return stride(from: 0, to: length, by: 4).map { start in
      let lower = code.index(code.startIndex, offsetBy: start)
      let upper = code.index(lower, offsetBy: 4)
      return String(code[lower..<upper])
    }.joined(separator: "-")
  }
}
