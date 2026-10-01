import SwiftUI

struct PairingSettingsView: View {
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var address = "http://127.0.0.1:3101"
  @State private var token = ""
  @State private var showScanner = false
  var body: some View {
    NavigationStack {
      Form {
        Section("云端识别服务") {
          CloudConnectionRow(state: store.connectionState ?? .unpaired, onScan: { showScanner = true })
        }
        Section("连接本机服务") {
          if store.pairing != nil { Text("已保存本机配对").accessibilityIdentifier("pairing-saved") }
          TextField("本机地址", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("pairing-address")
          SecureField("本机配对口令", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("pairing-token")
          Text("当前仅支持这台 Mac 上的 iPhone 模拟器和回环地址。配对口令保存在本机钥匙串中；不要输入模型 API 密钥。").font(.caption)
        }
        Button("保存连接") { if store.savePairing(address: address, token: token) { dismiss() } }
          .disabled((try? PairingConfiguration(baseURL: address, token: token)) == nil).accessibilityIdentifier("save-pairing")
      }.navigationTitle("连接设置").toolbar { Button("关闭") { dismiss() } }
      .sheet(isPresented: $showScanner) {
        CameraScanner { payload in
          showScanner = false
          Task { await store.redeemCloudPairing(qrText: payload) }
        }
      }
    }.onAppear { if store.pairing?.isCloud != true { address = store.pairing?.baseURL.absoluteString ?? address } }
  }
}

/// Task 5：云端连接状态行——状态徽标 + 按状态给出中文操作（重试连接 / 重新配对 / 开始上传）。
/// 每个状态既有文案也有可点操作，绝不出现「灰色不可用死按钮」。
struct CloudConnectionRow: View {
  let state: ConnectionState
  /// 未配对/重新配对操作打开扫码页（由宿主视图提供；缺省时退化为仅重查）。
  var onScan: (() -> Void)? = nil
  @Environment(StudyStore.self) private var store
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: icon).foregroundStyle(Palette.teal)
        Text(state.title).font(.subheadline.weight(.semibold))
        Spacer(minLength: 0)
      }
      .accessibilityIdentifier("connection-state-\(state.key)")
      if state == .unpaired {
        Text("扫码连接这台 Mac 上的识别服务，或使用下方本机地址手动连接。")
          .font(.caption).foregroundStyle(Palette.muted)
      } else if state == .incompatible {
        Text("服务版本或归属与配对不一致，需要重新扫码。")
          .font(.caption).foregroundStyle(Palette.muted)
      }
      actionButton
    }
    .padding(14)
    .background(Palette.mint.opacity(0.4), in: RoundedRectangle(cornerRadius: 14))
    .task {
      // 已配对待检查 / 打开设置页时自动触发一次检查（强制绕过 30 秒显示缓存）。
      if state == .pairedNeedsCheck { await store.checkConnection(force: true) }
    }
  }

  private var icon: String {
    switch state {
    case .unpaired: "icloud.slash"
    case .pairedNeedsCheck: "icloud.and.arrow.up"
    case .checking: "arrow.triangle.2.circlepath.icloud"
    case .ready: "checkmark.icloud.fill"
    case .busy: "hourglass"
    case .failed: "wifi.exclamationmark"
    case .unauthorized: "person.crop.circle.badge.exclamationmark"
    case .incompatible: "exclamationmark.arrow.triangle.2.circlepath"
    }
  }

  @ViewBuilder
  private var actionButton: some View {
    switch state {
    case .unpaired:
      // 未配对的「扫码配对」必须真的打开扫码页，绝不做无声无操作的死按钮。
      Button(state.actionTitle) { onScan?() }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("scan-to-pair")
    case .pairedNeedsCheck, .checking, .ready, .busy, .failed:
      Button(state.actionTitle) { Task { await store.connectionAction() } }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("retry-connection")
    case .unauthorized, .incompatible:
      Button(state.actionTitle) {
        // 先清凭据回到未配对，再弹出扫码页让用户立即重新配对。
        Task {
          await store.connectionAction()
          onScan?()
        }
      }
      .buttonStyle(.borderedProminent)
      .accessibilityIdentifier("repair-connection")
    }
  }
}
