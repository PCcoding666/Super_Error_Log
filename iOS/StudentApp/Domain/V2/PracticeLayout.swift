import Foundation
import CoreGraphics
import CoreText

// 练习纸版面计算（task-6p-brief §1）。纯计算不画：输出每页的元素列表。
// 坐标系：页面左上角为原点，y 向下，单位 pt。绘制方（PracticePDF）负责换算到 PDF 坐标系。

// MARK: - 文字测量器

/// 一次测量的结果：总高、行高、分行后的每行文本。
struct PracticeMeasuredText: Equatable {
  let height: CGFloat
  let lineHeight: CGFloat
  let lines: [String]
}

/// 给定文本、字号、是否加粗、宽度 → 高度与分行；另给单行宽度测量。
protocol PracticeTextMeasurer {
  func measure(_ text: String, fontSize: CGFloat, bold: Bool, width: CGFloat) -> PracticeMeasuredText
  func width(of text: String, fontSize: CGFloat, bold: Bool) -> CGFloat
}

/// CoreText 实现（真实排版用，PingFang SC）。
struct CoreTextPracticeMeasurer: PracticeTextMeasurer {
  init() {}

  func width(of text: String, fontSize: CGFloat, bold: Bool) -> CGFloat {
    guard !text.isEmpty else { return 0 }
    let line = CTLineCreateWithAttributedString(CoreTextPracticeMeasurer.attributed(text, fontSize: fontSize, bold: bold))
    var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
    return CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
  }

  func measure(_ text: String, fontSize: CGFloat, bold: Bool, width: CGFloat) -> PracticeMeasuredText {
    let fallbackLineHeight = fontSize * 1.4
    guard !text.isEmpty, width > 0 else {
      return PracticeMeasuredText(height: 0, lineHeight: fallbackLineHeight, lines: [])
    }
    let setter = CTFramesetterCreateWithAttributedString(CoreTextPracticeMeasurer.attributed(text, fontSize: fontSize, bold: bold))
    let path = CGPath(rect: CGRect(x: 0, y: 0, width: width, height: 100_000), transform: nil)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil)
    let ctLines = CTFrameGetLines(frame) as! [CTLine]
    let nsText = text as NSString
    var lines: [String] = []
    var lineHeight: CGFloat = 0
    for line in ctLines {
      let range = CTLineGetStringRange(line)
      lines.append(nsText.substring(with: NSRange(location: range.location, length: range.length)))
      var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
      CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
      lineHeight = max(lineHeight, ascent + descent + leading)
    }
    lineHeight = max(lineHeight, fallbackLineHeight)
    return PracticeMeasuredText(height: CGFloat(lines.count) * lineHeight, lineHeight: lineHeight, lines: lines)
  }

  static func attributed(_ text: String, fontSize: CGFloat, bold: Bool) -> NSAttributedString {
    let font = CTFontCreateWithName((bold ? "PingFangSC-Semibold" : "PingFangSC-Regular") as CFString, fontSize, nil)
    return NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
  }
}

// MARK: - 页面度量

/// A4 纵向 595×842 pt，页边距 40 pt，黑白打印友好。
struct PracticePageMetrics: Equatable {
  var pageWidth: CGFloat = 595
  var pageHeight: CGFloat = 842
  var margin: CGFloat = 40
  /// 页脚保留区高度（页脚画在版心下方）。
  var footerHeight: CGFloat = 28

  var partGap: CGFloat = 6
  var blockSpacing: CGFloat = 18
  var answerMinHeight: CGFloat = 150
  var writingLineSpacing: CGFloat = 28
  var maxImageHeightRatio: CGFloat = 0.45
  var imageDPI: CGFloat = 150
  var missingImageHeight: CGFloat = 48

  var titleFontSize: CGFloat = 20
  var bodyFontSize: CGFloat = 12
  var checkboxFontSize: CGFloat = 11
  var smallFontSize: CGFloat = 9
  var footerFontSize: CGFloat = 9
  var answerTitleFontSize: CGFloat = 18

