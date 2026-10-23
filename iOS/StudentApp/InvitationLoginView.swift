import SwiftUI

/// 邀请码登录页（2026-10-23）：学生输入老师/家长给的 12 位邀请码，与手机网页版同一个账号。
/// 旧的扫码配对保留为次要入口（没有邀请码的老部署、开发调试）。
struct InvitationLoginView: View {
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var code = ""
  @State private var host = CloudPairing.domainHost
  @State private var busy = false
  @State private var showScanner = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("XXXX-XXXX-XXXX", text: $code)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .font(.title3.monospaced())
            .accessibilityIdentifier("invite-code")
          Text("和手机网页版用同一个邀请码。登录后错题、练习、复盘都记在服务器上，换手机也不丢。")
            .font(.caption).foregroundStyle(Palette.muted)
        } header: {
          Text("输入邀请码")
        }
        Section("服务器入口") {
          Picker("入口", selection: $host) {
            Text("域名").tag(CloudPairing.domainHost)
            Text("IP 直连").tag(CloudPairing.ipHost)
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("invite-host")
          Text("平时用域名；域名打不开再试 IP 直连。").font(.caption).foregroundStyle(Palette.muted)
        }
        Section {
          Button {
            Task { await login() }
          } label: {
            HStack(spacing: 8) {
              if busy { ProgressView() }
              Text(busy ? "正在登录…" : "登录").frame(maxWidth: .infinity)
            }
          }
          .buttonStyle(.borderedProminent)
          .frame(minHeight: 44)
          .disabled(busy || !InvitationCode.looksComplete(code))
          .accessibilityIdentifier("invite-login")
        }
        Section("没有邀请码？") {
          Button("用配对二维码连接（旧方式）") { showScanner = true }
            .accessibilityIdentifier("invite-scan-fallback")
          Text("请帮你装 App 的人在网页版「我的邀请码」里把码发给你。").font(.caption).foregroundStyle(Palette.muted)
        }
      }
      .navigationTitle("登录")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarLeading) { Button("关闭") { dismiss() } } }
      .sheet(isPresented: $showScanner) {
        CameraScanner { payload in
          showScanner = false
          Task {
            await store.redeemCloudPairing(qrText: payload)
            if store.pairing != nil { dismiss() }
          }
        }
      }
    }
  }

  private func login() async {
    busy = true
    defer { busy = false }
    // 规范化后的码发给服务器（服务器仍会自己再规范化一次）。
    let normalized = InvitationCode.normalize(code) ?? code
    if await store.loginWithInvitation(code: normalized, host: host) { dismiss() }
  }
}
