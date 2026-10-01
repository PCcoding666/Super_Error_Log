import SwiftUI

// T6c：设置——做题时段、原卷通常在哪、连接设置。保存失败显示服务器文案。

struct LoopSettingsView: View {
  @Environment(LoopStore.self) private var loopStore
  @Environment(\.dismiss) private var dismiss
  @State private var slot = ""
  @State private var location = "varies"
  @State private var saving = false
  @State private var showConnection = false

  private let quickSlots = ["周三晚自习", "周末", "本周内"]

  var body: some View {
    NavigationStack {
      Form {
        Section("做题时段") {
          TextField("比如：周三晚自习", text: $slot)
            .accessibilityIdentifier("settings-practice-slot")
          HStack(spacing: 8) {
            ForEach(quickSlots, id: \.self) { quick in
              Button(quick) { slot = quick }
                .font(.caption)
                .frame(minHeight: 44)
                .padding(.horizontal, 10)
                .background(Palette.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Palette.line.opacity(0.5)))
                .accessibilityIdentifier("settings-slot-\(quick)")
            }
          }
        }
        Section("原卷通常在哪") {
          Picker("原卷通常在哪", selection: $location) {
            Text("学校").tag("school")
            Text("家").tag("home")
            Text("不固定").tag("varies")
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("settings-paper-location")
        }
        Section("连接") {
          Button("连接设置") { showConnection = true }
            .frame(minHeight: 44)
            .accessibilityIdentifier("settings-connection")
        }
        if let error = loopStore.lastError {
          Section {
            Text(error).foregroundStyle(CardTone.red.color)
              .accessibilityIdentifier("settings-error")
          }
        }
        Section {
          Button("保存") {
            saving = true
            Task {
              await loopStore.saveSettings(practiceSlot: slot.trimmingCharacters(in: .whitespaces),
                paperLocation: V2PaperLocation(rawValue: location))
              saving = false
              if loopStore.lastError == nil { dismiss() }
            }
          }
          .frame(maxWidth: .infinity, minHeight: 44)
          .disabled(saving || !slotValid)
          .accessibilityIdentifier("settings-save")
        }
      }
      .navigationTitle("设置")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarLeading) { Button("关闭") { dismiss() } } }
    }
    .sheet(isPresented: $showConnection) { PairingSettingsView() }
    .task {
      await loopStore.loadSettings()
      if let settings = loopStore.settings {
        slot = settings.practiceSlot
        location = settings.paperLocation.rawValue
        if !["school", "home", "varies"].contains(location) { location = "varies" }
      }
    }
  }

  /// 接口约束：practiceSlot 为 1–20 字。
  private var slotValid: Bool {
    let trimmed = slot.trimmingCharacters(in: .whitespaces)
    return !trimmed.isEmpty && trimmed.count <= 20
  }
}