  var contentWidth: CGFloat { pageWidth - margin * 2 }
  var contentTop: CGFloat { margin }
  var contentBottom: CGFloat { pageHeight - margin - footerHeight }
  var contentHeight: CGFloat { contentBottom - contentTop }
  var maxImageHeight: CGFloat { contentHeight * maxImageHeightRatio }
}

// MARK: - 版面结果

enum PracticeElementKind: Equatable {
  case text, image, imageMissing, writingLine, separator, keyStepLine, checkbox
}

/// 版面元素：种类 + 矩形 + 文本/图片名/字号/是否加粗。gray 为深灰（次要文字与页脚）。
struct PracticeElement: Equatable {
  let kind: PracticeElementKind
  let rect: CGRect
  let text: String?
  let imageName: String?
  let fontSize: CGFloat
  let bold: Bool
  let gray: Bool

  init(kind: PracticeElementKind, rect: CGRect, text: String? = nil, imageName: String? = nil,
       fontSize: CGFloat = 12, bold: Bool = false, gray: Bool = false) {
    self.kind = kind
    self.rect = rect
    self.text = text
    self.imageName = imageName
    self.fontSize = fontSize
    self.bold = bold
    self.gray = gray
  }
}

enum PracticePageRole: Equatable {
  case cover, question, answer
}

struct PracticePage: Equatable {
  let role: PracticePageRole
  var elements: [PracticeElement]
}

struct PracticeLayoutResult: Equatable {
  let pages: [PracticePage]
}

// MARK: - 排版

enum PracticeLayout {

  static let cropNote = "AI 对这题没把握，文字和截图不一致时以截图为准"
  static let answerSheetTitle = "做完再看"
  static let answerSheetRule = "先独立做；卡住了按一级、二级提示的顺序看"
  static let footerRight = "纸错题延迟重做"

  private enum StemPart {
    case text(String, fontSize: CGFloat, gray: Bool, measured: PracticeMeasuredText)
    /// size 为 nil 表示图片缺失（版面按占位行处理）。
    case image(String, size: CGSize?)
  }

  private struct BlockPlan {
    let item: V2PrintItem
    let shortIdText: String
    let headerMeta: String
    let headerMetaX: CGFloat
    let headerH: CGFloat
    let stemParts: [StemPart]
    let stemH: CGFloat
    let keyStep: String
    let keyStepH: CGFloat
    let keyStepTextWidth: CGFloat
    let checkboxes: [String]
    let checkboxWidths: [CGFloat]
    let dateText: String
    let dateTextWidth: CGFloat
    let dateOnNextRow: Bool
    let checkH: CGFloat

    var total: CGFloat {
      headerH + stemH + keyStepH + checkH + 4 * 6 + 150
    }
    var headStemH: CGFloat { headerH + 6 + stemH }
    var tailH: CGFloat { 6 + keyStepH + 6 + checkH }
  }

  private struct Cursor {
    let metrics: PracticePageMetrics
    var pages: [PracticePage] = []
    var y: CGFloat

    init(metrics: PracticePageMetrics) {
      self.metrics = metrics
      self.y = metrics.contentTop
    }

    var remaining: CGFloat { metrics.contentBottom - y }
    var atTop: Bool { y <= metrics.contentTop + 0.01 }

    mutating func newPage(_ role: PracticePageRole) {
      pages.append(PracticePage(role: role, elements: []))
      y = metrics.contentTop
    }

    mutating func add(_ element: PracticeElement) {
      guard !pages.isEmpty else { return }
      pages[pages.count - 1].elements.append(element)
    }

    mutating func advance(_ height: CGFloat) { y += height }
  }

