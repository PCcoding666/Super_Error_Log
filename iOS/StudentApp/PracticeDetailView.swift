import SwiftUI
import UIKit

// T6d-w：练习详情——按 position 列出每道题（裁图缩略、短编号、知识点、推荐理由、是否已复盘），
// 每题一个「说说这道为什么错」入口进入 AI 问你一句的页面。界面只求可用清楚，不做视觉设计。

struct PracticeDetailView: View {
  let practiceID: String
  @Environment(LoopStore.self) private var store
  @Environment(HomeFlow.self) private var flow
  @State private var zoom: PhotoReference?

  private var practice: V2PracticeDetail? {
    store.currentPractice?.id == practiceID ? store.currentPractice : nil
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        Text("每道题 AI 问你一句，你说一句就行。说出来，下次更容易发现自己是哪里想错了。不想说可以跳过，不影响打印。")
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
    .navigationTitle("说说为什么错")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(item: $zoom) { SourcePhotoView(reference: $0) }
    .task {
      if store.currentPractice?.id != practiceID {
        await store.openPractice(id: practiceID)
      }
    }
  }

  private func row(_ item: V2PracticeItem) -> some View {
    // 与主页错题卡片一致的版式：裁图置顶占满宽度（≤72pt、等比居左），
    // 下面依次短编号与复盘状态、学科·知识点、题干文字摘要、推荐理由、复盘按钮。
    VStack(alignment: .leading, spacing: 8) {
      Button {
        Task {
          // 点裁图看整题大图；旧服务器/离线取不到整题大图时退回题干小图。
          var url = await store.cropFileURL(itemID: item.id, scope: .full)
          if url == nil { url = await store.cropFileURL(itemID: item.id) }
          if let url {
            zoom = PhotoReference(url: url, title: item.shortId ?? "题目", role: .crop)
          }
        }
      } label: {
        CropThumbnail(itemID: item.id)
          .frame(maxWidth: .infinity, maxHeight: 72, alignment: .leading)
          .clipped()
          .accessibilityHidden(true)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("practice-detail-thumb-\(item.id)")
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(item.shortId ?? "题目").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
          Text(item.reflected ? "说过了" : "还没说为什么错")
            .font(.caption2.weight(.medium))
            .foregroundStyle(item.reflected ? CardTone.green.color : CardTone.orange.color)
        }
        Text([item.subject, item.knowledgeTags.joined(separator: "、")].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
          .font(.caption).foregroundStyle(Palette.muted)
        if let excerpt = item.questionExcerpt, !excerpt.isEmpty {
          Text(excerpt).font(.caption).foregroundStyle(Palette.ink).lineLimit(2)
        }
        Text("为什么选它：\(item.reason)").font(.caption).foregroundStyle(Palette.muted)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Button(item.reflected ? "再看一下" : "说说这道为什么错") {
        // 第 1 期：路由在主页的导航栈上（HomeFlow），说完一道可以直接换到下一道。
        flow.push(.followup(practiceID: practiceID, itemID: item.id))
      }
        .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
        .foregroundStyle(Palette.teal)
        .accessibilityIdentifier("reflect-\(item.id)")
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.line.opacity(0.5)))
  }
}
