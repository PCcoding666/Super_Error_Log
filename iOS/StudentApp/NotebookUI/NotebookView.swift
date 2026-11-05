import SwiftUI

/// 错题本首页：学科大标题（点开换学科）、网格 / 列表、章节与知识点筛选、搜索、选择移除，
/// 右下角拍照 / 相册。对照 client/src/pages/HomePage.tsx。
struct NotebookView: View {
  @Bindable var model: NotebookModel
  let onPicked: ([Data]) -> Void
  let open: (AppRoute) -> Void

  @AppStorage("sel-notebook-view") private var viewMode = "list"
  @State private var searchText = ""
  @State private var searching = false
  @State private var confirming = false

  var body: some View {
    Group {
      if model.stageRequired {
        StageGateView(model: model)
      } else {
        content
      }
    }
    .onAppear { Task { await model.reload() } }
  }

  private var content: some View {
    ZStack(alignment: .bottomTrailing) {
      Group {
        if viewMode == "grid" { gridBody } else { listBody }
      }
      .refreshable { await model.reload() }
      if model.selecting {
        Button { confirming = true } label: {
          Image(systemName: "trash").font(.title3.weight(.semibold)).foregroundStyle(.white)
            .frame(width: 56, height: 56).background(CardTone.red.color, in: Circle())
            .shadow(color: .black.opacity(0.18), radius: 6, y: 3)
        }
        .disabled(model.selected.isEmpty).opacity(model.selected.isEmpty ? 0.4 : 1)
        .padding(20).accessibilityLabel("移除所选").accessibilityIdentifier("discard-selected")
      } else {
        CaptureControls(style: .fab, onPicked: onPicked).padding(20)
      }
    }
    .overlay(alignment: .bottom) { toastView }
    .navigationTitle(model.selecting ? "已选 \(model.selected.count) 道" : (model.response?.subject ?? "错题本"))
    .navigationBarTitleDisplayMode(.large)
    .toolbarTitleMenu { if !model.selecting { subjectMenu } }
    .toolbar { toolbarContent }
    .searchable(text: $searchText, isPresented: $searching, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "搜索")
    .task(id: searchText) {
      guard searchText != model.query.q else { return }
      try? await Task.sleep(for: .milliseconds(300))
      if !Task.isCancelled { await model.setSearch(searchText) }
    }
    .confirmationDialog("把这 \(model.selected.count) 道移出错题本？", isPresented: $confirming, titleVisibility: .visible) {
      Button("移除", role: .destructive) { Task { await model.discard(Array(model.selected)) } }
      Button("取消", role: .cancel) {}
    } message: { Text("原图保留，移出后可以撤销。") }
    .animation(.default, value: model.toast)
  }