  static func compute(snapshot: V2PrintSnapshot,
                      imageSizes: [String: CGSize],
                      measurer: PracticeTextMeasurer,
                      metrics: PracticePageMetrics = PracticePageMetrics()) -> PracticeLayoutResult {
    var cursor = Cursor(metrics: metrics)
    layoutCover(snapshot: snapshot, measurer: measurer, metrics: metrics, cursor: &cursor)

    let items = snapshot.items.sorted { $0.position < $1.position }
    if !items.isEmpty {
      cursor.newPage(.question)
      for (index, item) in items.enumerated() {
        let plan = planBlock(item: item, imageSizes: imageSizes, measurer: measurer, metrics: metrics)
        if index == 0 {
          if plan.total <= cursor.remaining {
            placeWholeBlock(plan, measurer: measurer, metrics: metrics, cursor: &cursor)
          } else {
            placeSplitBlock(plan, measurer: measurer, metrics: metrics, cursor: &cursor)
          }
        } else if plan.total + metrics.blockSpacing <= cursor.remaining {
          cursor.advance(metrics.blockSpacing / 2)
          cursor.add(PracticeElement(kind: .separator, rect: CGRect(x: metrics.margin, y: cursor.y, width: metrics.contentWidth, height: 0)))
          cursor.advance(metrics.blockSpacing / 2)
          placeWholeBlock(plan, measurer: measurer, metrics: metrics, cursor: &cursor)
        } else if plan.total <= metrics.contentHeight {
          cursor.newPage(.question)
          placeWholeBlock(plan, measurer: measurer, metrics: metrics, cursor: &cursor)
        } else {
          placeSplitBlock(plan, measurer: measurer, metrics: metrics, cursor: &cursor)
        }
      }
    }

    // 答案必须另起一页。
    cursor.newPage(.answer)
    layoutAnswerSheet(snapshot: snapshot, measurer: measurer, metrics: metrics, cursor: &cursor)

    addFooters(week: snapshot.week, measurer: measurer, metrics: metrics, cursor: &cursor)
    return PracticeLayoutResult(pages: cursor.pages)
  }

  // MARK: 封面

  private static func layoutCover(snapshot: V2PrintSnapshot, measurer: PracticeTextMeasurer, metrics: PracticePageMetrics, cursor: inout Cursor) {
    cursor.newPage(.cover)
    addTextBlock(snapshot.cover.title, fontSize: metrics.titleFontSize, bold: true, measurer: measurer, metrics: metrics, cursor: &cursor)
    cursor.advance(10)
    addTextBlock(snapshot.week, fontSize: metrics.bodyFontSize, bold: false, measurer: measurer, metrics: metrics, cursor: &cursor)
    cursor.advance(4)
    addTextBlock("做题时段：\(snapshot.cover.practiceSlot)", fontSize: metrics.bodyFontSize, bold: false, measurer: measurer, metrics: metrics, cursor: &cursor)
    cursor.advance(14)
    addTextBlock("规则：", fontSize: metrics.bodyFontSize, bold: true, measurer: measurer, metrics: metrics, cursor: &cursor)
    cursor.advance(2)
    for (index, rule) in snapshot.cover.rules.enumerated() {
      addTextBlock("\(index + 1). \(rule)", fontSize: metrics.checkboxFontSize, bold: false, measurer: measurer, metrics: metrics, cursor: &cursor)
      cursor.advance(2)
    }
    cursor.advance(10)
    addTextBlock("题目清单：", fontSize: metrics.bodyFontSize, bold: true, measurer: measurer, metrics: metrics, cursor: &cursor)
    cursor.advance(2)
    for item in snapshot.cover.itemList {
      addTextBlock("\(item.shortId ?? "—")　\(item.sourceLabel)", fontSize: metrics.checkboxFontSize, bold: false, measurer: measurer, metrics: metrics, cursor: &cursor)
      cursor.advance(2)
    }
    cursor.advance(10)
    addTextBlock("做题日期：________", fontSize: metrics.bodyFontSize, bold: false, measurer: measurer, metrics: metrics, cursor: &cursor)
  }

  // MARK: 区块测量

