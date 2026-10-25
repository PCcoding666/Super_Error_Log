import Foundation

/// 题干里只认一种 Markdown：GFM 管道表格。移植自 src/text/stemBlocks.ts，判定规则一字不差：
/// 必须有「表头 + 分隔行」才算表格；表体每行格数要和表头一致，带外侧竖线的表头还要求表体行也以 | 开头和结尾；
/// 不符合的行结束表格、原样留作文字。其余文字（题号「10.」、负号、下标、绝对值）一律原样当纯文本，不做完整 Markdown。
enum StemAlign: Equatable, Sendable { case left, center, right }

enum StemBlock: Equatable, Sendable {
  case text(String)
  case table(head: [String], align: [StemAlign?], rows: [[String]])
}

enum StemBlocks {
  static func parse(_ text: String) -> [StemBlock] {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .components(separatedBy: "\n")
    var blocks: [StemBlock] = []
    var pending: [String] = []
    func flush() {
      var joined = pending.joined(separator: "\n")
      while joined.hasPrefix("\n") { joined.removeFirst() }
      while joined.hasSuffix("\n") { joined.removeLast() }
      if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { blocks.append(.text(joined)) }
      pending = []
    }
    var index = 0
    while index < lines.count {
      let line = lines[index]
      let align = line.contains("|") && index + 1 < lines.count ? delimiterAlign(lines[index + 1]) : nil
      let head = align != nil ? splitRow(line) : nil
      guard let align, let head, head.count == align.count else {
        pending.append(line)
        index += 1
        continue
      }
      flush()
      let piped = hasOuterPipes(line)
      var rows: [[String]] = []
      index += 2
      while index < lines.count {
        let row = lines[index]
        if !row.contains("|") || (piped && !hasOuterPipes(row)) { break }
        let cells = splitRow(row)
        if cells.count != head.count { break }
        rows.append(cells)
        index += 1
      }
      blocks.append(.table(head: head, align: align, rows: rows))
    }
    flush()
    return blocks.isEmpty ? [.text(text)] : blocks
  }

  private static func hasOuterPipes(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.count > 1 && trimmed.hasPrefix("|") && trimmed.hasSuffix("|") && !trimmed.hasSuffix("\\|")
  }

  private static func splitRow(_ line: String) -> [String] {
    var body = Array(line.trimmingCharacters(in: .whitespacesAndNewlines))
    if body.first == "|" { body.removeFirst() }
    if body.last == "|", !(body.count >= 2 && body[body.count - 2] == "\\") { body.removeLast() }
    var cells: [String] = []
    var cell = ""
    var index = 0
    while index < body.count {
      let char = body[index]
      if char == "\\", index + 1 < body.count, body[index + 1] == "|" { cell.append("|"); index += 1 }
      else if char == "|" { cells.append(cell.trimmingCharacters(in: .whitespacesAndNewlines)); cell = "" }
      else { cell.append(char) }
      index += 1
    }
    cells.append(cell.trimmingCharacters(in: .whitespacesAndNewlines))
    return cells
  }

  private static func isDelimiterCell(_ cell: String) -> Bool {
    var body = Substring(cell)
    if body.hasPrefix(":") { body = body.dropFirst() }
    if body.hasSuffix(":") { body = body.dropLast() }
    return !body.isEmpty && body.allSatisfy { $0 == "-" }
  }

  private static func delimiterAlign(_ line: String) -> [StemAlign?]? {
    guard line.contains("|"), line.contains("-") else { return nil }
    let cells = splitRow(line)
    guard cells.allSatisfy(isDelimiterCell) else { return nil }
    return cells.map { cell -> StemAlign? in
      let left = cell.hasPrefix(":"), right = cell.hasSuffix(":")
      return left && right ? .center : right ? .right : left ? .left : nil
    }
  }
}
