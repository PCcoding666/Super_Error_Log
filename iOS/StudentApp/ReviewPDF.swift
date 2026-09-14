import PDFKit
import SwiftUI
import UIKit
import CoreText

struct PDFDocumentItem: Identifiable {
  var id: URL { url }
  let url: URL
}

@MainActor enum ReviewPDF {
  static func write(pack: PaperPack, directory: URL) throws -> URL {
    guard !pack.problemIDs.isEmpty else { throw StudyError.emptySelection }
    let problems = pack.problemSnapshots
    guard problems.map(\.id) == pack.problemIDs else { throw StudyError.unsupportedState }
    // Validate every input before allocating an export. Original/source media are never read here.
    let diagramImages = try problems.map { problem in
      try problem.printableDiagramURLs(in: directory).map { url in
        let data = try Data(contentsOf: url)
        guard MediaReadability.isReadableJPEG(data), let image = UIImage(data: data) else { throw RecognitionClientError.missingMedia }
        return image
      }
    }
    let textPages = try problems.map { try PrintedTextLayout.ranges(for: $0.stem, width: 511, height: 550) }
    let folder = directory.appendingPathComponent("Exports", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent("Review-Pack-\(pack.id.uuidString).pdf")
    let bounds = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
    let format = UIGraphicsPDFRendererFormat()
    format.documentInfo = [
      kCGPDFContextTitle as String: "我的纸上练习",
      kCGPDFContextCreator as String: "超级错题本",
    ]
    let renderer = UIGraphicsPDFRenderer(bounds: bounds, format: format)
    let data = renderer.pdfData { context in
      for (index, problem) in problems.enumerated() {
        let header: [NSAttributedString.Key: Any] = [
          .font: UIFont.systemFont(ofSize: 10, weight: .semibold),
          .foregroundColor: UIColor.darkGray,
        ]
        func beginPage(_ subtitle: String) {
          context.beginPage()
          ("超级错题本  /  纸上练习" as NSString).draw(
            at: CGPoint(x: 42, y: 34), withAttributes: header)
          ("换张新纸，再试一次" as NSString).draw(
            at: CGPoint(x: 42, y: 63),
            withAttributes: [.font: UIFont.systemFont(ofSize: 27, weight: .semibold)])
          ("姓名：____________________     日期：____________________" as NSString).draw(
            at: CGPoint(x: 42, y: 108), withAttributes: [.font: UIFont.systemFont(ofSize: 11)])
          ("\(problem.isExample ? "示例题" : "已确认题目") · 第 \(problem.number) 题 · \(subtitle)    |    题目 \(index + 1) / \(problems.count)" as NSString).draw(
            at: CGPoint(x: 42, y: 796), withAttributes: header)
        }
        let setter = CTFramesetterCreateWithAttributedString(PrintedTextLayout.attributedText(problem.stem))
        var start: CGFloat = 375
        for (pageIndex, range) in textPages[index].enumerated() {
          beginPage("题干 \(pageIndex + 1) / \(textPages[index].count)")
          let path = CGPath(rect: CGRect(x: 42, y: bounds.height - 151 - 550, width: 511, height: 550), transform: nil)
          let frame = CTFramesetterCreateFrame(setter, CFRange(location: range.location, length: range.length), path, nil)
          let cg = context.cgContext
          cg.saveGState()
          cg.translateBy(x: 0, y: bounds.height); cg.scaleBy(x: 1, y: -1)
          cg.textMatrix = .identity
          CTFrameDraw(frame, cg)
          cg.restoreGState()
          let measured = CTFramesetterSuggestFrameSizeWithConstraints(setter,
            CFRange(location: range.location, length: range.length), nil, CGSize(width: 511, height: 550), nil)
          start = max(151 + ceil(measured.height) + 40, 375)
        }
        for image in diagramImages[index] {
          let scale = min(511 / image.size.width, 360 / image.size.height, 1)
          let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
          if start + size.height > 710 { beginPage("题目图示"); start = 151 }
          image.draw(in: CGRect(x: 42, y: start, width: size.width, height: size.height))
          start += size.height + 35
        }
        if start > 580 { beginPage("演算空间"); start = 170 }
        ("我的演算过程" as NSString).draw(at: CGPoint(x: 42, y: start - 20), withAttributes: header)
        let cg = context.cgContext
        cg.setStrokeColor(UIColor(white: 0.84, alpha: 1).cgColor)
        cg.setLineWidth(0.5)
        for y in stride(from: start + 20, through: 710.0, by: 32.0) {
          cg.move(to: CGPoint(x: 42, y: y))
          cg.addLine(to: CGPoint(x: 553, y: y))
          cg.strokePath()
        }
        ("完成后：  [ ] 独立完成   [ ] 需要提示   [ ] 还没做出来" as NSString).draw(
          at: CGPoint(x: 42, y: 744), withAttributes: [.font: UIFont.systemFont(ofSize: 11)])
      }
    }
    try data.write(to: url, options: .atomic)
    try StudyPersistence.excludeFromBackup(url)
    return url
  }
}

struct PDFPreview: View {
  let item: PDFDocumentItem
  @Environment(\.dismiss) private var dismiss
  @State private var sharing = false
  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        HStack(spacing: 8) {
          Image(systemName: "checkmark.circle")
          Text("已选题干与核对图示 · 演算空间 · A4 纸").font(.caption)
        }.foregroundStyle(Palette.teal).frame(maxWidth: .infinity).padding(14).background(
          Palette.mint)
        NativePDFView(url: item.url)
        Button {
          sharing = true
        } label: {
          Label("分享或打印", systemImage: "square.and.arrow.up")
        }
        .buttonStyle(PrimaryButton()).padding(20).background(Palette.paper)
      }.navigationTitle("你的练习包").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } } }
        .sheet(isPresented: $sharing) { ShareSheet(url: item.url) }
    }
  }
}

struct NativePDFView: UIViewRepresentable {
  let url: URL
  func makeUIView(context: Context) -> PDFView {
    let view = PDFView()
    view.document = PDFDocument(url: url)
    view.autoScales = true
    view.displayMode = .singlePageContinuous
    view.backgroundColor = UIColor(Palette.paper)
    return view
  }
  func updateUIView(_ uiView: PDFView, context: Context) {}
}

struct ShareSheet: UIViewControllerRepresentable {
  let url: URL
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [url], applicationActivities: nil)
  }
  func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