  private static func planBlock(item: V2PrintItem, imageSizes: [String: CGSize], measurer: PracticeTextMeasurer, metrics: PracticePageMetrics) -> BlockPlan {
    let shortIdText = item.shortId ?? "第 \(item.position + 1) 题"
    let shortIdWidth = measurer.width(of: shortIdText, fontSize: metrics.bodyFontSize, bold: true)
    let metaX = metrics.margin + shortIdWidth + 8
    let metaParts = [item.subject].compactMap { $0 }.filter { !$0.isEmpty } + item.knowledgeTags
    let headerMeta = metaParts.joined(separator: "、")
    let shortIdH = measurer.measure(shortIdText, fontSize: metrics.bodyFontSize, bold: true, width: metrics.contentWidth).height
    let metaH = headerMeta.isEmpty
      ? 0
      : measurer.measure(headerMeta, fontSize: metrics.bodyFontSize, bold: false, width: max(metrics.contentWidth - shortIdWidth - 8, 1)).height
    let headerH = max(shortIdH, metaH)

    var stemParts: [StemPart] = []
    switch item.mode {
    case .text, .unknown:
      if let stem = item.stemText, !stem.isEmpty {
        stemParts.append(.text(stem, fontSize: metrics.bodyFontSize, gray: false,
                               measured: measurer.measure(stem, fontSize: metrics.bodyFontSize, bold: false, width: metrics.contentWidth)))
      }
      for name in item.diagramMedia {
        stemParts.append(.image(name, size: scaledImageSize(name, imageSizes: imageSizes, metrics: metrics)))
      }
    case .crop:
      if let stem = item.stemText, !stem.isEmpty {
        stemParts.append(.text(stem, fontSize: metrics.bodyFontSize, gray: false,
                               measured: measurer.measure(stem, fontSize: metrics.bodyFontSize, bold: false, width: metrics.contentWidth)))
      }
      stemParts.append(.text(cropNote, fontSize: metrics.smallFontSize, gray: true,
                             measured: measurer.measure(cropNote, fontSize: metrics.smallFontSize, bold: false, width: metrics.contentWidth)))
      if let crop = item.cropMedia {
        stemParts.append(.image(crop, size: scaledImageSize(crop, imageSizes: imageSizes, metrics: metrics)))
      }
    }
    var stemH: CGFloat = 0
    for (index, part) in stemParts.enumerated() {
      if index > 0 { stemH += metrics.partGap }
      switch part {
      case .text(_, _, _, let measured): stemH += measured.height
      case .image(_, let size): stemH += size?.height ?? metrics.missingImageHeight
      }
    }

    let keyStep = item.keyStepPrompt
    let keyStepMeasured = measurer.measure(keyStep, fontSize: metrics.bodyFontSize, bold: false, width: metrics.contentWidth)
    let keyStepTextWidth = measurer.width(of: keyStep, fontSize: metrics.bodyFontSize, bold: false)

    let boxWidth: CGFloat = 14
    let checkboxWidths = item.checkboxes.map { boxWidth + 4 + measurer.width(of: $0, fontSize: metrics.checkboxFontSize, bold: false) }
    let dateText = "做题日期：________"
    let dateTextWidth = measurer.width(of: dateText, fontSize: metrics.checkboxFontSize, bold: false)
    let rowH = max(boxWidth, measurer.measure("□", fontSize: metrics.checkboxFontSize, bold: false, width: metrics.contentWidth).lineHeight)
    let rowWidth = checkboxWidths.reduce(0, +) + CGFloat(max(item.checkboxes.count - 1, 0)) * 16
    let dateOnNextRow = rowWidth + 24 + dateTextWidth > metrics.contentWidth
    let checkH = dateOnNextRow ? rowH * 2 + 4 : rowH

    return BlockPlan(item: item, shortIdText: shortIdText, headerMeta: headerMeta, headerMetaX: metaX,
                     headerH: headerH, stemParts: stemParts, stemH: stemH,
                     keyStep: keyStep, keyStepH: keyStepMeasured.height, keyStepTextWidth: keyStepTextWidth,
                     checkboxes: item.checkboxes, checkboxWidths: checkboxWidths,
                     dateText: dateText, dateTextWidth: dateTextWidth, dateOnNextRow: dateOnNextRow, checkH: checkH)
  }

  /// 图片等比缩放：宽 ≤ 版心宽，高 ≤ 0.45 × 版心高，不放大超过 150dpi 对应尺寸。
  private static func scaledImageSize(_ name: String, imageSizes: [String: CGSize], metrics: PracticePageMetrics) -> CGSize? {
    guard let pixel = imageSizes[name], pixel.width > 0, pixel.height > 0 else { return nil }
    let baseW = pixel.width * 72 / metrics.imageDPI
    let baseH = pixel.height * 72 / metrics.imageDPI
    let scale = min(1, metrics.contentWidth / baseW, metrics.maxImageHeight / baseH)
    return CGSize(width: baseW * scale, height: baseH * scale)
  }