  // MARK: - 工具栏与菜单

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    if model.selecting {
      ToolbarItem(placement: .topBarLeading) { Button("取消") { model.leaveSelecting() }.accessibilityIdentifier("select-cancel") }
      ToolbarItem(placement: .topBarTrailing) {
        Button { model.leaveSelecting() } label: { Image(systemName: "checkmark") }.accessibilityLabel("完成选择")
      }
    } else {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Menu { filterMenu } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
          .accessibilityLabel("视图与筛选").accessibilityIdentifier("notebook-filters")
        Button { open(.settings) } label: { Image(systemName: "gearshape") }
          .accessibilityLabel("设置").accessibilityIdentifier("settings-link")
      }
    }
  }

  @ViewBuilder
  private var subjectMenu: some View {
    ForEach(model.response?.subjects ?? [], id: \.self) { name in
      Button { Task { await model.setSubject(name) } } label: {
        if name == model.response?.subject { Label(name, systemImage: "checkmark") } else { Text(name) }
      }
    }
  }

  @ViewBuilder
  private var filterMenu: some View {
    Picker("视图", selection: $viewMode) {
      Label("网格", systemImage: "square.grid.2x2").tag("grid")
      Label("列表", systemImage: "list.bullet").tag("list")
    }
    Button { model.startSelecting() } label: { Label("选择", systemImage: "checkmark.circle") }
      .disabled(model.items.isEmpty)
    if let response = model.response {
      Divider()
      if response.stages.count > 1 {
        Menu("学段 · \(response.grade)") {
          ForEach(response.stages, id: \.self) { name in
            Button { Task { await model.setStage(name) } } label: {
              if name == response.grade { Label(name, systemImage: "checkmark") } else { Text(name) }
            }
          }
        }
        .accessibilityIdentifier("stage-filter")
      }
      Menu("章节 · \(model.query.chapter.isEmpty ? "全部" : model.query.chapter)") {
        optionButton("全部章节", selected: model.query.chapter.isEmpty) { await model.setChapter("") }
        ForEach(response.chapters, id: \.self) { name in
          optionButton(name, selected: name == model.query.chapter) { await model.setChapter(name) }
        }
      }
      Menu("知识点 · \(model.query.tag.isEmpty ? "全部" : model.query.tag)") {
        optionButton("全部知识点", selected: model.query.tag.isEmpty) { await model.setTag("") }
        ForEach(response.tags, id: \.self) { name in
          optionButton(name, selected: name == model.query.tag) { await model.setTag(name) }
        }
      }
      .disabled(response.tags.isEmpty)
      .accessibilityIdentifier("tag-filter")
    }
  }

  private func optionButton(_ title: String, selected: Bool, action: @escaping () async -> Void) -> some View {
    Button { Task { await action() } } label: {
      if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
    }
  }

  // MARK: - 列表

  private var listBody: some View {
    List {
      headerRows
      if let response = model.response {
        ForEach(response.groups) { group in
          Section(group.title) {
            ForEach(group.items) { item in listRow(item) }
          }
        }
      }
      Color.clear.frame(height: 90).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
    .listStyle(.insetGrouped)
    .scrollDismissesKeyboard(.interactively)
  }

  @ViewBuilder
  private func listRow(_ item: NotebookItem) -> some View {
    let label = VStack(alignment: .leading, spacing: 4) {
      Text(item.chapter).font(.headline).foregroundStyle(.primary)
      Text(item.excerpt.isEmpty ? "题目文字暂不可用，可查看原图。" : item.excerpt)
        .font(.subheadline).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    if model.selecting {
      Button { model.toggle(item.id) } label: {
        HStack(spacing: 12) {
          Image(systemName: model.selected.contains(item.id) ? "checkmark.circle.fill" : "circle")
            .font(.title3).foregroundStyle(model.selected.contains(item.id) ? Palette.teal : .secondary)
          label
        }
      }
      .buttonStyle(.plain).accessibilityIdentifier("item-card")
    } else {
      Button { open(.item(item.id)) } label: {
        HStack { label; Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary) }
      }
      .buttonStyle(.plain).accessibilityIdentifier("item-card")
      .swipeActions(edge: .trailing, allowsFullSwipe: true) {
        Button(role: .destructive) { Task { await model.discard([item.id]) } } label: { Text("移除") }
      }
    }
  }

  // MARK: - 网格（两列瀑布流）

  private var gridBody: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        headerStack
        if let response = model.response {
          ForEach(response.groups) { group in
            VStack(alignment: .leading, spacing: 10) {
              Text(group.title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).padding(.horizontal, 4)
              HStack(alignment: .top, spacing: 12) {
                column(group, parity: 0)
                column(group, parity: 1)
              }
            }
          }
        }
        Color.clear.frame(height: 90)
      }
      .padding(.horizontal, 16)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Color(.systemGroupedBackground))
  }

  private func column(_ group: NotebookGroup, parity: Int) -> some View {
    LazyVStack(spacing: 12) {
      ForEach(Array(group.items.enumerated()).filter { $0.offset % 2 == parity }, id: \.element.id) { _, item in card(item, groupKey: group.key) }
    }
  }

  private func card(_ item: NotebookItem, groupKey: String) -> some View {
    let picked = model.selected.contains(item.id)
    return Button {
      if model.selecting { model.toggle(item.id) } else { open(.item(item.id)) }
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        if groupKey != "today" {
          Text(Self.dateLabel(item.intakeDay, groupKey: groupKey)).font(.caption2).foregroundStyle(.secondary)
        }
        RemoteImage(path: item.thumb, maxPixel: 600).clipShape(RoundedRectangle(cornerRadius: 8))
        Text(item.chapter).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
        if !item.excerpt.isEmpty {
          Text(item.excerpt).font(.caption).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
        }
      }
      .padding(10).frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
      .overlay(alignment: .topTrailing) {
        if model.selecting {
          Image(systemName: picked ? "checkmark.circle.fill" : "circle").font(.title3)
            .foregroundStyle(picked ? Palette.teal : .secondary).padding(8)
        }
      }
      .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(picked ? Palette.teal : .clear, lineWidth: 2))
    }
    .buttonStyle(.plain).accessibilityIdentifier("item-card")
  }

  static func dateLabel(_ day: String?, groupKey: String) -> String {
    if groupKey == "today" { return "今天" }
    guard let day, day.count == 10 else { return "" }
    let parts = day.split(separator: "-")
    guard parts.count == 3, let month = Int(parts[1]), let date = Int(parts[2]) else { return "" }
    return "\(month)/\(date)"
  }

  // MARK: - 头部、提示、空状态

  @ViewBuilder
  private var headerRows: some View {
    if !model.selecting, let response = model.response {
      Text(model.subtitle).font(.subheadline).foregroundStyle(.secondary)
        .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
        .accessibilityIdentifier("notebook-subtitle")
        .padding(.horizontal, 4)
      intakeHint(response)
    }
    problemView
    emptyView
  }

  @ViewBuilder
  private var headerStack: some View {
    if !model.selecting, let response = model.response {
      Text(model.subtitle).font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 4)
        .accessibilityIdentifier("notebook-subtitle")
      intakeHint(response)
    }
    problemView
    emptyView
  }

  @ViewBuilder
  private func intakeHint(_ response: NotebookResponse) -> some View {
    if response.finding > 0 || response.pendingIntake > 0 {
      Button { open(.intake) } label: {
        HStack {
          Text(response.finding > 0 ? "AI 正在找题（\(response.finding) 张照片）" : "照片里还有 \(response.pendingIntake) 道没收进错题本")
            .font(.subheadline)
          Spacer()
          Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(12).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
      }
      .buttonStyle(.plain).accessibilityIdentifier("intake-hint")
    }
  }

  @ViewBuilder
  private var problemView: some View {
    if let problem = model.problem {
      VStack(spacing: 8) {
        Text(problem.message).font(.subheadline).foregroundStyle(CardTone.red.color).multilineTextAlignment(.center)
        Button("再试一次") { Task { await model.reload() } }
      }
      .frame(maxWidth: .infinity).padding(.vertical, 12).containerIdentifier("notebook-problem")
    }
  }

  @ViewBuilder
  private var emptyView: some View {
    if let response = model.response, model.items.isEmpty, !model.isLoading {
      VStack(spacing: 10) {
        Image(systemName: "camera").font(.system(size: 36)).foregroundStyle(.secondary)
        Text(response.total > 0 ? "没有符合筛选的题" : "拍一张批改过的卷子").font(.headline)
        Text(response.total > 0 ? "换个章节或状态试试。" : "AI 会找出错题，放进这里。相册可以一次选多张。")
          .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        if response.total > 0 {
          Button("清除筛选") { Task { await model.clearFilters(); searchText = "" } }
        } else {
          CaptureControls(style: .empty, onPicked: onPicked).padding(.top, 8)
        }
      }
      .frame(maxWidth: .infinity).padding(.vertical, 40)
      .listRowBackground(Color.clear).containerIdentifier("empty-notebook")
    }
  }

  // MARK: - 提示条

  @ViewBuilder
  private var toastView: some View {
    if let toast = model.toast {
      HStack(spacing: 16) {
        Text(toast.message).font(.subheadline)
        if let undo = toast.undo {
          Button("撤销") { Task { await model.undo(undo) } }.font(.subheadline.weight(.semibold)).accessibilityIdentifier("toast-undo")
        }
      }
      .foregroundStyle(.white).padding(.horizontal, 18).padding(.vertical, 12)
      .background(Color.black.opacity(0.82), in: Capsule())
      .padding(.bottom, 24)
      .transition(.move(edge: .bottom).combined(with: .opacity))
      .task(id: toast.id) {
        try? await Task.sleep(for: .seconds(6))
        if !Task.isCancelled, model.toast?.id == toast.id { model.toast = nil }
      }
    }
  }
}

/// 新账号第一次用：先选初中或高中（服务器在选好之前对所有接口回 409 stage_required）。
struct StageGateView: View {
  let model: NotebookModel
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    VStack(spacing: 18) {
      Spacer()
      Text("你在读哪个学段？").font(.title.bold())
      Text("新收录的题默认用这个学段，以后可以在设置里改。").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
      VStack(spacing: 12) {
        ForEach(["初中", "高中"], id: \.self) { grade in
          Button { Task { await choose(grade) } } label: { Text(grade).frame(maxWidth: .infinity).padding(.vertical, 6) }
            .buttonStyle(.borderedProminent).controlSize(.large).tint(grade == "初中" ? Palette.teal : Palette.muted)
            .disabled(busy).accessibilityIdentifier("stage-\(grade)")
        }
      }
      .padding(.top, 8)
      if let error { Text(error).font(.footnote).foregroundStyle(CardTone.red.color) }
      Spacer()
    }
    .padding(32).containerIdentifier("stage-gate")
  }

  private func choose(_ grade: String) async {
    busy = true
    error = nil
    defer { busy = false }
    error = await model.chooseStage(grade)
  }
}
