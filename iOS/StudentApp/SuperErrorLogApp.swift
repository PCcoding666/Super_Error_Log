import SwiftUI

@main
struct SuperErrorLogApp: App {
  @State private var store = StudyStore()
  var body: some Scene {
    WindowGroup {
      StudentRootView(store: store)
        .tint(Palette.teal)
    }
  }
}

/// T6c：单一「本周」主页，不再有 Tab。LoopStore 与 StudyStore 都进环境；
/// LoopStore 的客户端随配对变化更新（扫码配对、重新配对、清除配对都跟上），
/// 缓存目录用数据集合目录下的 Loop/（UI 测试的 -test-session 集合各自独立）。
struct StudentRootView: View {
  let store: StudyStore
  @State private var loopStore: LoopStore
  /// 第 1 期：主页路由与「本次打开」的跳过（只在内存里）。
  @State private var homeFlow = HomeFlow()
  @Environment(\.scenePhase) private var phase

  init(store: StudyStore) {
    self.store = store
    _loopStore = State(initialValue: LoopStore(client: nil,
      cacheDirectory: store.persistence.directory.appendingPathComponent("Loop", isDirectory: true)))
  }

  /// 本周数据 + 练习列表与当前练习的回报。第 1 期：「今天」卡要靠练习判断是周末、周中还是做完了，
  /// 不能只等主页底部的练习区出现时才取（第一次配对时那会儿还没有客户端，会一直取不到）。
  private func refreshLoop() async {
    await loopStore.refreshWeek()
    guard store.pairing != nil else { return }
    await loopStore.loadPractices()
    if let id = loopStore.currentPractice?.id { await loopStore.loadSummary(practiceID: id) }
    // 「今天」卡还要知道前几份已生成练习纸的录没录完（周末 B 建了新练习后，上一份就不是当前那份了）。
    // 只放进内存里的回报表，不改当前显示的回报。
    let printed = loopStore.practices.filter { $0.generatedAt != nil && $0.id != loopStore.currentPractice?.id }
    for practice in printed.prefix(2) { await loopStore.refreshSummary(practiceID: practice.id) }
  }

  var body: some View {
    @Bindable var store = store
    Group {
      if store.cannotLoad {
        ContentUnavailableView {
          Label("你的学习内容仍然安全", systemImage: "externaldrive.badge.exclamationmark")
        } description: {
          Text("无法打开已保存的内容。原始文件已经保留，不会被替换。")
        } actions: {
          Button("重试") { store.reload() }
        }
      } else {
        NavigationStack(path: $homeFlow.path) { LoopHomeView() }
      }
    }
    .environment(store)
    .environment(loopStore)
    .environment(homeFlow)
    .task {
      loopStore.updateClient(store.v2Client)
      store.setActive(phase == .active)
      await refreshLoop()
    }
    .onChange(of: store.pairing) { _, _ in
      loopStore.updateClient(store.v2Client)
      // 换客户端后重新取本周数据（扫码配对成功后主页随之出卡片）。
      Task { await refreshLoop() }
    }
    .onChange(of: phase) { _, phase in
      if phase == .active {
        store.loadPairing()
        Task { await loopStore.refreshWeek() }
      }
      store.setActive(phase == .active)
    }
    .alert(
      "没成功",
      isPresented: Binding(
        get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })
    ) {
      Button("知道了") { store.errorMessage = nil }
    } message: {
      Text(store.errorMessage ?? "")
    }
  }
}