  // MARK: 区块绘制（排版坐标）

  private static func placeWholeBlock(_ plan: BlockPlan, measurer: PracticeTextMeasurer, metrics: PracticePageMetrics, cursor: inout Cursor) {
    placeHeader(plan, metrics: metrics, cursor: &cursor)
    cursor.advance(metrics.partGap)
    placeStemParts(plan.stemParts, flow: false, metrics: metrics, cursor: &cursor)
    cursor.advance(metrics.partGap)
    placeAnswerSpace(height: metrics.answerMinHeight, metrics: metrics, cursor: &cursor)
    cursor.advance(metrics.partGap)
    placeKeyStep(plan, metrics: metrics, cursor: &cursor)
    cursor.advance(metrics.partGap)
    placeCheckboxes(plan, metrics: metrics, cursor: &cursor)
  }

  /// 拆点只允许在"题面之后、留白之前"或留白内部：题头+题面放当前页（放不下先换页），
  /// 本页剩余 ≥ 150pt 时留白填满本页、关键一步与勾选框去下一页；否则留白整体去下一页。
  private static func placeSplitBlock(_ plan: BlockPlan, measurer: PracticeTextMeasurer, metrics: PracticePageMetrics, cursor: inout Cursor) {
    if plan.headStemH > cursor.remaining, !cursor.atTop {
      cursor.newPage(.question)
    }
    placeHeader(plan, metrics: metrics, cursor: &cursor)
    cursor.advance(metrics.partGap)
    placeStemParts(plan.stemParts, flow: true, metrics: metrics, cursor: &cursor)
    if cursor.remaining >= metrics.answerMinHeight {
      placeAnswerSpace(height: cursor.remaining, metrics: metrics, cursor: &cursor)
      cursor.newPage(.question)
      placeKeyStep(plan, metrics: metrics, cursor: &cursor)
      cursor.advance(metrics.partGap)
      placeCheckboxes(plan, metrics: metrics, cursor: &cursor)
    } else {
      cursor.newPage(.question)
      placeAnswerSpace(height: metrics.answerMinHeight, metrics: metrics, cursor: &cursor)
      cursor.advance(metrics.partGap)
      placeKeyStep(plan, metrics: metrics, cursor: &cursor)
      cursor.advance(metrics.partGap)
      placeCheckboxes(plan, metrics: metrics, cursor: &cursor)
    }
  }

  private static func placeHeader(_ plan: BlockPlan, metrics: PracticePageMetrics, cursor: inout Cursor) {
    cursor.add(PracticeElement(kind: .text, rect: CGRect(x: metrics.margin, y: cursor.y, width: metrics.contentWidth, height: plan.headerH),
                               text: plan.shortIdText, fontSize: metrics.bodyFontSize, bold: true))
    if !plan.headerMeta.isEmpty {
      cursor.add(PracticeElement(kind: .text, rect: CGRect(x: plan.headerMetaX, y: cursor.y, width: metrics.contentWidth - (plan.headerMetaX - metrics.margin), height: plan.headerH),
                                 text: plan.headerMeta, fontSize: metrics.bodyFontSize))
    }
    cursor.advance(plan.headerH)
  }

  private static func placeStemParts(_ parts: [StemPart], flow: Bool, metrics: PracticePageMetrics, cursor: inout Cursor) {
    for (index, part) in parts.enumerated() {
      if index > 0 { cursor.advance(metrics.partGap) }
      switch part {
      case .text(_, let fontSize, let gray, let measured):
        for line in measured.lines {
          if flow, measured.lineHeight > cursor.remaining, !cursor.atTop {
            cursor.newPage(.question)
          }
          cursor.add(PracticeElement(kind: .text, rect: CGRect(x: metrics.margin, y: cursor.y, width: metrics.contentWidth, height: measured.lineHeight),
                                     text: line, fontSize: fontSize, gray: gray))
          cursor.advance(measured.lineHeight)
        }
      case .image(let name, let size):
        let height = size?.height ?? metrics.missingImageHeight
        if flow, height > cursor.remaining, !cursor.atTop {
          cursor.newPage(.question)
        }
        if let size {
          cursor.add(PracticeElement(kind: .image, rect: CGRect(x: metrics.margin, y: cursor.y, width: size.width, height: size.height), imageName: name))
        } else {
          cursor.add(PracticeElement(kind: .imageMissing, rect: CGRect(x: metrics.margin, y: cursor.y, width: metrics.contentWidth, height: metrics.missingImageHeight),
                                     text: "图片缺失：\(name)", imageName: name, fontSize: metrics.smallFontSize, gray: true))
        }
        cursor.advance(height)
      }
    }
  }

