import XCTest
import Foundation
@testable import StudentCore

// T6p RED: 练习纸版面计算（task-6p-brief §1）。注入等宽假测量器，结果确定可断言。
final class PracticeLayoutTests: XCTestCase {

  // MARK: - 假测量器：ASCII 半宽、其余全宽，行高 1.5 倍字号，贪婪换行

  struct FakeMeasurer: PracticeTextMeasurer {
    func width(of text: String, fontSize: CGFloat, bold: Bool) -> CGFloat {
      text.reduce(0) { $0 + ($1.isASCII ? fontSize * 0.5 : fontSize) }
    }
    func measure(_ text: String, fontSize: CGFloat, bold: Bool, width: CGFloat) -> PracticeMeasuredText {
      let lineHeight = fontSize * 1.5
      guard !text.isEmpty else { return PracticeMeasuredText(height: 0, lineHeight: lineHeight, lines: []) }
      var lines: [String] = []
      for paragraph in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
        var current = ""
        var used: CGFloat = 0
        for ch in paragraph {
          let cw = ch.isASCII ? fontSize * 0.5 : fontSize
          if used + cw > width, !current.isEmpty {
            lines.append(current)
            current = ""
            used = 0
          }
          current.append(ch)
          used += cw
        }
        lines.append(current)
      }
      return PracticeMeasuredText(height: CGFloat(lines.count) * lineHeight, lineHeight: lineHeight, lines: lines)
    }
  }

  // MARK: - 夹具

  private func makeItem(position: Int, mode: V2PrintMode = .text, stemText: String? = "已知 x+y=1，求 x 的值。", cropMedia: String? = nil, diagramMedia: [String] = []) -> V2PrintItem {
    V2PrintItem(
      itemId: "itm_\(position)", shortId: "M-0\(position + 1)", position: position,
      subject: "数学", knowledgeTags: ["一元一次方程", "移项"], mode: mode,
      stemText: stemText, cropMedia: cropMedia, diagramMedia: diagramMedia,
      keyStepPrompt: "这题的关键一步是：", checkboxes: ["独立做出", "看了一级提示", "看了二级提示", "没做出来"],
      needsGlance: false, glanceReason: nil)
  }

  private func makeAnswer(_ position: Int, hint1: String? = "一级提示：先移项", hint2: String? = "二级提示：两边同时减 y", answerText: String? = "x = 12", label: String? = "AI 参考，未经老师核验") -> V2PrintAnswerEntry {
    V2PrintAnswerEntry(
      shortId: "M-0\(position + 1)", hint1: hint1, hint2: hint2,
      answer: V2PrintAnswerBody(text: answerText, source: answerText == nil ? .none : .ai, label: label),
      fallbackNote: "对照原卷第 \(position + 1) 题")
  }

  private func makeSnapshot(items: [V2PrintItem], answers: [V2PrintAnswerEntry]) -> V2PrintSnapshot {
    V2PrintSnapshot(
      packetId: "pkt_1", week: "2026-W40", preparedAt: Date(timeIntervalSince1970: 1_759_200_000),
      cover: V2PrintCover(
        title: "本周练习", practiceSlot: "周三晚自习",
        rules: ["不看答案，独立做", "卡住先看一级提示，再看二级", "做完打勾，写上做题日期"],
        itemList: items.sorted { $0.position < $1.position }.map { V2PrintCoverItem(shortId: $0.shortId, sourceLabel: "原题") }),
      items: items, answerSheet: answers)
  }

  private func compute(_ snapshot: V2PrintSnapshot, imageSizes: [String: CGSize] = [:]) -> PracticeLayoutResult {
    PracticeLayout.compute(snapshot: snapshot, imageSizes: imageSizes, measurer: FakeMeasurer(), metrics: PracticePageMetrics())
  }

  private func texts(_ page: PracticePage) -> [String] {
    page.elements.compactMap(\.text)
  }

  /// 这些页上的题号标题（加粗 12pt 的文本元素）。
  /// 分成带显式类型的几步：整条链写在一个表达式里，Swift 6.2 会报「表达式太复杂，无法在合理时间内类型检查」
  ///（6.4 能过，但要 1–4 秒）。
  private func headerTexts(in pages: [PracticePage]) -> [String] {
    let elements: [PracticeElement] = pages.flatMap { $0.elements }
    let headers: [PracticeElement] = elements.filter { $0.kind == .text && $0.bold && $0.fontSize == 12 }
    return headers.compactMap(\.text)
  }

  /// 长题干：CJK 每字 12pt，版心 515pt，每行 42 字。
  private func longStem(lines: Int) -> String {
    String(repeating: "题", count: lines * 42)
  }

  // MARK: - 封面

  func testCoverPageHasAllElements() {
    let snapshot = makeSnapshot(items: [makeItem(position: 0), makeItem(position: 1)], answers: [makeAnswer(0), makeAnswer(1)])
    let result = compute(snapshot)
    let cover = result.pages[0]
    XCTAssertEqual(cover.role, .cover)
    let texts = texts(cover)
    XCTAssertTrue(texts.contains("本周练习"))
    XCTAssertTrue(texts.contains("2026-W40"))
    XCTAssertTrue(texts.contains("做题时段：周三晚自习"))
    XCTAssertTrue(texts.contains("1. 不看答案，独立做"))
    XCTAssertTrue(texts.contains("2. 卡住先看一级提示，再看二级"))
    XCTAssertTrue(texts.contains("3. 做完打勾，写上做题日期"))
    XCTAssertTrue(texts.contains { $0.contains("M-01") && $0.contains("原题") })
    XCTAssertTrue(texts.contains { $0.contains("M-02") && $0.contains("原题") })
    XCTAssertTrue(texts.contains { $0.contains("做题日期：") })
  }

  // MARK: - 题目顺序

  func testQuestionOrderFollowsPositionNotArrayOrder() {
    let snapshot = makeSnapshot(
      items: [makeItem(position: 2), makeItem(position: 0), makeItem(position: 1)],
      answers: [makeAnswer(0), makeAnswer(1), makeAnswer(2)])
    let result = compute(snapshot)
    let questionPages = result.pages.filter { $0.role == .question }
    let headers: [String] = headerTexts(in: questionPages)
    XCTAssertEqual(headers, ["M-01", "M-02", "M-03"])
  }

  // MARK: - 区块不跨页

  func testBlockMovesToNextPageWhenItDoesNotFit() {
    let snapshot = makeSnapshot(
      items: (0..<3).map { makeItem(position: $0) },
      answers: (0..<3).map { makeAnswer($0) })
    let result = compute(snapshot)
    let questionPages = result.pages.filter { $0.role == .question }
    for position in 0..<3 {
      let headerPage = questionPages.firstIndex { texts($0).contains("M-0\(position + 1)") }
      let keyPage = questionPages.firstIndex { page in
        page.elements.contains { $0.kind == .keyStepLine && texts(page).contains("这题的关键一步是：") }
      }
      XCTAssertNotNil(headerPage)
      XCTAssertNotNil(keyPage)
    }
    // 页版心 734pt，一块约 245pt：一页两块，第三块必须整块换页。
    let firstQuestionPage = questionPages[0]
    let firstPageHeaders = firstQuestionPage.elements.filter { $0.kind == .text && $0.bold && $0.fontSize == 12 }.compactMap(\.text)
    XCTAssertEqual(firstPageHeaders, ["M-01", "M-02"])
    let secondPageHeaders = questionPages[1].elements.filter { $0.kind == .text && $0.bold && $0.fontSize == 12 }.compactMap(\.text)
    XCTAssertEqual(secondPageHeaders, ["M-03"])
    // 每块的题头、关键一步、勾选框在同一页（一页可多块，故勾选框数为 4 的倍数）。
    for position in 0..<3 {
      let header = questionPages.enumerated().first { texts($0.element).contains("M-0\(position + 1)") }!
      let page = questionPages[header.offset]
      XCTAssertTrue(texts(page).contains("这题的关键一步是："), "第 \(position) 题区块跨页了")
      let checkboxCount = page.elements.filter { $0.kind == .checkbox }.count
      XCTAssertTrue(checkboxCount >= 4 && checkboxCount % 4 == 0)
    }
  }

  // MARK: - 超长题干拆分

  func testBlockJustUnderOnePageIsNotSplit() {
    // 27 行题干：总高约 712pt ≤ 734pt，整块一页。
    let snapshot = makeSnapshot(items: [makeItem(position: 0, stemText: longStem(lines: 27))], answers: [makeAnswer(0)])
    let result = compute(snapshot)
    let questionPages = result.pages.filter { $0.role == .question }
    XCTAssertEqual(questionPages.count, 1, "没超过一页的区块不许拆")
    XCTAssertTrue(texts(questionPages[0]).contains("这题的关键一步是："))
    XCTAssertFalse(questionPages[0].elements.filter { $0.kind == .writingLine }.isEmpty)
  }

  func testOversizedBlockSplitsWithAnswerSpaceFillingPage() {
    // 29 行题干（522pt）：区块总高约 749pt > 734pt；题头+题面 546pt 之后本页剩 188pt ≥ 150pt，
    // 合法拆法：留白填满本页，关键一步与勾选框去下一页。
    let snapshot = makeSnapshot(items: [makeItem(position: 0, stemText: longStem(lines: 29))], answers: [makeAnswer(0)])
    let result = compute(snapshot)
    let questionPages = result.pages.filter { $0.role == .question }
    XCTAssertEqual(questionPages.count, 2)
    XCTAssertTrue(texts(questionPages[0]).contains("M-01"))
    XCTAssertFalse(texts(questionPages[0]).contains("这题的关键一步是："), "拆点只能在题面之后、留白内部")
    XCTAssertFalse(questionPages[0].elements.filter { $0.kind == .writingLine }.isEmpty, "留白应填满本页")
    XCTAssertTrue(texts(questionPages[1]).contains("这题的关键一步是："))
    XCTAssertEqual(questionPages[1].elements.filter { $0.kind == .checkbox }.count, 4)
  }

  func testOversizedBlockSplitsBeforeAnswerSpaceWhenNoRoomLeft() {
    // 39 行题干（702pt）：题头+题面 726pt，本页只剩 8pt < 150pt，
    // 合法拆法：留白整体去下一页（150pt 起步），关键一步与勾选框跟随其后。
    let snapshot = makeSnapshot(items: [makeItem(position: 0, stemText: longStem(lines: 39))], answers: [makeAnswer(0)])
    let result = compute(snapshot)
    let questionPages = result.pages.filter { $0.role == .question }
    XCTAssertEqual(questionPages.count, 2)
    XCTAssertTrue(questionPages[0].elements.filter { $0.kind == .writingLine }.isEmpty, "本页放不下 150pt 留白时，留白从下一页开始")
    let writingLines = questionPages[1].elements.filter { $0.kind == .writingLine }
    XCTAssertEqual(writingLines.count, 5, "150pt 留白、行距 28pt → 5 条横线")
    XCTAssertTrue(texts(questionPages[1]).contains("这题的关键一步是："))
  }

  // MARK: - 图片缩放三条上限

  func testImageScalingRespectsAllThreeCaps() {
    let item = makeItem(position: 0, diagramMedia: ["big.jpg", "small.jpg", "wide.jpg"])
    let snapshot = makeSnapshot(items: [item], answers: [makeAnswer(0)])
    let result = compute(snapshot, imageSizes: [
      "big.jpg": CGSize(width: 3000, height: 2000),   // 150dpi → 1440×960pt，受宽与高两条上限
      "small.jpg": CGSize(width: 100, height: 100),   // 150dpi → 48×48pt，不放大
      "wide.jpg": CGSize(width: 2000, height: 500),   // 150dpi → 960×240pt，只受宽上限
    ])
    let questionPages: [PracticePage] = result.pages.filter { $0.role == .question }
    let questionElements: [PracticeElement] = questionPages.flatMap { $0.elements }
    let images: [PracticeElement] = questionElements.filter { $0.kind == .image }
    XCTAssertEqual(images.count, 3)
    let big = images.first { $0.imageName == "big.jpg" }!
    XCTAssertEqual(big.rect.height, 734 * 0.45, accuracy: 0.6, "高不超过 0.45 × 版心高")
    XCTAssertLessThanOrEqual(big.rect.width, 515, "宽不超过版心宽")
    XCTAssertEqual(big.rect.width / big.rect.height, 1.5, accuracy: 0.01, "等比缩放")
    let small = images.first { $0.imageName == "small.jpg" }!
    XCTAssertEqual(small.rect.width, 48, accuracy: 0.01, "不放大超过 150dpi 对应尺寸")
    XCTAssertEqual(small.rect.height, 48, accuracy: 0.01)
    let wide = images.first { $0.imageName == "wide.jpg" }!
    XCTAssertEqual(wide.rect.width, 515, accuracy: 0.01)
    XCTAssertEqual(wide.rect.height, 240 * 515 / 960, accuracy: 0.5)
  }

  func testMissingImageBecomesPlaceholderWithoutCrashing() {
    let item = makeItem(position: 0, diagramMedia: ["lost.jpg"])
    let snapshot = makeSnapshot(items: [item], answers: [makeAnswer(0)])
    let result = compute(snapshot) // imageSizes 里没有 lost.jpg
    let elements = result.pages.filter { $0.role == .question }.flatMap { $0.elements }
    let placeholder = elements.first { $0.kind == .imageMissing }
    XCTAssertNotNil(placeholder)
    XCTAssertTrue(placeholder?.text?.contains("图片缺失") == true)
    XCTAssertTrue(placeholder?.text?.contains("lost.jpg") == true)
  }

  // MARK: - crop 模式

  func testCropModePrintsStemThenNoteThenImage() {
    let item = makeItem(position: 0, mode: .crop, stemText: "这题识别没把握", cropMedia: "crop.jpg")
    let snapshot = makeSnapshot(items: [item], answers: [makeAnswer(0)])
    let result = compute(snapshot, imageSizes: ["crop.jpg": CGSize(width: 900, height: 600)])
    let page = result.pages.first { $0.role == .question }!
    let stem = page.elements.first { $0.text == "这题识别没把握" }
    let note = page.elements.first { $0.text?.contains("AI 对这题没把握") == true }
    let image = page.elements.first { $0.kind == .image && $0.imageName == "crop.jpg" }
    XCTAssertNotNil(stem)
    XCTAssertNotNil(note)
    XCTAssertNotNil(image)
    XCTAssertLessThan(stem!.rect.minY, note!.rect.minY, "先文字，再提示小字，再截图")
    XCTAssertLessThan(note!.rect.minY, image!.rect.minY)
    XCTAssertLessThan(note!.fontSize, 12, "提示是小字")
  }

  func testCropModeWithoutStemTextPrintsNoteThenImage() {
    let item = makeItem(position: 0, mode: .crop, stemText: nil, cropMedia: "crop.jpg")
    let snapshot = makeSnapshot(items: [item], answers: [makeAnswer(0)])
    let result = compute(snapshot, imageSizes: ["crop.jpg": CGSize(width: 900, height: 600)])
    let page = result.pages.first { $0.role == .question }!
    XCTAssertFalse(page.elements.contains { $0.text == "这题识别没把握" })
    let note = page.elements.first { $0.text?.contains("AI 对这题没把握") == true }
    let image = page.elements.first { $0.kind == .image && $0.imageName == "crop.jpg" }
    XCTAssertNotNil(note)
    XCTAssertNotNil(image)
    XCTAssertLessThan(note!.rect.minY, image!.rect.minY)
  }

  // MARK: - 答案页

  func testAnswerSheetStartsOnFreshPageEvenWhenSpaceRemains() {
    let snapshot = makeSnapshot(items: [makeItem(position: 0)], answers: [makeAnswer(0)])
    let result = compute(snapshot)
    let answerIndex = result.pages.firstIndex { $0.role == .answer }
    let questionIndices = result.pages.indices.filter { result.pages[$0].role == .question }
    XCTAssertNotNil(answerIndex)
    for index in questionIndices { XCTAssertLessThan(index, answerIndex!, "答案页必须另起一页") }
    let answerPage = result.pages[answerIndex!]
    XCTAssertTrue(texts(answerPage).contains("做完再看"))
    XCTAssertTrue(texts(answerPage).contains("先独立做；卡住了按一级、二级提示的顺序看"))
  }

  func testQuestionPagesNeverContainHintsOrAnswers() {
    let snapshot = makeSnapshot(
      items: [makeItem(position: 0), makeItem(position: 1)],
      answers: [makeAnswer(0, hint1: "一级提示：先移项", hint2: "二级提示：变号", answerText: "x = 12"), makeAnswer(1)])
    let result = compute(snapshot)
    let questionAndCoverTexts = result.pages.filter { $0.role != .answer }.flatMap { texts($0) }.joined(separator: "\n")
    XCTAssertFalse(questionAndCoverTexts.contains("先移项"))
    XCTAssertFalse(questionAndCoverTexts.contains("变号"))
    XCTAssertFalse(questionAndCoverTexts.contains("x = 12"))
    XCTAssertFalse(questionAndCoverTexts.contains("对照原卷"), "fallbackNote 只属于答案页")
    let answerTexts = result.pages.filter { $0.role == .answer }.flatMap { texts($0) }.joined(separator: "\n")
    XCTAssertTrue(answerTexts.contains("先移项"))
    XCTAssertTrue(answerTexts.contains("x = 12（AI 参考，未经老师核验）"))
    XCTAssertTrue(answerTexts.contains("对照原卷第 1 题"))
    XCTAssertTrue(answerTexts.contains("对照原卷第 2 题"))
  }

  func testEmptyHintsAndAnswerPrintPlaceholders() {
    let snapshot = makeSnapshot(
      items: [makeItem(position: 0)],
      answers: [makeAnswer(0, hint1: nil, hint2: nil, answerText: nil, label: nil)])
    let result = compute(snapshot)
    let answerTexts = result.pages.filter { $0.role == .answer }.flatMap { texts($0) }.joined(separator: "\n")
    XCTAssertTrue(answerTexts.contains("一级提示：（无）"))
    XCTAssertTrue(answerTexts.contains("二级提示：（无）"))
    XCTAssertTrue(answerTexts.contains("答案：（无）"))
    XCTAssertTrue(answerTexts.contains("对照原卷第 1 题"), "fallbackNote 始终印")
  }

  // MARK: - 页脚

  func testEveryPageHasFooterWithCorrectPageNumbers() {
    let snapshot = makeSnapshot(
      items: (0..<3).map { makeItem(position: $0) },
      answers: (0..<3).map { makeAnswer($0) })
    let result = compute(snapshot)
    let total = result.pages.count
    XCTAssertGreaterThanOrEqual(total, 3)
    for (index, page) in result.pages.enumerated() {
      let texts = texts(page)
      XCTAssertTrue(texts.contains("2026-W40 本周练习"), "第 \(index + 1) 页缺左页脚")
      XCTAssertTrue(texts.contains("第 \(index + 1) / \(total) 页"), "第 \(index + 1) 页页码不对")
      XCTAssertTrue(texts.contains("纸错题延迟重做"), "第 \(index + 1) 页缺右页脚")
    }
  }

  // MARK: - 规模

  func testThreeItemSnapshotLayout() {
    let snapshot = makeSnapshot(
      items: (0..<3).map { makeItem(position: $0) },
      answers: (0..<3).map { makeAnswer($0) })
    let result = compute(snapshot)
    XCTAssertEqual(result.pages[0].role, .cover)
    XCTAssertEqual(result.pages.last?.role, .answer)
    let questionPages: [PracticePage] = result.pages.filter { $0.role == .question }
    let questionHeaders: [String] = headerTexts(in: questionPages)
    XCTAssertEqual(questionHeaders, ["M-01", "M-02", "M-03"])
    let answerTexts = result.pages.filter { $0.role == .answer }.flatMap { texts($0) }
    for position in 0..<3 { XCTAssertTrue(answerTexts.contains("M-0\(position + 1)")) }
  }

  // MARK: - 页尾空白并入作答留白（T6e-w）

  /// 页面内容底部（页脚保留区上沿）：842 - 40 - 28 = 774。
  private let contentBottom: CGFloat = 774

  func testTrailingSpaceMergesIntoLastBlockAnswerSpace() {
    // 单题：旧行为留白固定 150pt，勾选框底部停在 284.5pt，页面下半截空白。
    // 新行为：页尾剩余空间并入作答留白，"关键一步"与勾选框移到页面底部。
    let snapshot = makeSnapshot(items: [makeItem(position: 0)], answers: [makeAnswer(0)])
    let result = compute(snapshot)
    let questionPages = result.pages.filter { $0.role == .question }
    XCTAssertEqual(questionPages.count, 1)
    let page = questionPages[0]
    let checkboxes = page.elements.filter { $0.kind == .checkbox }
    XCTAssertEqual(checkboxes.count, 4)
    for box in checkboxes {
      XCTAssertEqual(box.rect.maxY, contentBottom, accuracy: 0.01, "勾选框行应落在页面底部")
    }
    let dateText = page.elements.first { $0.text == "做题日期：________" }
    XCTAssertEqual(dateText?.rect.maxY ?? 0, contentBottom, accuracy: 0.01, "做题日期跟着勾选框到底部")
    let keyStep = page.elements.first { $0.text == "这题的关键一步是：" }
    XCTAssertNotNil(keyStep)
    XCTAssertGreaterThan(keyStep!.rect.minY, 700, "关键一步行随之下移到页面底部")
    // 横线按 28pt 行距继续画下去：题头+题面后剩余 686pt，留白 639.5pt → 22 条横线（旧行为只有 5 条）。
    let writingLines = page.elements.filter { $0.kind == .writingLine }
    XCTAssertEqual(writingLines.count, 22, "横线应继续按 28pt 行距画到页面底部")
    XCTAssertEqual(writingLines.last?.rect.minY ?? 0, 704, accuracy: 0.01)
  }

  func testTrailingFillAppliesPerPageToLastBlockOnly() {
    // 三道题：第一页放 M-01、M-02，第二页放 M-03。
    // 每页只有"该页最后一题"吃掉页尾空白；M-01 的勾选框仍在原位置（284.5pt），不得下移。
    let snapshot = makeSnapshot(
      items: (0..<3).map { makeItem(position: $0) },
      answers: (0..<3).map { makeAnswer($0) })
    let result = compute(snapshot)
    let questionPages = result.pages.filter { $0.role == .question }
    XCTAssertEqual(questionPages.count, 2)
    let page1Boxes = questionPages[0].elements.filter { $0.kind == .checkbox }
    XCTAssertEqual(page1Boxes.count, 8)
    let firstBlockBoxes = page1Boxes.prefix(4)
    let lastBlockBoxes = page1Boxes.suffix(4)
    for box in firstBlockBoxes {
      XCTAssertEqual(box.rect.maxY, 284.5, accuracy: 0.01, "不是本页最后一题，留白保持 150pt")
    }
    for box in lastBlockBoxes {
      XCTAssertEqual(box.rect.maxY, contentBottom, accuracy: 0.01, "本页最后一题并入页尾空白")
    }
    let page2Boxes = questionPages[1].elements.filter { $0.kind == .checkbox }
    XCTAssertEqual(page2Boxes.count, 4)
    for box in page2Boxes {
      XCTAssertEqual(box.rect.maxY, contentBottom, accuracy: 0.01, "第二页最后一题同样并入页尾空白")
    }
  }

  func testCoverAndAnswerPagesDoNotFillTrailingSpace() {
    // 封面与答案页不适用并入规则：封面没有横线，答案页条目从页首顺排、不沉到底部。
    let snapshot = makeSnapshot(items: [makeItem(position: 0)], answers: [makeAnswer(0)])
    let result = compute(snapshot)
    let cover = result.pages[0]
    XCTAssertEqual(cover.role, .cover)
    XCTAssertTrue(cover.elements.filter { $0.kind == .writingLine }.isEmpty)
    let answerPage = result.pages.first { $0.role == .answer }!
    XCTAssertTrue(answerPage.elements.filter { $0.kind == .writingLine }.isEmpty)
    let lastAnswerText = answerPage.elements.filter { $0.kind == .text && $0.rect.minY < contentBottom }.last
    XCTAssertLessThan(lastAnswerText?.rect.maxY ?? 0, contentBottom - 100, "答案页内容不沉到页面底部")
  }

  func testEightItemSnapshotLayout() {
    let snapshot = makeSnapshot(
      items: (0..<8).map { makeItem(position: $0) },
      answers: (0..<8).map { makeAnswer($0) })
    let result = compute(snapshot)
    XCTAssertEqual(result.pages[0].role, .cover)
    let questionPages: [PracticePage] = result.pages.filter { $0.role == .question }
    let questionHeaders: [String] = headerTexts(in: questionPages)
    let expectedHeaders: [String] = (0..<8).map { "M-0\($0 + 1)" }
    XCTAssertEqual(questionHeaders, expectedHeaders)
    let answerTexts = result.pages.filter { $0.role == .answer }.flatMap { texts($0) }
    for position in 0..<8 { XCTAssertTrue(answerTexts.contains("M-0\(position + 1)")) }
    XCTAssertGreaterThanOrEqual(result.pages.count, 4)
  }
}
