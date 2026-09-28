import PhotosUI
import SwiftUI
import UIKit

struct ThisWeekView: View {
  @Environment(StudyStore.self) private var store
  @Binding var tab: Int
  @State private var photos: [PhotosPickerItem] = []
  @State private var importing = false
  @State private var showCamera = false
  @State private var settings = false
  @State private var source: PhotoReference?
  @State private var selectedPhotos: Set<String> = []
  @State private var consentBatch: UploadConsentBatch?
  @State private var showScanner = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        HStack {
          Label("超级错题本", systemImage: "square.stack.3d.up.fill").font(.caption.weight(.bold))
          Spacer()
          Button { settings = true } label: { Image(systemName: "gearshape") }
            .accessibilityLabel("连接设置").accessibilityIdentifier("recognition-settings")
        }.foregroundStyle(Palette.teal)
        if let state = store.connectionState {
          CloudConnectionRow(state: state, onScan: { showScanner = true })
        }
        nextStepBar
        VStack(alignment: .leading, spacing: 12) {
          Eyebrow(text: "周末整理一下")
          Text("想一想，\n下周更轻松。")
            .font(.system(.largeTitle, design: .serif, weight: .medium)).foregroundStyle(Palette.ink)
          Text("留下收获，放下重复忙碌。").font(.subheadline).foregroundStyle(Palette.muted)
        }
        PaperCard {
          VStack(alignment: .leading, spacing: 14) {
            Text("一次只想一道题。").font(.title2.weight(.semibold))
            Text("已保存 \(store.completedCount) 次真实题目复盘").font(.subheadline).foregroundStyle(Palette.teal)
            Text("\(store.state.realProblems.count) 道题已由你对照原图确认。示例练习单独保留。").font(.caption).foregroundStyle(Palette.muted)
            Button(store.hasDraft ? "继续复盘" : "开始复盘") { tab = 1 }
              .buttonStyle(PrimaryButton()).accessibilityIdentifier("home-start-reflection")
          }
        }
        VStack(alignment: .leading, spacing: 14) {
          Text("带上这周的练习").font(.title3.weight(.semibold))
          Text("整页拍摄也可以，请把题目和解题过程都拍进去。照片先保存在本机，上传前会再次征求你的同意。")
            .font(.subheadline).foregroundStyle(Palette.muted)
          HStack {
            PhotosPicker(selection: $photos, maxSelectionCount: 10, matching: .images) {
              Label("添加照片", systemImage: "plus").frame(maxWidth: .infinity).padding(16)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: 16))
            }.disabled(importing).accessibilityIdentifier("add-photos")
            Button {
              CameraCapture.request { allowed in
                if allowed { showCamera = true }
                else { store.errorMessage = "无法使用相机。请添加照片，或在系统设置中允许相机访问。" }
              }
            } label: { Image(systemName: "camera").padding(18).background(Palette.card, in: RoundedRectangle(cornerRadius: 16)) }
              .accessibilityLabel("拍照")
          }
          if importing { ProgressView("正在将照片保存到本机…") }
          ForEach(Array(store.state.importedPhotos.enumerated()), id: \.element) { index, name in
            let task = store.state.recognitionTasks.first { $0.photoName == name }
            photoCard(index: index, name: name, task: task)
          }
          if !store.state.importedPhotos.isEmpty {
            Text("每次最多识别 10 张，其余照片保留在本机，可分批选择。")
              .font(.caption).foregroundStyle(Palette.muted)
          }
        }
        Text("识别得到的是待核对的候选题；批改标记和订正痕迹不代表应用已判断对错。")
          .font(.caption).foregroundStyle(Palette.muted)
        Button("读取本机已有识别任务") { Task { await store.syncExistingJobs() } }
          .disabled(store.syncing).accessibilityIdentifier("sync-existing-recognitions")
        if store.syncing { ProgressView("正在读取已有任务与原图…") }
      }.padding(24)
    }.background(Palette.paper).toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if !pendingPhotos.isEmpty {
          Button("识别所选照片（\(selectedPhotos.count)）") {
            let names = store.state.uploadBatch(selected: selectedPhotos)
            if !names.isEmpty { consentBatch = UploadConsentBatch(names: names) }
          }
          .buttonStyle(PrimaryButton()).disabled(selectedPhotos.isEmpty || !store.busyTasks.isEmpty)
          .accessibilityIdentifier("recognize-selected")
          .padding(.horizontal, 24).padding(.vertical, 12).background(Palette.paper)
        }
      }
      .sheet(isPresented: $settings) { PairingSettingsView() }
      .sheet(isPresented: $showScanner) {
        CameraScanner { payload in
          showScanner = false
          Task { await store.redeemCloudPairing(qrText: payload) }
        }
      }
      .sheet(isPresented: $showCamera) { CameraCapture { data in Task { await store.importPhoto(data); selectPending() } } }
      .sheet(item: $source) { SourcePhotoView(reference: $0) }
      .sheet(item: $consentBatch) { batch in
        UploadConsentView(names: batch.names) {
          let names = batch.names
          consentBatch = nil
          Task { await store.submitPhotos(names); selectPending() }
        }
      }
      .onAppear { selectPending() }
      .onChange(of: photos) { _, selection in
        guard !selection.isEmpty else { return }
        importing = true
        Task {
          for item in selection {
            do {
              guard let data = try await item.loadTransferable(type: Data.self) else { continue }
              await store.importPhoto(data)
            } catch { store.errorMessage = "无法载入照片，请检查 iCloud 或换一张重试。" }
          }
          importing = false; photos = []; selectPending()
        }
      }
  }
  /// M1：顶部「下一步」摘要条。只在有真实待办时橙色可点；有未知状态/仍在识别时如实说明；
  /// 仅当无待办、无在途、无未知时才绿色。计数全部来自真实任务状态，不伪造百分比。
  @ViewBuilder private var nextStepBar: some View {
    let tasks = store.state.recognitionTasks.filter { $0.job != nil }
    if !tasks.isEmpty {
      let presentations = tasks.map { TaskPresentation.photoCard(task: $0, uploading: false) }
      let todo = tasks.reduce(0) { $0 + ($1.job?.questions.filter { ["ready", "needs_check"].contains($0.status) }.count ?? 0) }
      let failed = tasks.reduce(0) { $0 + ($1.job?.questions.filter { $0.status == "failed" }.count ?? 0) }
        + tasks.filter { $0.job.map { ["failed", "interrupted"].contains($0.status) } ?? false }.count
      let active = tasks.filter { $0.job?.active == true }.count
      let unknown = presentations.filter { $0.needsRefresh }.count
      if todo + failed > 0, let target = tasks.first(where: {
        let p = TaskPresentation.photoCard(task: $0, uploading: false)
        return p.actionable
      }) {
        NavigationLink { RecognitionView(taskID: target.id, tab: $tab) } label: {
          Text("⚑ " + [todo > 0 ? "\(todo) 道题等你核对" : "", failed > 0 ? "\(failed) 项没识别成功" : ""]
            .filter { !$0.isEmpty }.joined(separator: " · ") + " —— 点这里开始")
            .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
        }
        .background(Color(uiColor: .systemOrange).opacity(0.14), in: RoundedRectangle(cornerRadius: 16))
        .foregroundStyle(Color(uiColor: .systemOrange))
        .accessibilityIdentifier("next-step-bar")
      } else if unknown > 0 {
        // 必须有真实动作：只读刷新已有任务，不新增识别。
        Button("有题目的状态需要刷新核对——点这里刷新") { Task { await store.refreshJobs() } }
          .font(.subheadline).foregroundStyle(Palette.muted).frame(minHeight: 44)
          .accessibilityIdentifier("refresh-stale-status")
      } else if active > 0 {
        Text("识别仍在进行，完成后会出现在这里").font(.subheadline).foregroundStyle(Palette.muted)
      } else {
        Text("没有待处理的事项").font(.subheadline).foregroundStyle(Palette.teal)
      }
    }
  }

  /// M1：照片卡。有识别任务的卡整卡可点进同一任务（候选列表）；仅本机未上传的卡保持勾选语义。
  @ViewBuilder private func photoCard(index: Int, name: String, task: LocalRecognitionTask?) -> some View {
    if let task, task.job != nil {
      // busyTasks 也包含确认/重试——只有尚无 job（上传阶段）时才标「上传中」。
      let presentation = TaskPresentation.photoCard(task: task, uploading: false)
      NavigationLink { RecognitionView(taskID: task.id, tab: $tab) } label: {
        photoCardBody(index: index, name: name, presentation: presentation, issue: task.lastIssueKind)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("recognition-job-\(task.id)")
      .accessibilityElement(children: .combine)
      .accessibilityLabel("照片 \(index + 1)，\(presentation.headline)。\(presentation.nextStep)")
      .accessibilityHint("打开这道任务的题目列表")
    } else {
      photoCardLocal(index: index, name: name, task: task)
    }
  }

  private func photoCardBody(index: Int, name: String, presentation: PhotoCardPresentation, issue: RefreshIssue?) -> some View {
    HStack(alignment: .top, spacing: 12) {
      LocalPhotoThumbnail(url: store.photoURL(name)).frame(width: 62, height: 76).clipped()
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 5) {
        Text("照片 \(index + 1) · 已保存在本机").font(.subheadline.weight(.semibold))
        statusChip(presentation.headline, presentation.tone)
        if !presentation.counts.isEmpty {
          Text(presentation.counts).font(.caption.weight(.medium)).foregroundStyle(Palette.muted)
        }
        if let issue {
          Text(issue.studentText).font(.caption).foregroundStyle(Palette.muted)
            .accessibilityIdentifier("photo-issue-\(name)")
        }
        Text(presentation.nextStep).font(.caption).foregroundStyle(Palette.teal)
      }
      Spacer(minLength: 0)
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
      .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.line.opacity(0.5)))
  }

  /// 未上传/上传中的本机照片卡：勾选参与下一批上传，保留真实字节进度。
  @ViewBuilder private func photoCardLocal(index: Int, name: String, task: LocalRecognitionTask?) -> some View {
    // 上传只发生在尚无 job 的阶段；busyTasks 同时覆盖确认/重试，不能据此标「上传中」。
    let uploading = task.map { store.busyTasks.contains($0.id) && $0.job == nil } ?? false
    let presentation = task.map { TaskPresentation.photoCard(task: $0, uploading: uploading) }
      ?? PhotoCardPresentation(tone: .gray, headline: "仅保存在本机，尚未上传", counts: "", nextStep: "选择后上传识别", actionable: false, needsRefresh: false)
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        LocalPhotoThumbnail(url: store.photoURL(name)).frame(width: 62, height: 76).clipped()
          .accessibilityLabel("已导入的本机照片").accessibilityIdentifier("local-photo-\(name)")
        VStack(alignment: .leading, spacing: 5) {
          Text("照片 \(index + 1) · 已保存在本机").font(.subheadline.weight(.semibold))
          statusChip(presentation.headline, presentation.tone)
          if uploading, let task, let progress = store.uploadProgress[task.id] {
            ProgressView(value: progress) {
              Text("已上传 \(Int((progress * 100).rounded()))%")
                .font(.caption2).foregroundStyle(Palette.muted)
            }
          }
          Button("查看完整原图") { source = PhotoReference(url: store.originalURL(name), title: "照片 \(index + 1)") }
            .font(.caption).frame(minHeight: 44)
        }
        Spacer(minLength: 0)
        if task?.job == nil {
          Button {
            if selectedPhotos.contains(name) { selectedPhotos.remove(name) }
            else if selectedPhotos.count < 10 { selectedPhotos.insert(name) }
            else { store.errorMessage = "每次最多选择 10 张照片，其余照片仍保留在本机。" }
          } label: {
            Image(systemName: selectedPhotos.contains(name) ? "checkmark.circle.fill" : "circle")
              .font(.title2).frame(width: 44, height: 44)
          }
          .accessibilityLabel("选择照片 \(index + 1)")
        }
      }
      if let error = task?.lastError { Text(error).font(.caption).foregroundStyle(Palette.muted) }
    }.padding(16).background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
      .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.line.opacity(0.5)))
  }

  /// 每页照片的状态徽标：语义五色——灰=仅本机/待更新，蓝=系统在工作（上传/识别），橙=待你核对，
  /// 绿=已确认，红=失败可重试。规则一句话：「看到橙色就是你的活」。
  private func statusChip(_ title: String, _ tone: CardTone) -> some View {
    Text(title).font(.caption.weight(.medium)).foregroundStyle(tone.color)
      .padding(.horizontal, 8).padding(.vertical, 3)
      .background(tone.color.opacity(0.12), in: Capsule())
  }

  private var pendingPhotos: [String] {
    store.state.importedPhotos.filter { name in
      store.state.recognitionTasks.first(where: { $0.photoName == name })?.job == nil
    }
  }
  private func selectPending() {
    selectedPhotos = Set(pendingPhotos.prefix(10))
  }
}

