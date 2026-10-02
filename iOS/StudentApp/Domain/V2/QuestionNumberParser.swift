import Foundation

// S2：题号解析（纯逻辑）。从学生说的或输入的一句话里取题号：
// 阿拉伯数字（含全角）、中文数字（十/十五/二十一/两…）、范围（5到8 / 5-8 / 5~8 / 5至8）。
// 去重升序；空串、没有数字、0、大于 200 忽略；跨度超过 30 或倒序的范围整段忽略。
enum QuestionNumberParser {
  /// 范围连接符：到 / 至 / 半角连字符 / 波浪线（半角、全角）/ 全角连字符与破折号。
  private static let connectors: Set<Character> = ["到", "至", "-", "~", "～", "－", "—"]
  private static let chineseDigits: [Character: Int] = [
    "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
  ]

  private enum Token: Equatable {
    case number(Int)
    case connector
  }

  /// 从一句话里取题号，去重、升序。
  static func parse(_ text: String) -> [Int] {
    let tokens = tokenize(normalizeDigits(text))
    var found: Set<Int> = []
    var index = 0
    while index < tokens.count {
      // 数字 + 连接符 + 数字 → 范围：合法展开，非法（倒序/超跨度/越界）整段忽略。
      if case .number(let low) = tokens[index],
        index + 2 < tokens.count + 1, tokens.indices.contains(index + 2),
        tokens[index + 1] == .connector, case .number(let high) = tokens[index + 2]
      {
        if low >= 1, high <= 200, low < high, high - low <= 30 {
          found.formUnion(low...high)
        }
        index += 3
        continue
      }
      if case .number(let value) = tokens[index], (1...200).contains(value) {
        found.insert(value)
      }
      index += 1
    }
    return found.sorted()
  }

  /// 候选题号的开头整数：3. / （3）/ 3、/ 第3题 / 三 / 17(1) → 3/3/3/3/3/17；没有数字 → nil。
  static func leadingNumber(of candidateNumber: String) -> Int? {
    for token in tokenize(normalizeDigits(candidateNumber)) {
      if case .number(let value) = token { return value }
    }
    return nil
  }

  /// 把解析出的题号对到候选题：同一开头整数对应多个候选（小问）时全部选中；
  /// 没有对应候选的题号放进 missing。
  static func match(numbers: [Int], candidates: [(id: String, number: String)]) -> (ids: [String], missing: [Int]) {
    var ids: [String] = []
    var missing: [Int] = []
    for number in numbers {
      let matched = candidates.filter { leadingNumber(of: $0.number) == number }
      if matched.isEmpty { missing.append(number) } else { ids.append(contentsOf: matched.map(\.id)) }
    }
    return (ids, missing)
  }

  // MARK: - 内部

  /// 全角数字转半角。
  private static func normalizeDigits(_ text: String) -> String {
    String(text.map { char in
      guard let scalar = char.unicodeScalars.first, char.unicodeScalars.count == 1,
        (0xFF10...0xFF19).contains(scalar.value)
      else { return char }
      return Character(Unicode.Scalar(scalar.value - 0xFF10 + 0x30)!)
    })
  }

  private static func tokenize(_ text: String) -> [Token] {
    var tokens: [Token] = []
    var index = text.startIndex
    while index < text.endIndex {
      let char = text[index]
      if char.isNumber, char.isASCII {
        var end = index
        while end < text.endIndex, text[end].isNumber, text[end].isASCII { end = text.index(after: end) }
        if let value = Int(text[index..<end]) { tokens.append(.number(value)) }
        index = end
        continue
      }
      if chineseDigits[char] != nil || char == "十" {
        var end = index
        while end < text.endIndex, chineseDigits[text[end]] != nil || text[end] == "十" {
          end = text.index(after: end)
        }
        if let value = chineseNumber(text[index..<end]) { tokens.append(.number(value)) }
        index = end
        continue
      }
      if connectors.contains(char) { tokens.append(.connector) }
      index = text.index(after: index)
    }
    return tokens
  }

  /// 中文数字：十 / 十五 / 二十 / 二十一 / 单个数字（含两）。不合法形状（如「十三月」中的「十三」仍取 13，
  /// 「二十一」取 21）之外的写法返回 nil。
  private static func chineseNumber(_ text: Substring) -> Int? {
    if let tenIndex = text.firstIndex(of: "十") {
      let left = text[..<tenIndex]
      let right = text[text.index(after: tenIndex)...]
      guard left.count <= 1, right.count <= 1 else { return nil }
      let tens = left.isEmpty ? 1 : chineseDigits[left.first!]
      let ones = right.isEmpty ? 0 : chineseDigits[right.first!]
      guard let tens, let ones else { return nil }
      return tens * 10 + ones
    }
    guard text.count == 1, let value = chineseDigits[text.first!] else { return nil }
    return value
  }
}
