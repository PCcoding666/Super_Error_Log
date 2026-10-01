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
  @Environment(\.scenePhase) private var phase

  init(store: StudyStore) {
    self.store = store
    _loopStore = State(initialValue: LoopStore(client: nil,
      cacheDirectory: store.persistence.directory.appendingPathComponent("Loop", isDirectory: true)))
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
        NavigationStack { LoopHomeView() }
      }
    }
    .environment(store)
    .environment(loopStore)
    .task {
      loopStore.updateClient(store.v2Client)
      store.setActive(phase == .active)
      await loopStore.refreshWeek()
    }
    .onChange(of: store.pairing) { _, _ in
      loopStore.updateClient(store.v2Client)
      // 换客户端后重新取本周数据（扫码配对成功后主页随之出卡片）。
      Task { await loopStore.refreshWeek() }
    }
    .onChange(of: phase) { _, phase in
      if phase == .active {
        store.loadPairing()
        Task { await loopStore.refreshWeek() }
      }
      store.setActive(phase == .active)
    }
    .alert(
      "请再试一次",
      isPresented: Binding(
        get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })
    ) {
      Button("知道了") { store.errorMessage = nil }
    } message: {
      Text(store.errorMessage ?? "")
    }
  }
}