struct LocalPhotoThumbnail: View {
  let url: URL
  @Environment(StudyStore.self) private var store
  @State private var image: UIImage?
  var body: some View {
    Group {
      if let image { Image(uiImage: image).resizable().scaledToFit() }
      else { Image(systemName: "photo").foregroundStyle(Palette.muted) }
    }.task(id: "\(url.absoluteString):\(store.mediaRevision)") {
      image = await Task.detached { UIImage(contentsOfFile: url.path) }.value
    }
  }
}

struct UploadConsentView: View {
  let names: [String]
  var agree: () -> Void
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          SectionTitle(title: "上传前，请确认", subtitle: "这次将发送 \(names.count) 张照片。")
          ForEach(names, id: \.self) { name in
            LocalPhotoThumbnail(url: store.photoURL(name)).frame(maxHeight: 180)
              .accessibilityLabel("待上传的本机照片").accessibilityIdentifier("consent-photo-\(name)")
          }
          if store.pairing?.isCloud == true {
            Text("照片将上传到你的广州云服务器，再由阿里云百炼处理。图片可能包含姓名、笔迹或其他个人信息，请先检查所选照片。")
          } else {
            Text("照片将先发送到这台 Mac 的本机识别服务，再由阿里云百炼处理。图片可能包含姓名、笔迹或其他个人信息，请先检查所选照片。")
          }
          Text("原始照片保存在本机。上传使用一次生成并保存的 JPEG 副本，可能改变压缩和方向表示；重试会发送同一份副本。服务商的数据处理不由本应用控制。")
            .font(.subheadline).foregroundStyle(Palette.muted)
          if store.pairing == nil {
            Text("尚未连接识别服务，请返回连接设置或扫码配对后再上传。").font(.subheadline).foregroundStyle(Palette.teal)
          } else if store.pairing?.isCloud == true, let state = store.connectionState, state != .ready {
            Text("当前云端连接状态：\(state.title)。上传前会重新检查连接。").font(.subheadline).foregroundStyle(Palette.teal)
          }
          Button("同意上传并识别", action: agree).buttonStyle(PrimaryButton())
            .disabled(names.isEmpty || store.pairing == nil).accessibilityIdentifier("consent-upload")
          Button("暂不上传") { dismiss() }.frame(maxWidth: .infinity)
        }.padding(24)
      }.background(Palette.paper).navigationTitle("照片上传确认").navigationBarTitleDisplayMode(.inline)
    }
  }
}

struct UploadConsentBatch: Identifiable {
  let id = UUID()
  let names: [String]
}

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
