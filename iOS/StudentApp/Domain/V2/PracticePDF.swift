import Foundation
import CoreGraphics
import CoreText
import ImageIO

// 按 PracticeLayoutResult 画出 PDF（task-6p-brief §2）。
// 只做"按版面结果画"，不含任何版面决策。不得 import UIKit / SwiftUI / AppKit。
enum PracticePDF {

  enum RenderError: Error {
    case cannotCreateContext
  }

  /// mediaURL：文件名 → 本地文件 URL。图片读不出来时在原位置画细线框 + "图片缺失"，不抛错。
  static func render(snapshot: V2PrintSnapshot, mediaURL: (String) -> URL?, to outputURL: URL) throws {
    var names: [String] = []
    for item in snapshot.items {
      if let crop = item.cropMedia { names.append(crop) }
      names.append(contentsOf: item.diagramMedia)
    }
    var imageSizes: [String: CGSize] = [:]
    var images: [String: CGImage] = [:]
    for name in Set(names) {
      guard let url = mediaURL(name), let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { continue }
      if let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
         let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
         let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue {
        imageSizes[name] = CGSize(width: width, height: height)
      }
      if let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
        images[name] = image
      }
    }

    let metrics = PracticePageMetrics()
    let layout = PracticeLayout.compute(snapshot: snapshot, imageSizes: imageSizes, measurer: CoreTextPracticeMeasurer(), metrics: metrics)

    let directory = outputURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // 原子写入：先写临时文件再移动。
    let temporary = directory.appendingPathComponent(".\(UUID().uuidString).pdf")
    defer { try? FileManager.default.removeItem(at: temporary) }

    var mediaBox = CGRect(x: 0, y: 0, width: metrics.pageWidth, height: metrics.pageHeight)
    let info: [CFString: String] = [
      kCGPDFContextTitle: "本周练习 \(snapshot.week)",
      kCGPDFContextCreator: "超级错题本",
    ]
    guard let context = CGContext(temporary as CFURL, mediaBox: &mediaBox, info as CFDictionary) else {
      throw RenderError.cannotCreateContext
    }
    for page in layout.pages {
      context.beginPDFPage(nil)
      context.saveGState()
      // 版面坐标原点在左上、y 向下；PDF 原点在左下。整体翻转到 y 向下坐标系。
      context.translateBy(x: 0, y: metrics.pageHeight)
      context.scaleBy(x: 1, y: -1)
      for element in page.elements {
        draw(element, context: context, images: images)
      }
      context.restoreGState()
      context.endPDFPage()
    }
    context.closePDF()

    if FileManager.default.fileExists(atPath: outputURL.path) {
      try FileManager.default.removeItem(at: outputURL)
    }
    try FileManager.default.moveItem(at: temporary, to: outputURL)
  }

  // MARK: - 绘制（context 已翻转为 y 向下坐标系）

  private static func draw(_ element: PracticeElement, context: CGContext, images: [String: CGImage]) {
    switch element.kind {
    case .text:
      if let text = element.text, !text.isEmpty {
        drawText(text, in: element.rect, fontSize: element.fontSize, bold: element.bold, gray: element.gray, context: context)
      }
    case .checkbox:
      let box: CGFloat = 11
      let boxRect = CGRect(x: element.rect.minX, y: element.rect.minY + (element.rect.height - box) / 2, width: box, height: box)
      context.saveGState()
      context.setStrokeColor(CGColor(gray: 0, alpha: 1))
      context.setLineWidth(0.8)
      context.stroke(boxRect)
      context.restoreGState()
      if let label = element.text {
        drawText(label, in: CGRect(x: element.rect.minX + box + 4, y: element.rect.minY, width: element.rect.width - box - 4, height: element.rect.height),
                 fontSize: element.fontSize, bold: false, gray: false, context: context)
      }
    case .writingLine:
      strokeLine(element.rect, gray: 0.78, width: 0.5, context: context)
    case .separator:
      strokeLine(element.rect, gray: 0.6, width: 0.5, context: context)
    case .keyStepLine:
      strokeLine(element.rect, gray: 0.2, width: 0.7, context: context)
    case .image:
      if let name = element.imageName, let image = images[name] {
        context.saveGState()
        // 图片自身坐标 y 向上，在已翻转的坐标系里再翻回来。
        context.translateBy(x: element.rect.minX, y: element.rect.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(x: 0, y: 0, width: element.rect.width, height: element.rect.height))
        context.restoreGState()
      } else {
        drawMissingImage(element.rect, context: context)
      }
    case .imageMissing:
      drawMissingImage(element.rect, context: context)
    }
  }

  private static func drawText(_ text: String, in rect: CGRect, fontSize: CGFloat, bold: Bool, gray: Bool, context: CGContext) {
    let font = CTFontCreateWithName((bold ? "PingFangSC-Semibold" : "PingFangSC-Regular") as CFString, fontSize, nil)
    let attributed = NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: gray ? 0.35 : 0, alpha: 1),
    ])
    let line = CTLineCreateWithAttributedString(attributed)
    context.saveGState()
    // textMatrix 再翻一次，让字形在 y 向下坐标系里正立。
    context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    context.textPosition = CGPoint(x: rect.minX, y: rect.minY + CTFontGetAscent(font))
    CTLineDraw(line, context)
    context.restoreGState()
  }

  private static func strokeLine(_ rect: CGRect, gray: CGFloat, width: CGFloat, context: CGContext) {
    context.saveGState()
    context.setStrokeColor(CGColor(gray: gray, alpha: 1))
    context.setLineWidth(width)
    context.move(to: CGPoint(x: rect.minX, y: rect.minY))
    context.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    context.strokePath()
    context.restoreGState()
  }

  private static func drawMissingImage(_ rect: CGRect, context: CGContext) {
    context.saveGState()
    context.setStrokeColor(CGColor(gray: 0.5, alpha: 1))
    context.setLineWidth(0.5)
    context.stroke(rect)
    context.restoreGState()
    drawText("图片缺失", in: CGRect(x: rect.minX + 6, y: rect.minY + 6, width: rect.width - 12, height: rect.height - 12),
             fontSize: 9, bold: false, gray: true, context: context)
  }
}
