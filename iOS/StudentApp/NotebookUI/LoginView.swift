import SwiftUI

/// 邀请码登录页：学生输入老师 / 家长给的 12 位邀请码，和手机网页版是同一个账号、同一份错题本。
struct LoginView: View {
  let account: AccountSession
  @State private var code = ""
  @State private var host = CloudPairing.domainHost
  @FocusState private var codeFocused: Bool

  var body: some View {
    NavigationStack {
      Form {
        if let notice = account.notice {
          Section { Label(notice, systemImage: "exclamationmark.circle").foregroundStyle(Palette.muted) }
            .accessibilityIdentifier("login-notice")
        }
        Section {
          TextField("XXXX-XXXX-XXXX", text: $code)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .font(.title3.monospaced())
            .focused($codeFocused)
            .submitLabel(.go)
            .onSubmit { Task { await login() } }
            .accessibilityIdentifier("invite-code")
          Text("和手机网页版用同一个邀请码。登录后错题都记在服务器上，换手机也不丢。")
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
              if account.isLoggingIn { ProgressView() }
              Text(account.isLoggingIn ? "正在登录…" : "登录").frame(maxWidth: .infinity)
            }
          }
          .buttonStyle(.borderedProminent)
          .frame(minHeight: 44)
          .disabled(account.isLoggingIn || !InvitationCode.looksComplete(code))
          .accessibilityIdentifier("invite-login")
          if let error = account.loginError {
            Text(error).font(.footnote).foregroundStyle(CardTone.red.color).accessibilityIdentifier("login-error")
          }
        }
        Section("没有邀请码？") {
          Text("请帮你装 App 的人在网页版「我的邀请码」里把码发给你。").font(.caption).foregroundStyle(Palette.muted)
        }
      }
      .navigationTitle("超级错题本")
      .scrollDismissesKeyboard(.interactively)
    }
  }

  private func login() async {
    guard InvitationCode.looksComplete(code) else { return }
    codeFocused = false
    await account.login(code: code, host: host)
  }
}
