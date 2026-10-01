import SwiftUI
import UIKit

// T6d-w：练习详情——按 position 列出每道题（裁图缩略、短编号、知识点、推荐理由、是否已复盘），
// 每题一个复盘入口进入追问复盘页。界面只求可用清楚，不做视觉设计。

struct PracticeDetailView: View {
  let practiceID: String
  @Environment(LoopStore.self) private var store
  @State private var reflectTarget: String?
  @State private var zoom: PhotoReference?

  private var practice: V2PracticeDetail? {
    store.currentPractice?.id == practiceID ? store.currentPractice : nil
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        Text("复盘不是必须的，但做了之后回来能看到你当时的判断准不准。")
          .font(.subheadline).foregroundStyle(Palette.muted)
        if let practice {
          ForEach(practice.items.sorted(by: { $0.position < $1.position }), id: \.id) { item in
            row(item)
          }
        } else if let error = store.lastError {
          Text(error).font(.subheadline).foregroundStyle(CardTone.red.color)
        } else {
          ProgressView("正在读取练习…").accessibilityIdentifier("practice-detail-loading")
        }
      }.padding(24)
    }
    .background(Palette.paper)
    .navigationTitle("本周练习")
    .navigationBarTitleDisplayMode(.inline)
    .navigationDestination(item: $reflectTarget) { FollowupView(itemID: $0) }
    .sheet(item: $zoom) { SourcePhotoView(reference: $0) }
    .task {
      if store.currentPractice?.id != practiceID {
        await store.openPractice(id: practiceID)
      }
    }
  }

  private func row(_ item: V2PracticeItem) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 12) {
        Button {
          Task {
            if let url = await store.cropFileURL(itemID: item.id) {
              zoom = PhotoReference(url: url, title: item.shortId ?? "题目", role: .crop)
            }
          }
        } label: {
          CropThumbnail(itemID: item.id).frame(width: 62, height: 76).clipped()
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("practice-detail-thumb-\(item.id)")
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Text(item.shortId ?? "题目").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
            Text(item.reflected ? "已复盘" : "还没复盘")
              .font(.caption2.weight(.medium))
              .foregroundStyle(item.reflected ? CardTone.green.color : CardTone.orange.color)
          }
          Text([item.subject, item.knowledgeTags.joined(separator: "、")].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            .font(.caption).foregroundStyle(Palette.muted)
          Text("推荐理由：\(item.reason)").font(.caption).foregroundStyle(Palette.muted)
        }
        Spacer(minLength: 0)
      }
      Button(item.reflected ? "再看一下" : "复盘这道") { reflectTarget = item.id }
        .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
        .foregroundStyle(Palette.teal)
        .accessibilityIdentifier("reflect-\(item.id)")
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.line.opacity(0.5)))
  }
}
