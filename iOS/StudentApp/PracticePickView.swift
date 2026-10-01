import SwiftUI
import UIKit

// T6d-w：推荐页——选这周要练的题。推荐一组默认全勾，「其他可选」默认不勾；
// 至多 8 道，一道没选时「就练这些」不可点。推荐理由原样显示服务器给的 reason。
// 409（题目状态变了）由 LoopStore 显示服务器文案并自动刷新推荐。
// 界面只求可用清楚，不做视觉设计。

struct PracticePickView: View {
  @Environment(LoopStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var slotText = ""
  @State private var submitting = false
  @State private var zoom: PhotoReference?

  private var limitReached: Bool { store.selectedItemIDs.count >= 8 }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        SectionTitle(title: "选这周要练的题", subtitle: "选 5–8 道，打印出来，隔几天在纸上重做。")
        if let error = store.lastError {
          Text(error).font(.subheadline).foregroundStyle(CardTone.red.color)
            .accessibilityIdentifier("pick-error")
        }
        if !store.notes.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            ForEach(store.notes, id: \.self) { note in
              Text(note).font(.subheadline).foregroundStyle(Palette.muted)
            }
          }
          .accessibilityIdentifier("pick-notes")
        }
        if store.recommended.isEmpty, store.others.isEmpty {
          Text("这会儿没有可安排的题，先拍几张错题。")
            .font(.subheadline).foregroundStyle(Palette.muted)
            .accessibilityIdentifier("pick-empty")
        } else {
          group(title: "推荐", items: store.recommended)
          group(title: "其他可选", items: store.others)
        }
      }.padding(24)
    }
    .background(Palette.paper)
    .navigationTitle("选这周要练的题")
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
    .sheet(item: $zoom) { SourcePhotoView(reference: $0) }
    .task {
      await store.loadRecommendation()
      if store.settings == nil { await store.loadSettings() }
      if slotText.isEmpty { slotText = store.settings?.practiceSlot ?? "" }
    }
  }

  // MARK: - 分组与行

  @ViewBuilder private func group(title: String, items: [V2RecommendedItem]) -> some View {
    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Eyebrow(text: title)
        ForEach(items, id: \.id) { item in row(item) }
      }
    }
  }

  private func row(_ item: V2RecommendedItem) -> some View {
    let selected = store.selectedItemIDs.contains(item.id)
    return HStack(alignment: .top, spacing: 12) {
      Button { toggle(item) } label: {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
          .font(.title3)
          .foregroundStyle(selected ? Palette.teal : Palette.muted)
          .frame(width: 44, height: 44)
      }
      .buttonStyle(.plain)
      .disabled(!selected && limitReached)
      .accessibilityIdentifier("pick-toggle-\(item.id)")
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
      .accessibilityIdentifier("pick-thumb-\(item.id)")
      Button { toggle(item) } label: {
        VStack(alignment: .leading, spacing: 4) {
          Text(item.shortId ?? "题目").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
          Text([item.subject, item.knowledgeTags.joined(separator: "、")].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            .font(.caption).foregroundStyle(Palette.muted)
          Text("推荐理由：\(item.reason)").font(.caption).foregroundStyle(Palette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!selected && limitReached)
      .accessibilityIdentifier("pick-row-\(item.id)")
    }
    .padding(12)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(selected ? Palette.teal : Palette.line.opacity(0.5)))
  }

  private func toggle(_ item: V2RecommendedItem) {
    if store.selectedItemIDs.contains(item.id) {
      store.deselectItem(item.id)
    } else {
      store.selectItem(item.id)
    }
  }

  // MARK: - 底部固定条

  private var bottomBar: some View {
    VStack(spacing: 10) {
      if limitReached {
        Text("一次最多 8 道").font(.caption).foregroundStyle(Palette.muted)
          .accessibilityIdentifier("pick-limit")
      }
      HStack(spacing: 12) {
        Text("已选 \(store.selectedItemIDs.count) 道").font(.subheadline).foregroundStyle(Palette.ink)
          .accessibilityIdentifier("pick-count")
        TextField("做题时段", text: $slotText)
          .textFieldStyle(.roundedBorder)
          .frame(minHeight: 44)
          .accessibilityIdentifier("pick-slot")
      }
      Button("就练这些") { create() }
        .buttonStyle(PrimaryButton())
        .disabled(store.selectedItemIDs.isEmpty || submitting)
        .accessibilityIdentifier("create-practice")
      if submitting { ProgressView("正在创建…") }
    }
    .padding(.horizontal, 24).padding(.vertical, 10)
    .background(Palette.card)
    .overlay(Rectangle().fill(Palette.line.opacity(0.5)).frame(height: 1), alignment: .top)
  }

  /// 点一次只发一次请求；成功后回主页（练习卡随之出现）。409 留在本页：LoopStore 已自动刷新推荐。
  private func create() {
    guard !submitting else { return }
    submitting = true
    let slot = slotText.trimmingCharacters(in: .whitespacesAndNewlines)
    Task {
      await store.createPractice(practiceSlot: slot.isEmpty ? nil : slot)
      submitting = false
      if store.currentPractice != nil { dismiss() }
    }
  }
}
