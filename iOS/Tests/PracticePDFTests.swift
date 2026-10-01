import XCTest
import Foundation
import CoreGraphics
import ImageIO
#if canImport(PDFKit)
import PDFKit
#endif
@testable import StudentCore

// T6p RED: 按版面结果画 PDF（task-6p-brief §2）。真实 CoreText，合成 JPEG，断页数与页面尺寸。
final class PracticePDFTests: XCTestCase {

  private var tempDir: URL!

  override func setUpWithError() throws {
    tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("practice-pdf-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: tempDir)
  }

  // MARK: - 夹具

  /// CoreGraphics 现场生成的合成 JPEG（纯灰底）。
  private func makeJPEG(_ name: String, width: Int, height: Int) throws {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(gray: 0.9, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(gray: 0.4, alpha: 1)
    context.fill(CGRect(x: 10, y: 10, width: width / 2, height: height / 2))
    let image = context.makeImage()!
    let url = tempDir.appendingPathComponent(name)
    let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.jpeg" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
  }

  private func makeItem(position: Int, mode: V2PrintMode = .text, stemText: String? = "已知 x+y=1，求 x 的值。", cropMedia: String? = nil, diagramMedia: [String] = []) -> V2PrintItem {
    V2PrintItem(
      itemId: "itm_\(position)", shortId: "M-0\(position + 1)", position: position,
      subject: "数学", knowledgeTags: ["一元一次方程"], mode: mode,
      stemText: stemText, cropMedia: cropMedia, diagramMedia: diagramMedia,
      keyStepPrompt: "这题的关键一步是：", checkboxes: ["独立做出", "看了一级提示", "看了二级提示", "没做出来"],
      needsGlance: false, glanceReason: nil)
  }

  private func makeAnswer(_ position: Int) -> V2PrintAnswerEntry {
    V2PrintAnswerEntry(
      shortId: "M-0\(position + 1)", hint1: "一级提示：先移项", hint2: "二级提示：变号",
      answer: V2PrintAnswerBody(text: "x = 12", source: .ai, label: "AI 参考，未经老师核验"),
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

  private func threeItemSnapshot() -> V2PrintSnapshot {
    makeSnapshot(items: [
      makeItem(position: 0),
      makeItem(position: 1, diagramMedia: ["d1.jpg"]),
      makeItem(position: 2, mode: .crop, stemText: "这题 AI 没把握，文字与截图都印", cropMedia: "c1.jpg"),
    ], answers: (0..<3).map { makeAnswer($0) })
  }

  private func eightItemSnapshot() -> V2PrintSnapshot {
    let stem = String(repeating: "题", count: 400)
    return makeSnapshot(
      items: (0..<8).map { makeItem(position: $0, stemText: stem) },
      answers: (0..<8).map { makeAnswer($0) })
  }

  private func mediaURL(name: String) -> URL? {
    tempDir.appendingPathComponent(name)
  }

  // MARK: - 基本渲染

  func testRenderThreeItemSnapshot() throws {
    try makeJPEG("d1.jpg", width: 800, height: 600)
    try makeJPEG("c1.jpg", width: 1200, height: 900)
    let output = tempDir.appendingPathComponent("out.pdf")
    try PracticePDF.render(snapshot: threeItemSnapshot(), mediaURL: mediaURL, to: output)

    let document = try XCTUnwrap(CGPDFDocument(output as CFURL))
    XCTAssertGreaterThanOrEqual(document.numberOfPages, 3, "封面 + 题目页 + 答案页")
    for index in 1...document.numberOfPages {
      let page = try XCTUnwrap(document.page(at: index))
      XCTAssertEqual(page.getBoxRect(.mediaBox).width, 595, accuracy: 0.5)
      XCTAssertEqual(page.getBoxRect(.mediaBox).height, 842, accuracy: 0.5)
    }
  }

  #if canImport(PDFKit)
  func testRenderedTextContent() throws {
    try makeJPEG("d1.jpg", width: 800, height: 600)
    try makeJPEG("c1.jpg", width: 1200, height: 900)
    let output = tempDir.appendingPathComponent("out.pdf")
    try PracticePDF.render(snapshot: threeItemSnapshot(), mediaURL: mediaURL, to: output)

    let document = try XCTUnwrap(PDFDocument(url: output))
    let total = document.pageCount
    let coverText = document.page(at: 0)?.string ?? ""
    XCTAssertTrue(coverText.contains("周三晚自习"), "封面含做题时段")
    XCTAssertTrue(coverText.contains("第 1 / \(total) 页"), "页脚含页码")

    let answerIndex = (0..<total).first { document.page(at: $0)?.string?.contains("做完再看") == true }
    XCTAssertNotNil(answerIndex, "答案页含'做完再看'")
    let answerText = document.page(at: answerIndex!)?.string ?? ""
    XCTAssertTrue(answerText.contains("M-01"))
    XCTAssertTrue(answerText.contains("M-02"))
    XCTAssertTrue(answerText.contains("M-03"))
    XCTAssertTrue(answerText.contains("对照原卷第 1 题"))

    for index in 0..<answerIndex! {
      let text = document.page(at: index)?.string ?? ""
      XCTAssertFalse(text.contains("先移项"), "题目页不得出现提示")
      XCTAssertFalse(text.contains("变号"), "题目页不得出现提示")
      XCTAssertFalse(text.contains("x = 12"), "题目页不得出现答案")
    }
  }
  #endif

  func testEightLongStemSnapshotRendersWithoutCrashing() throws {
    let output = tempDir.appendingPathComponent("long.pdf")
    try PracticePDF.render(snapshot: eightItemSnapshot(), mediaURL: mediaURL, to: output)
    let document = try XCTUnwrap(CGPDFDocument(output as CFURL))
    XCTAssertGreaterThanOrEqual(document.numberOfPages, 3)
  }

  func testMissingImageFileStillRenders() throws {
    // d1.jpg / c1.jpg 不存在：版面按占位处理，绘制画"图片缺失"框，不抛错。
    let output = tempDir.appendingPathComponent("missing.pdf")
    try PracticePDF.render(snapshot: threeItemSnapshot(), mediaURL: mediaURL, to: output)
    let document = try XCTUnwrap(CGPDFDocument(output as CFURL))
    XCTAssertGreaterThanOrEqual(document.numberOfPages, 3)
  }

  func testRenderOverwritesExistingOutputAtomically() throws {
    let output = tempDir.appendingPathComponent("out.pdf")
    try "junk".write(to: output, atomically: false, encoding: .utf8)
    try PracticePDF.render(snapshot: threeItemSnapshot(), mediaURL: mediaURL, to: output)
    XCTAssertNotNil(CGPDFDocument(output as CFURL), "旧文件被新 PDF 替换")
  }

  // MARK: - 样张（给审查者看）

  func testSamplePDFsWrittenWhenEnvSet() throws {
    try makeJPEG("d1.jpg", width: 800, height: 600)
    try makeJPEG("c1.jpg", width: 1200, height: 900)
    guard let dir = ProcessInfo.processInfo.environment["SEL_PDF_SAMPLE_DIR"], !dir.isEmpty else {
      return // 没设置就不写样张
    }
    let sampleDir = URL(fileURLWithPath: dir, isDirectory: true)
    try FileManager.default.createDirectory(at: sampleDir, withIntermediateDirectories: true)
    let sample3 = sampleDir.appendingPathComponent("practice-sample-3.pdf")
    let sample8 = sampleDir.appendingPathComponent("practice-sample-8.pdf")
    try PracticePDF.render(snapshot: threeItemSnapshot(), mediaURL: mediaURL, to: sample3)
    try PracticePDF.render(snapshot: eightItemSnapshot(), mediaURL: mediaURL, to: sample8)
    XCTAssertNotNil(CGPDFDocument(sample3 as CFURL))
    XCTAssertNotNil(CGPDFDocument(sample8 as CFURL))
  }
}
