import SwiftUI

/// 已登录后的四屏：错题本（根）、录入、题目详情、设置。和网页版 client/src/App.tsx 的路由一一对应。
enum AppRoute: Hashable {
  case intake
  case item(String)
  case settings
}

struct StudentRootView: View {
  @State private var account = AccountSession()

  var body: some View {
    Group {
      if let api = account.api {
        SignedInView(account: account, api: api)
          // 换账号 / 重新登录后整棵树重建，不带上一个账号的数据。
          .id(account.configuration?.token ?? "")
      } else {
        LoginView(account: account)
      }
    }
    .environment(account)
    .tint(Palette.teal)
  }
}

private struct SignedInView: View {
  let account: AccountSession
  let api: any WebAPI
  @State private var path: [AppRoute] = []
  @State private var notebook: NotebookModel
  @State private var images: ImageStore
  @Environment(\.scenePhase) private var phase

  init(account: AccountSession, api: any WebAPI) {
    self.account = account
    self.api = api
    _notebook = State(initialValue: NotebookModel(api: api))
    _images = State(initialValue: ImageStore(api: api))
  }

  var body: some View {
    NavigationStack(path: $path) {
      NotebookView(
        model: notebook,
        onPicked: picked,
        open: { path.append($0) })
        .navigationDestination(for: AppRoute.self) { route in
          switch route {
          case .intake:
            IntakeView(api: api, uploads: account.uploads, onPicked: picked, openItem: { path.append(.item($0)) }, done: { path.removeAll() })
          case .item(let id):
            ItemView(itemID: id, api: api, removed: { if !path.isEmpty { path.removeLast() } })
          case .settings:
            SettingsView(api: api, account: account)
          }
        }
    }
    .environment(\.imageStore, images)
    #if DEBUG
    // 走查 / UI 测试：`-inject-photo <文件>` 相当于从相册选了这一张（模拟器里没法操作系统相册选择器）。
    .task {
      let arguments = ProcessInfo.processInfo.arguments
      if let index = arguments.firstIndex(of: "-inject-photo"), arguments.indices.contains(index + 1),
        let data = FileManager.default.contents(atPath: arguments[index + 1]) { picked([data]) }
    }
    #endif
    .onChange(of: phase) { _, phase in
      // 回到前台时刷新错题本（网页版切回页面也会重新取）。
      if phase == .active { Task { await notebook.reload() } }
    }
  }

  /// 选好 / 拍好的照片进上传队列，并停在录入页看进度。
  private func picked(_ photos: [Data]) {
    account.uploads.add(photos)
    if path.last != .intake { path.append(.intake) }
  }
}