  private static func placeAnswerSpace(height: CGFloat, metrics: PracticePageMetrics, cursor: inout Cursor) {
    let top = cursor.y
    var lineY = top + metrics.writingLineSpacing
    while lineY <= top + height + 0.01 {
      cursor.add(PracticeElement(kind: .writingLine, rect: CGRect(x: metrics.margin, y: lineY, width: metrics.contentWidth, height: 0)))
      lineY += metrics.writingLineSpacing
    }
    cursor.advance(height)
  }

  private static func placeKeyStep(_ plan: BlockPlan, metrics: PracticePageMetrics, cursor: inout Cursor) {
    cursor.add(PracticeElement(kind: .text, rect: CGRect(x: metrics.margin, y: cursor.y, width: metrics.contentWidth, height: plan.keyStepH),
                               text: plan.keyStep, fontSize: metrics.bodyFontSize))
    let lineX = metrics.margin + plan.keyStepTextWidth + 6
    let right = metrics.margin + metrics.contentWidth
    if lineX < right {
      cursor.add(PracticeElement(kind: .keyStepLine, rect: CGRect(x: lineX, y: cursor.y + plan.keyStepH - 5, width: right - lineX, height: 0)))
    }
    cursor.advance(plan.keyStepH)
  }

  private static func placeCheckboxes(_ plan: BlockPlan, metrics: PracticePageMetrics, cursor: inout Cursor) {
    let rowH = plan.dateOnNextRow ? (plan.checkH - 4) / 2 : plan.checkH
    var x = metrics.margin
    for (index, label) in plan.checkboxes.enumerated() {
      let width = plan.checkboxWidths[index]
      cursor.add(PracticeElement(kind: .checkbox, rect: CGRect(x: x, y: cursor.y, width: width, height: rowH),
                                 text: label, fontSize: metrics.checkboxFontSize))
      x += width + 16
    }
    if plan.dateOnNextRow {
      cursor.add(PracticeElement(kind: .text, rect: CGRect(x: metrics.margin, y: cursor.y + rowH + 4, width: plan.dateTextWidth, height: rowH),
                                 text: plan.dateText, fontSize: metrics.checkboxFontSize))
    } else {
      cursor.add(PracticeElement(kind: .text, rect: CGRect(x: x + 8, y: cursor.y, width: plan.dateTextWidth, height: rowH),
                                 text: plan.dateText, fontSize: metrics.checkboxFontSize))
    }
    cursor.advance(plan.checkH)
  }

  // MARK: 答案页

