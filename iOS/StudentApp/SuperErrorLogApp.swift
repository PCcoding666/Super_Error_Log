import SwiftUI

@main
struct SuperErrorLogApp: App {
  @State private var store = StudyStore()
  var body: some Scene {
    WindowGroup {
      StudentRootView().environment(store)
        .tint(Palette.teal)
    }
  }
}

struct StudentRootView: View {
  @Environment(StudyStore.self) private var store
  @Environment(\.scenePhase) private var phase
  @State private var tab = 0

  var body: some View {
    @Bindable var store = store
    Group {
      if store.cannotLoad {
        ContentUnavailableView {
          Label("你的学习内容仍然安全", systemImage: "externaldrive.badge.exclamationmark")
        } description: {
          Text(
            "无法打开已保存的内容。原始文件已经保留，不会被替换。"
          )
        } actions: {
          Button("重试") { store.reload() }
        }
      } else {
        TabView(selection: $tab) {
          NavigationStack { ThisWeekView(tab: $tab) }
            .tabItem { Label("本周", systemImage: "square.grid.2x2") }.tag(0)
          NavigationStack { ReflectionListView(tab: $tab) }
            .tabItem { Label("复盘", systemImage: "bubble.left.and.text.bubble.right") }.tag(1)
          NavigationStack { ReviewPackView() }
            .tabItem { Label("练习包", systemImage: "doc.text") }.tag(2)
        }
      }
    }
    .task { store.setActive(phase == .active) }
    .onChange(of: phase) { _, phase in
      if phase == .active { store.loadPairing() }
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
