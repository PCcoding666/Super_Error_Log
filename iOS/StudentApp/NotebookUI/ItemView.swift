import SwiftUI

/// 题目详情：整张上传照片（点开是应用内大图）、题干、你写的、章节与知识点；右上角「…」里是修改分类、移除。
/// 对照 client/src/pages/ItemPage.tsx。
struct ItemView: View {
  @State private var model: ItemModel
  let removed: () -> Void
  @State private var viewing: ItemImage?
  @State private var openNote: ItemNote?
  @State private var editing = false
  @State private var draft: ItemModel.CategoryDraft?
  @State private var confirmingRemove = false

  init(itemID: String, api: any WebAPI, removed: @escaping () -> Void) {
    _model = State(initialValue: ItemModel(itemID: itemID, api: api))
    self.removed = removed
  }

  var body: some View {
    List {
      if let error = model.error {
        VStack(spacing: 8) {
          Text(error.message).font(.subheadline).foregroundStyle(CardTone.red.color)
          Button("再试一次") { Task { await model.reload() } }
        }
        .frame(maxWidth: .infinity).listRowBackground(Color.clear)
      }
      if let detail = model.detail { detailRows(detail) }
    }
    .listStyle(.insetGrouped)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("修改分类") { startEditing() }.disabled(model.detail == nil)
          if model.detail?.canDiscard == true {
            Button("不是错题，移除", role: .destructive) { confirmingRemove = true }
          }
        } label: { Image(systemName: "ellipsis") }
          .accessibilityLabel("更多").accessibilityIdentifier("item-more")
      }
    }
    .task { await model.reload() }
    .refreshable { await model.reload() }
    .fullScreenCover(item: $viewing) { PhotoViewer(title: $0.title, path: $0.fullUrl) }
    .sheet(item: $openNote) { note in
      NavigationStack {
        ScrollView { Text(note.text).font(.body).frame(maxWidth: .infinity, alignment: .leading).padding() }
          .navigationTitle(note.title).navigationBarTitleDisplayMode(.inline)
          .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { openNote = nil } } }
      }
      .presentationDetents([.medium, .large])
    }
    .sheet(isPresented: $editing) { categorySheet }
    .confirmationDialog("把这道题移出错题本？", isPresented: $confirmingRemove, titleVisibility: .visible) {
      Button("移除", role: .destructive) { Task { if await model.discard() { removed() } } }
      Button("取消", role: .cancel) {}
    } message: { Text("原图保留，移出后可以在错题本撤销。") }
    .overlay(alignment: .bottom) {
      if let toast = model.toast {
        Text(toast).font(.subheadline).foregroundStyle(.white).padding(.horizontal, 18).padding(.vertical, 12)
          .background(Color.black.opacity(0.82), in: Capsule()).padding(.bottom, 24)
          .task(id: toast) { try? await Task.sleep(for: .seconds(3)); if model.toast == toast { model.toast = nil } }
      }
    }
    .animation(.default, value: model.toast)
  }

  @ViewBuilder
  private func detailRows(_ detail: ItemDetailResponse) -> some View {
    let item = detail.item
    VStack(alignment: .leading, spacing: 4) {
      Text(item.chapter).font(.title2.bold())
      Text([item.shortId, item.grade, item.subject].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        .font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("item-category")
    }
    .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 4, trailing: 4))
    Section {
      ForEach(detail.images) { image in
        Button { viewing = image } label: { RemoteImage(path: image.url, maxPixel: 1400) }
          .buttonStyle(.plain).accessibilityLabel("\(image.title)，查看大图").accessibilityIdentifier("item-photo")
          .listRowInsets(EdgeInsets())
      }
      if detail.images.contains(where: { $0.title == "原图" }) {
        Text("这是你拍的整张照片，点开可以放大。").font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("item-photo-note")
      }
    }
    Section {
      StemView(text: detail.questionText.isEmpty ? "还没有可读的识别文字，请打开上方原图查看。" : detail.questionText)
        .accessibilityIdentifier("question-text")
      if detail.badge == "low" {
        Text("字可能认错了，以照片为准。").font(.footnote).foregroundStyle(CardTone.orange.color)
      }
    }
    Section {
      ForEach(detail.notes) { note in
        Button { openNote = note } label: {
          HStack { Text(note.title).foregroundStyle(.primary); Spacer(); Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary) }
        }
      }
      Button { startEditing() } label: {
        HStack {
          Text("章节").foregroundStyle(.primary); Spacer()
          Text(detail.category.chapter).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
          Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
      }
      .accessibilityIdentifier("item-chapter")
      HStack {
        Text("知识点"); Spacer()
        Text(item.knowledgeTags.isEmpty ? "—" : item.knowledgeTags.joined(separator: "、")).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
      }
      .accessibilityIdentifier("item-tags")
    }
    if detail.canDiscard {
      Section {
        Button("不是错题，移除", role: .destructive) { confirmingRemove = true }
          .frame(maxWidth: .infinity).accessibilityIdentifier("discard")
      }
    }
  }

  // MARK: - 修改分类

  private func startEditing() {
    draft = model.draft
    editing = draft != nil
  }

  @ViewBuilder
  private var categorySheet: some View {
    if let detail = model.detail, let current = draft {
      let chapters = model.chapters(for: current)
      NavigationStack {
        Form {
          Picker("学段", selection: Binding(get: { current.grade }, set: { draft = model.retarget(current, grade: $0) })) {
            ForEach(detail.category.stages, id: \.self) { Text($0).tag($0) }
          }
          Picker("学科", selection: Binding(get: { current.subject }, set: { draft = model.retarget(current, subject: $0) })) {
            ForEach(detail.category.subjects, id: \.self) { Text($0).tag($0) }
          }
          // 章节：从现有章节里选（候选随学段、学科变），或者自己填；保存时以输入框为准。
          Picker("从现有章节选", selection: Binding(
            get: { chapters.contains(current.chapter) ? current.chapter : "" },
            set: { if !$0.isEmpty { draft?.chapter = $0 } })) {
            Text(chapters.isEmpty ? "这个学科还没有章节" : "选一个").tag("")
            ForEach(chapters, id: \.self) { Text($0).tag($0) }
          }
          .disabled(chapters.isEmpty).accessibilityIdentifier("chapter-picker")
          HStack {
            Text("章节")
            TextField("也可以自己填", text: Binding(get: { current.chapter }, set: { draft?.chapter = String($0.prefix(100)) }))
              .multilineTextAlignment(.trailing)
          }
          if !detail.item.knowledgeTags.isEmpty {
            Text("知识点（AI 识别）：\(detail.item.knowledgeTags.joined(separator: "、"))").font(.footnote).foregroundStyle(.secondary)
          }
        }
        .navigationTitle("修改分类").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("取消") { editing = false } }
          ToolbarItem(placement: .topBarTrailing) {
            Button("保存") { Task { if await model.save(current) { editing = false } } }.bold().accessibilityIdentifier("category-save")
          }
        }
      }
    }
  }
}