  private static func layoutAnswerSheet(snapshot: V2PrintSnapshot, measurer: PracticeTextMeasurer, metrics: PracticePageMetrics, cursor: inout Cursor) {
    addTextBlock(answerSheetTitle, fontSize: metrics.answerTitleFontSize, bold: true, measurer: measurer, metrics: metrics, cursor: &cursor)
    cursor.advance(8)
    addTextBlock(answerSheetRule, fontSize: metrics.checkboxFontSize, bold: false, measurer: measurer, metrics: metrics, cursor: &cursor)
    cursor.advance(12)
    for (index, entry) in snapshot.answerSheet.enumerated() {
      let lines: [(String, CGFloat, Bool)] = [
        (entry.shortId ?? "—", metrics.bodyFontSize, true),
        (hintLine(prefix: "一级提示：", text: entry.hint1), metrics.checkboxFontSize, false),
        (hintLine(prefix: "二级提示：", text: entry.hint2), metrics.checkboxFontSize, false),
        (answerLine(entry.answer), metrics.checkboxFontSize, false),
        (entry.fallbackNote, metrics.checkboxFontSize, false),
      ]
      let measured = lines.map { (text: $0.0, fontSize: $0.1, bold: $0.2, m: measurer.measure($0.0, fontSize: $0.1, bold: $0.2, width: metrics.contentWidth)) }
      let entryH = measured.reduce(0) { $0 + $1.m.height } + 4 * 4
      if entryH > cursor.remaining, !cursor.atTop {
        cursor.newPage(.answer)
      }
      for (lineIndex, line) in measured.enumerated() {
        if lineIndex > 0 { cursor.advance(4) }
        for textLine in line.m.lines {
          if line.m.lineHeight > cursor.remaining, !cursor.atTop {
            cursor.newPage(.answer)
          }
          cursor.add(PracticeElement(kind: .text, rect: CGRect(x: metrics.margin, y: cursor.y, width: metrics.contentWidth, height: line.m.lineHeight),
                                     text: textLine, fontSize: line.fontSize, bold: line.bold))
          cursor.advance(line.m.lineHeight)
        }
      }
      if index < snapshot.answerSheet.count - 1 { cursor.advance(12) }
    }
  }

  /// 提示原文若已带"一级提示："前缀则原样印，否则补上；为空印"（无）"。
  private static func hintLine(prefix: String, text: String?) -> String {
    guard let text, !text.isEmpty else { return "\(prefix)（无）" }
    return text.hasPrefix(prefix) ? text : prefix + text
  }

  private static func answerLine(_ answer: V2PrintAnswerBody) -> String {
    guard let text = answer.text, !text.isEmpty else { return "答案：（无）" }
    if let label = answer.label, !label.isEmpty {
      return "答案：\(text)（\(label)）"
    }
    return "答案：\(text)"
  }

  // MARK: 页脚

  private static func addFooters(week: String, measurer: PracticeTextMeasurer, metrics: PracticePageMetrics, cursor: inout Cursor) {
    let total = cursor.pages.count
    let footerY = metrics.contentBottom + 10
    let footerH = metrics.footerFontSize * 1.5
    let right = metrics.margin + metrics.contentWidth
    for index in 0..<total {
      let pageNumber = "第 \(index + 1) / \(total) 页"
      let leftText = "\(week) 本周练习"
      let numberWidth = measurer.width(of: pageNumber, fontSize: metrics.footerFontSize, bold: false)
      let rightWidth = measurer.width(of: footerRight, fontSize: metrics.footerFontSize, bold: false)
      cursor.pages[index].elements.append(PracticeElement(kind: .text, rect: CGRect(x: metrics.margin, y: footerY, width: metrics.contentWidth / 2, height: footerH),
                                                          text: leftText, fontSize: metrics.footerFontSize, gray: true))
      cursor.pages[index].elements.append(PracticeElement(kind: .text, rect: CGRect(x: metrics.margin + (metrics.contentWidth - numberWidth) / 2, y: footerY, width: numberWidth, height: footerH),
                                                          text: pageNumber, fontSize: metrics.footerFontSize, gray: true))
      cursor.pages[index].elements.append(PracticeElement(kind: .text, rect: CGRect(x: right - rightWidth, y: footerY, width: rightWidth, height: footerH),
                                                          text: footerRight, fontSize: metrics.footerFontSize, gray: true))
    }
  }

  // MARK: 工具

  private static func addTextBlock(_ text: String, fontSize: CGFloat, bold: Bool, measurer: PracticeTextMeasurer, metrics: PracticePageMetrics, cursor: inout Cursor) {
    let measured = measurer.measure(text, fontSize: fontSize, bold: bold, width: metrics.contentWidth)
    for line in measured.lines {
      cursor.add(PracticeElement(kind: .text, rect: CGRect(x: metrics.margin, y: cursor.y, width: metrics.contentWidth, height: measured.lineHeight),
                                 text: line, fontSize: fontSize, bold: bold))
      cursor.advance(measured.lineHeight)
    }
    if measured.lines.isEmpty { cursor.advance(measured.height) }
  }
}
