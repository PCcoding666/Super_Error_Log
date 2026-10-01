import PDFKit
import SwiftUI
import UIKit

// T6e-w：打印练习纸页（task-6ew-brief §2）。PracticePrintView(practiceID:) 独立进入，
// 从环境取 LoopStore。进入即请求打印内容并轮询（LoopStore 内部状态机），离开页面取消轮询、
// 再进来继续；失败显示服务器文案 + 再试一次；就绪且图片到齐后生成 PDF、预览、系统分享。
// 界面只求可用清楚，不做视觉设计。

/// 打印前"看一眼"的弹出图（快照里的本地图片文件）。
private struct GlancePhoto: Identifiable {
  let id = UUID()
  let url: URL
  let title: String
}

struct PracticePrintView: View {
  let practiceID: String
  @Environment(LoopStore.self) private var store
  @State private var pdfURL: URL?
  @State private var isRendering = false
  @State private var renderFailed = false
  @State private var glancePhoto: GlancePhoto?

  var body: some View {
    // T6d-w：从主页导航栈推入，去掉内层 NavigationStack。
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        SectionTitle(title: "打印练习纸", subtitle: "生成一份 A4 练习纸，预览后用系统分享打印或发给家里的打印机。")
        content
      }.padding(24)
    }
    .background(Palette.paper)
    .navigationTitle("打印练习纸")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear(perform: prime)
    .onDisappear(perform: cleanup)
    .onChange(of: store.printPhase) { _, phase in
      if case .ready(let snapshot) = phase { renderPDF(snapshot: snapshot) }
    }
    .sheet(item: $glancePhoto) { photo in
      SourcePhotoView(reference: PhotoReference(url: photo.url, title: photo.title, role: .crop))
    }
  }

  // MARK: - 状态内容

  @ViewBuilder private var content: some View {
    switch store.printPhase {
    case .none:
      preparingCard(progress: nil)
    case .preparing(let progress):
      preparingCard(progress: progress)
    case .failed(let message):
      PaperCard {
        VStack(alignment: .leading, spacing: 12) {
          Text(message).font(.body).foregroundStyle(Palette.ink)
          retryButton
        }
      }
    case .ready(let snapshot):
      glanceCard(snapshot: snapshot)
      pdfSection(snapshot: snapshot)
    }
  }

  private func preparingCard(progress: V2PrintProgress?) -> some View {
    PaperCard {
      VStack(alignment: .leading, spacing: 12) {
        ProgressView()
          .accessibilityIdentifier("print-preparing")
        if let progress {
          Text("正在准备第 \(progress.done)/\(progress.total) 道…").font(.body).foregroundStyle(Palette.ink)
        } else {
          Text("正在准备打印内容…").font(.body).foregroundStyle(Palette.ink)
        }
        Text("可能要一两分钟。可以先离开，回来接着准备。").font(.subheadline).foregroundStyle(Palette.muted)
        if let error = store.lastError, !store.isBusyPrint {
          Text(error).font(.subheadline).foregroundStyle(CardTone.red.color)
          retryButton
        }
      }
    }
  }

  private var retryButton: some View {
    Button("再试一次") { Task { await store.requestPrint(practiceID: practiceID) } }
      .buttonStyle(PrimaryButton())
      .disabled(store.isBusyPrint)
      .accessibilityIdentifier("print-retry")
  }

  /// needsGlance 提醒列表：打印前看一眼这几道在练习纸上的图。
  @ViewBuilder private func glanceCard(snapshot: V2PrintSnapshot) -> some View {
    let items = snapshot.items.filter(\.needsGlance)
    if !items.isEmpty {
      PaperCard {
        VStack(alignment: .leading, spacing: 12) {
          // T6j：标题保持中性，每行显示服务器给的具体原因。
          Text("打印前看一眼这几道").font(.headline).foregroundStyle(Palette.ink)
          ForEach(items, id: \.itemId) { item in
            Button {
              if let name = item.cropMedia ?? item.diagramMedia.first {
                glancePhoto = GlancePhoto(
                  url: store.printMediaURL(packetID: practiceID, name: name),
                  title: item.shortId ?? "第 \(item.position + 1) 题")
              }
            } label: {
              HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                  Text(item.shortId ?? "第 \(item.position + 1) 题").font(.body.weight(.medium)).foregroundStyle(Palette.ink)
                  if let reason = item.glanceReason {
                    Text(reason).font(.caption).foregroundStyle(Palette.muted).multilineTextAlignment(.leading)
                  }
                }
                Spacer(minLength: 0)
                Image(systemName: "photo").foregroundStyle(Palette.teal)
              }
              .padding(.vertical, 12).frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("print-glance-\(item.itemId)")
          }
        }
      }
    }
  }

  // MARK: - PDF 生成、预览、分享

  @ViewBuilder private func pdfSection(snapshot: V2PrintSnapshot) -> some View {
    if let pdfURL {
      PaperCard {
        VStack(alignment: .leading, spacing: 12) {
          PracticePDFPreview(url: pdfURL)
            .frame(maxWidth: .infinity).frame(height: 480)
            .accessibilityIdentifier("print-preview")
          ShareLink(item: pdfURL) {
            Label("打印 / 分享", systemImage: "printer")
          }
          .buttonStyle(PrimaryButton())
          .accessibilityIdentifier("print-share")
        }
      }
    } else if renderFailed {
      PaperCard {
        VStack(alignment: .leading, spacing: 12) {
          Text("这份练习纸排版失败，请再试一次。").font(.body).foregroundStyle(Palette.ink)
          Button("再试一次") { renderPDF(snapshot: snapshot) }
            .buttonStyle(PrimaryButton())
            .disabled(isRendering)
            .accessibilityIdentifier("print-render-retry")
        }
      }
    } else {
      PaperCard {
        ProgressView("正在排版…").accessibilityIdentifier("print-rendering")
      }
    }
  }

  /// 生成 PDF 到应用临时目录（文件名"本周练习-<周>.pdf"），文件保护完整；离开页面时删除。
  private func renderPDF(snapshot: V2PrintSnapshot) {
    guard pdfURL == nil, !isRendering else { return }
    isRendering = true
    renderFailed = false
    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("本周练习-\(snapshot.week).pdf")
    Task {
      do {
        try PracticePDF.render(snapshot: snapshot, mediaURL: { name in
          store.printMediaURL(packetID: practiceID, name: name)
        }, to: outputURL)
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.complete], ofItemAtPath: outputURL.path)
        pdfURL = outputURL
      } catch {
        renderFailed = true
      }
      isRendering = false
    }
  }

  // MARK: - 进入 / 离开

  /// 进入：none → 请求打印；preparing → 接着轮询；ready → 直接排版；failed → 等学生点再试一次。
  private func prime() {
    switch store.printPhase {
    case .none:
      Task { await store.requestPrint(practiceID: practiceID) }
    case .preparing:
      Task { await store.pollPrint(practiceID: practiceID) }
    case .ready(let snapshot):
      renderPDF(snapshot: snapshot)
    case .failed:
      break
    }
  }

  /// 离开：取消轮询（再进来会继续），删掉临时 PDF。
  private func cleanup() {
    store.cancelPrint()
    if let pdfURL {
      try? FileManager.default.removeItem(at: pdfURL)
    }
  }
}

/// PDFKit 预览（只读）。
private struct PracticePDFPreview: UIViewRepresentable {
  let url: URL
  func makeUIView(context: Context) -> PDFView {
    let view = PDFView()
    view.autoScales = true
    view.document = PDFDocument(url: url)
    return view
  }
  func updateUIView(_ uiView: PDFView, context: Context) {
    if uiView.document?.documentURL != url {
      uiView.document = PDFDocument(url: url)
    }
  }
}