/// 题干：普通文字保留换行，GFM 表格画成真表格（窄屏可横向滑动）。
struct StemView: View {
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(StemBlocks.parse(text).enumerated()), id: \.offset) { _, block in
        switch block {
        case .text(let value):
          Text(value).font(.body).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        case .table(let head, let align, let rows):
          ScrollView(.horizontal, showsIndicators: false) { table(head: head, align: align, rows: rows) }
        }
      }
    }
  }

  private func alignment(_ value: StemAlign?) -> Alignment {
    switch value { case .center: .center; case .right: .trailing; default: .leading }
  }

  private func table(head: [String], align: [StemAlign?], rows: [[String]]) -> some View {
    Grid(horizontalSpacing: 0, verticalSpacing: 0) {
      GridRow {
        ForEach(Array(head.enumerated()), id: \.offset) { column, cell in
          Text(cell).font(.subheadline.weight(.semibold)).padding(8)
            .frame(minWidth: 56, alignment: alignment(align[column])).background(Color(.tertiarySystemFill))
            .overlay(Rectangle().stroke(Color(.separator), lineWidth: 0.5))
        }
      }
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        GridRow {
          ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
            Text(cell).font(.subheadline).padding(8)
              .frame(minWidth: 56, alignment: alignment(align[column]))
              .overlay(Rectangle().stroke(Color(.separator), lineWidth: 0.5))
          }
        }
      }
    }
    .accessibilityIdentifier("stem-table")
  }
}
