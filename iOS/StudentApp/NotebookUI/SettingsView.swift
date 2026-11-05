import SwiftUI

/// 设置：学段、账号、版本。对照 client/src/pages/SettingsPage.tsx。
struct SettingsView: View {
  @State private var model: SettingsModel
  let account: AccountSession
  @State private var confirmingLogout = false

  init(api: any WebAPI, account: AccountSession) {
    _model = State(initialValue: SettingsModel(api: api))
    self.account = account
  }

  private var appVersion: String {
    let info = Bundle.main.infoDictionary
    return [info?["CFBundleShortVersionString"] as? String, info?["CFBundleVersion"] as? String].compactMap { $0 }.joined(separator: " (") + ")"
  }

  var body: some View {
    Form {
      if let error = model.error {
        Section {
          Text(error.message).font(.subheadline).foregroundStyle(CardTone.red.color)
          Button("再试一次") { Task { await model.reload() } }
        }
      }
      if let data = model.data {
        Section("学习") {
          Picker("学段", selection: Binding(get: { data.grade }, set: { grade in Task { await model.setGrade(grade) } })) {
            ForEach(data.stages, id: \.self) { Text($0).tag($0) }
          }
          .accessibilityIdentifier("student-grade")
          HStack { Text("练习"); Spacer(); Text("即将推出").foregroundStyle(.secondary) }
        }
        Section("应用") {
          HStack { Text("服务"); Spacer(); Text("已连接").foregroundStyle(CardTone.green.color).accessibilityIdentifier("connection-ok") }
        }
        if data.invitation {
          Section("账号") {
            if let label = data.accountRoleLabel {
              HStack { Text("身份"); Spacer(); Text(label).foregroundStyle(.secondary).accessibilityIdentifier("account-role") }
            }
            if data.inviteExpiresSoon() {
              Label("邀请码快到期了，请在网页版「我的邀请码」里换新码。", systemImage: "exclamationmark.circle")
                .font(.footnote).foregroundStyle(CardTone.orange.color)
            }
            Button("退出登录", role: .destructive) { confirmingLogout = true }.accessibilityIdentifier("logout")
          }
        }
        Section { EmptyView() } footer: {
          Text("超级错题本 \(appVersion) · 服务 \(data.version)").frame(maxWidth: .infinity).multilineTextAlignment(.center)
        }
      }
    }
    .navigationTitle("设置")
    .navigationBarTitleDisplayMode(.large)
    .task { await model.reload() }
    .confirmationDialog("退出登录？", isPresented: $confirmingLogout, titleVisibility: .visible) {
      Button("退出登录", role: .destructive) { Task { await account.logout() } }
      Button("取消", role: .cancel) {}
    } message: { Text("错题都记在服务器上，重新输入邀请码就能看到。") }
    .overlay(alignment: .bottom) {
      if let toast = model.toast {
        Text(toast).font(.subheadline).foregroundStyle(.white).padding(.horizontal, 18).padding(.vertical, 12)
          .background(Color.black.opacity(0.82), in: Capsule()).padding(.bottom, 24)
          .task(id: toast) { try? await Task.sleep(for: .seconds(2.5)); if model.toast == toast { model.toast = nil } }
      }
    }
    .animation(.default, value: model.toast)
  }
}
