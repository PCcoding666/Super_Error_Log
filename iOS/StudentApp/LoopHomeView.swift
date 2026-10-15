import AVFoundation
import PhotosUI
import SwiftUI
import UIKit

// T6c：单一「本周」主页。自上而下：顶部与连接状态、拍这周的错题、照片进度、本周错题卡片。
// 练习与结果两块留给 T6d/T6e（本视图不放占位）。界面只求可用、清楚。
// 学生端重做第 1 期：顶部加「今天」卡（WeekPlan 算出的步骤清单 / 做完了 / 周中），底部固定下一步按钮；
// 练习流程的路由提到这里（HomeFlow.path），下一步按钮、清单行、练习卡推同一套页面；
// 拍照、勾选面板、上传、扫码仍由主页现有状态触发。其余部分原样留在卡片下面。

struct LoopHomeView: View {
  @Environment(StudyStore.self) private var store
  @Environment(LoopStore.self) private var loopStore
  @Environment(HomeFlow.self) private var flow
  @State private var photos: [PhotosPickerItem] = []
  @State private var importing = false
  @State private var showCamera = false
  /// 没有相机的设备（如模拟器）上「拍第一页」改开相册。
  @State private var showLibrary = false
  @State private var showSettings = false
  @State private var showScanner = false
  @State private var source: PhotoReference?
  @State private var consentBatch: UploadConsentBatch?
  @State private var attemptedAutoUpload: Set<String> = []
  @State private var undo = DiscardUndo()
  @State private var undoTask: Task<Void, Never>?
  @State private var correctionTarget: ItemReference?
  @State private var detailItemID: String?
  @State private var retryPhoto: PhotoRetry?
  @State private var recognizedPhotoCount = 0
  @State private var pickTask: PickReference?
  @State private var showMissedList = false
  /// 子页面交给主页做的事（拍照、勾选面板、上传、扫码）：等回到今天、而且没有别的弹出页时再做，
  /// 不能因为当时正好有弹出页就悄悄丢掉（评审修正）。只在内存里。
  @State private var pendingHomeAction: NextStepAction?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        header
        TodayStepsCard(result: plan, practiceSlot: plan.practice?.practiceSlot ?? loopStore.settings?.practiceSlot,
          offlineNote: offlineNote, perform: perform)
        connectionSection
        captureSection
        photoProgressSection
        itemSection
        LoopPracticeSection()
      }.padding(24)
    }
    .background(Palette.paper)
    // T6k/S2-R1：顶部同色背景盖住状态栏——inset 本身高 0，
    // 背景向上延伸进安全区，滚动内容不再钻到状态栏（时间、电量）下面。
    .safeAreaInset(edge: .top, spacing: 0) {
      Color.clear.frame(height: 0)
        .background(Palette.paper, ignoresSafeAreaEdges: .top)
    }
    .refreshable { await loopStore.refreshWeek() }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      VStack(spacing: 0) {
        undoBar
        if let next = plan.next { NextStepBar(model: next, perform: perform) }
      }
    }
    .photosPicker(isPresented: $showLibrary, selection: $photos, maxSelectionCount: 10, matching: .images)
    .navigationDestination(for: PracticeRoute.self) { route in practiceDestination(route) }
    .onChange(of: flow.homeRequest) { _, request in
      guard request != nil, let action = flow.consumeHomeRequest() else { return }
      pendingHomeAction = action
      firePendingHomeActionSoon()
    }
    .onChange(of: isPresentingSomething) { _, presenting in
      // 弹出页 / 提示框 / 推入的页面都关掉了：还有没做的就接着做。
      if !presenting { firePendingHomeActionSoon() }
    }
    .sheet(isPresented: $showSettings) { LoopSettingsView() }
    .sheet(isPresented: $showScanner) {
      CameraScanner { payload in
        showScanner = false
        Task { await store.redeemCloudPairing(qrText: payload) }
      }
    }
    .sheet(isPresented: $showCamera) {
      CameraCapture { data in
        Task {
          await store.importPhoto(data)
          runIntake()
        }
      }
    }
    .sheet(item: $source) { SourcePhotoView(reference: $0) }
    .sheet(item: $consentBatch) { batch in
      UploadConsentView(names: batch.names) {
        let names = batch.names
        consentBatch = nil
        store.grantUploadConsent()
        attemptedAutoUpload.formUnion(names)
        Task { await store.submitPhotos(names) }
      }
    }
    .sheet(item: $correctionTarget) { CorrectionSheet(itemID: $0.itemID) }
    .sheet(item: $pickTask) { PhotoPickSheet(taskID: $0.taskID) }
    .sheet(isPresented: $showMissedList) { MissedPickListSheet() }
    .navigationDestination(item: $detailItemID) { itemID in
      LoopItemDetailView(itemID: itemID, onCorrect: { correctionTarget = ItemReference(itemID: $0) },
        onDiscard: { id in
          // 移出成功后返回主页（撤销条在主页照常出现）。
          Task {
            if await discard(id) { detailItemID = nil }
          }
        })
    }
    .confirmationDialog("重新识别这张照片？", isPresented: Binding(
      get: { retryPhoto != nil }, set: { if !$0 { retryPhoto = nil } }), titleVisibility: .visible) {
      Button("重新识别") {
        if let retryPhoto { Task { await store.retryFailed(taskID: retryPhoto.taskID) } }
        retryPhoto = nil
      }
      Button("取消", role: .cancel) { retryPhoto = nil }
    } message: {
      Text("会再次请求 AI 重新识别。")
    }
    .task {
      await loopStore.refreshWeek()
      recognizedPhotoCount = recognizedCount
      runIntake()
    }
    .onChange(of: store.state.importedPhotos) { _, _ in runIntake() }
    .onChange(of: store.connectionState) { _, _ in runIntake() }
    .onChange(of: store.hasUploadConsent) { _, _ in runIntake() }
    .onChange(of: recognizedCount) { old, new in
      // 照片识别完成后自动刷新本周错题。
      if new > old { Task { await loopStore.refreshWeek() } }
      recognizedPhotoCount = new
    }
  }

  // MARK: - 0. 今天（第 1 期）

  private var plan: WeekPlan.Result {
    TodayPlan.plan(store: store, loopStore: loopStore, skipped: flow.skipped)
  }

  /// 没联网 / 连不上服务器时卡片顶上那一行（§3.4）：清单照常显示，说明是哪时保存的内容。
  private var offlineNote: String? {
    let lead: String
    switch loopStore.weekIssue {
    case .offline: lead = "没联网"
    case .serviceUnavailable: lead = "连不上服务器"
    default: return nil
    }
    if let savedAt = loopStore.cacheSavedAt {
      return "\(lead)，显示的是 \(savedAt.formatted(date: .omitted, time: .shortened)) 保存的内容"
    }
    return lead
  }

  /// 下一步按钮与清单行：导航交给 HomeFlow；拍照、勾选面板、上传、扫码用主页现有的状态。
  private func perform(_ action: NextStepAction) {
    switch action {
    case .scan:
      showScanner = true
    case .rescan:
      // 与连接行的「重新扫码」相同：先清凭据回到未配对，再打开扫码页。
      // 直接走 repairByRescan（不看当前状态）；不经 connectionAction，它对「连不上」只会重查、不清凭据。
      store.repairByRescan()
      showScanner = true
    case .capture:
      startCapture()
    case .uploadPending:
      uploadAllPending()
    case .openPick(let taskID):
      pickTask = PickReference(taskID: taskID)
    default:
      flow.perform(action)
    }
  }

  /// 主页上是否正盖着别的东西（弹出页、提示框、推入的页面）。这时不能再弹出相机 / 面板。
  private var isPresentingSomething: Bool {
    showSettings || showScanner || showCamera || showLibrary || showMissedList
      || source != nil || consentBatch != nil || correctionTarget != nil || pickTask != nil
      || retryPhoto != nil || detailItemID != nil || store.errorMessage != nil || !flow.path.isEmpty
  }

  /// 等导航或弹出页的动画结束（约 0.45 秒）再做；那时还盖着别的东西就继续等，等它关掉时再试。
  private func firePendingHomeActionSoon() {
    guard pendingHomeAction != nil else { return }
    Task {
      try? await Task.sleep(for: .milliseconds(450))
      guard let action = pendingHomeAction, !isPresentingSomething else { return }
      pendingHomeAction = nil
      perform(action)
    }
  }

  /// 「拍第一页」：直接打开系统相机；没有相机的设备（模拟器）打开相册。
  /// 模拟器上 isSourceTypeAvailable(.camera) 可能为真但没有任何摄像头，所以同时看有没有视频设备。
  private func startCapture() {
    guard UIImagePickerController.isSourceTypeAvailable(.camera), AVCaptureDevice.default(for: .video) != nil else {
      showLibrary = true
      return
    }
    CameraCapture.request { allowed in
      if allowed { showCamera = true }
      else { store.errorMessage = "无法使用相机。请添加照片，或在系统设置中允许相机访问。" }
    }
  }

  /// 「上传照片」：没同意先问一次，已同意直接传（每批最多 10 张）。
  private func uploadAllPending() {
    let names = Array(pendingPhotoNames.prefix(10))
    guard !names.isEmpty else { return }
    if store.hasUploadConsent {
      attemptedAutoUpload.formUnion(names)
      Task { await store.submitPhotos(names) }
    } else {
      consentBatch = UploadConsentBatch(names: names)
    }
  }

  @ViewBuilder private func practiceDestination(_ route: PracticeRoute) -> some View {
    switch route {
    case .pick:
      PracticePickView()
    case .detail(let practiceID):
      PracticeDetailView(practiceID: practiceID)
    case .followup(let practiceID, let itemID):
      FollowupView(itemID: itemID, practiceID: practiceID).id(itemID)
    case .print(let practiceID):
      PracticePrintView(practiceID: practiceID)
    case .record(let practiceID):
      PracticeRecordEntry(practiceID: practiceID)
    case .summary(let practiceID):
      PracticeSummaryView(practiceID: practiceID)
    }
  }

  // MARK: - 1. 顶部

  private var header: some View {
    HStack {
      Text("超级错题本").font(.title2.weight(.semibold)).foregroundStyle(Palette.ink)
      Spacer()
      Button { showSettings = true } label: {
        Image(systemName: "gearshape").frame(width: 44, height: 44)
      }
      .accessibilityLabel("设置")
      .accessibilityIdentifier("open-settings")
    }
  }

  private var connectionSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let state = store.connectionState {
        CloudConnectionRow(state: state, onScan: { showScanner = true })
      } else if store.pairing == nil {
        CloudConnectionRow(state: .unpaired, onScan: { showScanner = true })
      }
      if loopStore.isShowingCache || loopStore.weekIssue == .offline {
        Text(cacheNote).font(.caption).foregroundStyle(Palette.muted)
          .accessibilityIdentifier("cache-note")
      }
      if let error = loopStore.lastError {
        HStack(spacing: 12) {
          Text(error).font(.caption).foregroundStyle(Palette.muted)
          Spacer(minLength: 0)
          Button("知道了") { loopStore.clearError() }
            .font(.caption).frame(minWidth: 44, minHeight: 44)
            .accessibilityIdentifier("loop-error-dismiss")
        }
      }
    }
  }

  private var cacheNote: String {
    if let savedAt = loopStore.cacheSavedAt {
      return "显示的是上次保存的内容（\(savedAt.formatted(date: .omitted, time: .shortened))）"
    }
    return "显示的是上次保存的内容"
  }

  // MARK: - 2. 拍这周的错题

  private var captureSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("拍这周的错题").font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
      Text("整页拍全，别裁边；题目和你的作答都拍进去。")
        .font(.subheadline).foregroundStyle(Palette.muted)
      HStack(spacing: 12) {
        Button {
          CameraCapture.request { allowed in
            if allowed { showCamera = true }
            else { store.errorMessage = "无法使用相机。请添加照片，或在系统设置中允许相机访问。" }
          }
        } label: {
          Label("拍照", systemImage: "camera").frame(maxWidth: .infinity, minHeight: 44)
            .padding(.vertical, 8)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.line.opacity(0.5)))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("capture-photo")
        PhotosPicker(selection: $photos, maxSelectionCount: 10, matching: .images) {
          Label("从相册添加", systemImage: "plus").frame(maxWidth: .infinity, minHeight: 44)
            .padding(.vertical, 8)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.line.opacity(0.5)))
        }
        .disabled(importing)
        .accessibilityIdentifier("add-photos")
      }
      if importing { ProgressView("正在将照片保存到本机…") }
    }
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
        importing = false
        photos = []
        runIntake()
      }
    }
  }

  // MARK: - 3. 照片进度（还没上传 / 上传中 / 识别中 / 失败与部分失败且未移除的）

  @ViewBuilder private var photoProgressSection: some View {
    let rows = progressRows
    let missed = PhotoPickReminder.missedTasks(store.state.recognitionTasks)
    if !rows.isEmpty || !missed.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        if !rows.isEmpty {
          Text("照片进度").font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
          ForEach(rows) { row in photoProgressRow(row) }
        }
        // S2：补选入口——任何照片还有没勾的题时出现（行内已有勾选入口的照片不重复列）。
        if !missed.isEmpty {
          Button("漏了题？从照片里补选") { showMissedList = true }
            .font(.caption).frame(minHeight: 44)
            .foregroundStyle(Palette.teal)
            .accessibilityIdentifier("pick-missed")
        }
      }
    }
  }

  /// 还没上传 / 正在上传 / 正在识别 / 没识别成功 的照片；全部识别完成的不占位置。
  /// T6k：部分失败且没被移除的照片也列出来（失败的那几道不能悄悄没了）；
  /// 被学生移除（dismissPhoto）的失败照片不再出现。
  /// S2：整页没有批改痕迹（全部待学生勾选）且未处理的照片列出「这页没看到批改痕迹」行；
  /// 失败方案优先于勾选提示。
  private var progressRows: [PhotoProgressRow] {
    store.state.importedPhotos.compactMap { name in
      let task = store.state.recognitionTasks.first { $0.photoName == name }
      guard let job = task?.job else {
        return PhotoProgressRow(name: name, task: task, kind: .pending)
      }
      if job.status == "completed" || job.status == "partial" {
        if let task, task.dismissedFromProgress != true, PhotoFailurePlan.plan(for: task) != nil {
          return PhotoProgressRow(name: name, task: task, kind: .failed)
        }
        if let task, PhotoPickReminder.showsNoMarksRow(task) {
          return PhotoProgressRow(name: name, task: task, kind: .pick)
        }
        return nil
      }
      if job.status == "failed" || job.status == "interrupted" {
        guard task?.dismissedFromProgress != true else { return nil }
        return PhotoProgressRow(name: name, task: task, kind: .failed)
      }
      if job.active { return PhotoProgressRow(name: name, task: task, kind: .recognizing) }
      // 未知/待更新状态如实列出，不误报为完成。
      return PhotoProgressRow(name: name, task: task, kind: .unknown)
    }
  }

  @ViewBuilder private func photoProgressRow(_ row: PhotoProgressRow) -> some View {
    let uploading = row.task.map { store.busyTasks.contains($0.id) && $0.job == nil } ?? false
    let presentation = row.task.map { TaskPresentation.photoCard(task: $0, uploading: uploading) }
      ?? PhotoCardPresentation(tone: .gray, headline: "还没上传", counts: "",
        nextStep: "点「上传」开始识别", actionable: false, needsRefresh: false)
    // T6k：失败/部分失败的行按方案显示标题、说明与按钮；无方案（罕见状态）退回既有呈现。
    let plan = row.kind == .failed ? row.task.flatMap { PhotoFailurePlan.plan(for: $0) } : nil
    // S2：识别中且还有没勾的题 → 行内次要补选按钮。
    let pickMore = row.kind == .recognizing ? row.task.flatMap { PhotoPickReminder.pickMoreCount($0) } : nil
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 12) {
        LocalPhotoThumbnail(url: store.photoURL(row.name)).frame(width: 62, height: 76).clipped()
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 5) {
          Text(row.kind == .pick ? "这页没有批改痕迹，点「勾出错题」自己勾" : (plan?.title ?? presentation.headline))
            .font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
          if row.kind == .pick {
            Text("勾出你做错的题，只有勾出的题会进错题本").font(.caption).foregroundStyle(Palette.muted)
          }
          if let plan {
            Text(plan.detail).font(.caption).foregroundStyle(Palette.muted)
          }
          if row.kind != .pick, !presentation.counts.isEmpty {
            Text(presentation.counts).font(.caption).foregroundStyle(Palette.muted)
          }
          if uploading, let task = row.task, let progress = store.uploadProgress[task.id] {
            ProgressView(value: progress) {
              Text("已上传 \(Int((progress * 100).rounded()))%").font(.caption2).foregroundStyle(Palette.muted)
            }
          }
          if let issue = row.task?.lastIssueKind {
            Text(issue.studentText).font(.caption).foregroundStyle(Palette.muted)
          }
          if let error = row.task?.lastError {
            Text(error).font(.caption).foregroundStyle(Palette.muted)
          }
        }
        Spacer(minLength: 0)
      }
      HStack(spacing: 12) {
        Button("看完整原图") {
          source = PhotoReference(url: store.originalURL(row.name), title: "完整原图")
        }
        .font(.caption).frame(minHeight: 44)
        .accessibilityIdentifier("photo-source-\(row.name)")
        if row.kind == .pending, !uploading {
          Button("上传") { uploadPending(row.name) }
            .font(.caption.weight(.semibold)).frame(minHeight: 44)
            .accessibilityIdentifier("photo-upload-\(row.name)")
        }
        if row.kind == .pick, let task = row.task {
          Button("勾出错题") { pickTask = PickReference(taskID: task.id) }
            .font(.caption.weight(.semibold)).frame(minHeight: 44)
            .accessibilityIdentifier("photo-pick-\(row.name)")
          Button("这页没有错题") { store.markPickDone(row.name) }
            .font(.caption).frame(minHeight: 44)
            .foregroundStyle(Palette.muted)
            .accessibilityIdentifier("photo-pickdone-\(row.name)")
        }
        if let pickMore, let task = row.task {
          Button("还有 \(pickMore) 道没选 · 补选") { pickTask = PickReference(taskID: task.id) }
            .font(.caption).frame(minHeight: 44)
            .foregroundStyle(Palette.teal)
            .accessibilityIdentifier("photo-pickmore-\(row.name)")
        }
        if row.kind == .failed, let task = row.task {
          let retrying = store.busyTasks.contains(task.id)
          if let retryTitle = plan?.retryTitle {
            Button(retrying ? "正在重试…" : retryTitle) { retryPhoto = PhotoRetry(taskID: task.id) }
              .font(.caption.weight(.semibold)).frame(minHeight: 44)
              .disabled(retrying)
              .accessibilityIdentifier("photo-retry-\(task.id.uuidString)")
          } else if plan == nil {
            // 无方案兜底的失败行（罕见状态）：保留旧的整卡重试入口。
            Button(retrying ? "正在重试…" : "重新识别这张照片") { retryPhoto = PhotoRetry(taskID: task.id) }
              .font(.caption.weight(.semibold)).frame(minHeight: 44)
              .disabled(retrying)
              .accessibilityIdentifier("photo-retry-\(task.id.uuidString)")
          }
          Button(plan?.dismissTitle ?? "移除这张") { store.dismissPhoto(row.name) }
            .font(.caption).frame(minHeight: 44)
            .foregroundStyle(Palette.muted)
            .accessibilityIdentifier("photo-dismiss-\(row.name)")
        }
      }
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.line.opacity(0.5)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("photo-progress-\(row.name)")
  }

  // MARK: - 4. 本周错题卡片

  @ViewBuilder private var itemSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("本周错题").font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
      if let week = loopStore.week {
        if week.items.isEmpty, week.backlog.isEmpty {
          emptyState
        } else {
          ForEach(week.items, id: \.id) { card in itemCard(card) }
          if !week.backlog.isEmpty {
            DisclosureGroup("更早的错题（\(week.backlog.count)）") {
              VStack(alignment: .leading, spacing: 12) {
                ForEach(week.backlog, id: \.id) { card in itemCard(card) }
              }.padding(.top, 8)
            }
            .foregroundStyle(Palette.ink)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("backlog-disclosure")
          }
        }
      } else if store.pairing == nil {
        Text("连上服务器以后，这里会显示本周错题")
          .font(.subheadline).foregroundStyle(Palette.muted)
          .accessibilityIdentifier("items-unpaired")
      } else {
        Text(loopStore.weekIssue?.studentText ?? "正在读取本周错题…")
          .font(.subheadline).foregroundStyle(Palette.muted)
      }
    }
  }

  @ViewBuilder private var emptyState: some View {
    if store.state.importedPhotos.isEmpty {
      Text("拍一张这周的错题开始").font(.subheadline).foregroundStyle(Palette.muted)
        .accessibilityIdentifier("items-empty-no-photos")
    } else if progressRows.contains(where: { $0.kind != .pick }) {
      // 设计稿 §5：没批改痕迹的页只留照片那一行「要你勾」，这里不再说「正在识别」自相矛盾。
      Text("正在识别，完成后题目会出现在这里").font(.subheadline).foregroundStyle(Palette.muted)
        .accessibilityIdentifier("items-empty-recognizing")
    } else if !progressRows.isEmpty {
      EmptyView()
    } else {
      Text("这些照片里没找到有批改痕迹的题").font(.subheadline).foregroundStyle(Palette.muted)
        .accessibilityIdentifier("items-empty-no-items")
    }
  }

  private func itemCard(_ card: V2ItemCard) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Button { detailItemID = card.id } label: {
        VStack(alignment: .leading, spacing: 10) {
          // 整题裁图通常是很宽的一条：放卡片顶部、占满宽度、高不超过 96pt、等比缩放居左。
          CropThumbnail(itemID: card.id)
            .frame(maxWidth: .infinity, maxHeight: 96, alignment: .leading)
            .clipped()
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
              Text(card.shortId ?? "题目").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
              if card.badge == .low {
                Text("字可能认错了 · 点开看看").font(.caption2.weight(.medium)).foregroundStyle(CardTone.orange.color)
                  .padding(.horizontal, 6).padding(.vertical, 2)
                  .background(CardTone.orange.color.opacity(0.12), in: Capsule())
              }
            }
            Text([card.subject, card.knowledgeTags.joined(separator: "、")].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
              .font(.caption).foregroundStyle(Palette.muted)
            if let excerpt = card.questionExcerpt, !excerpt.isEmpty {
              Text(excerpt).font(.caption).foregroundStyle(Palette.ink).lineLimit(2)
            }
            if let status = LoopText.cardStatus(card.status) {
              Text(status).font(.caption).foregroundStyle(Palette.teal)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("item-card-\(card.id)")
      HStack(spacing: 12) {
        if LoopText.canDiscard(card.status) {
          Button("不是错题") { Task { await discard(card.id) } }
            .font(.caption.weight(.semibold)).frame(minHeight: 44)
            .foregroundStyle(Palette.muted)
            .accessibilityIdentifier("item-discard-\(card.id)")
        }
        Button("不对，改一下") { correctionTarget = ItemReference(itemID: card.id) }
          .font(.caption.weight(.semibold)).frame(minHeight: 44)
          .foregroundStyle(Palette.teal)
          .accessibilityIdentifier("item-correct-\(card.id)")
      }
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.line.opacity(0.5)))
  }

  // MARK: - 不是错题与撤销

  /// 移出成功返回 true（撤销条照常出现）；失败（服务器拒绝等）返回 false，详情页据此决定是否返回主页。
  @discardableResult
  private func discard(_ itemID: String) async -> Bool {
    await loopStore.discard(itemID: itemID)
    guard loopStore.discardedItems.contains(where: { $0.id == itemID }) else { return false }
    undo.begin(itemID: itemID)
    undoTask?.cancel()
    undoTask = Task {
      try? await Task.sleep(for: .seconds(DiscardUndo.window))
      undo.tick()
    }
    return true
  }

  @ViewBuilder private var undoBar: some View {
    if undo.isVisible, undo.pendingItemID != nil {
      HStack(spacing: 12) {
        Text("已移出").font(.subheadline).foregroundStyle(Palette.ink)
        Spacer()
        Button("撤销") {
          if let itemID = undo.undo() {
            Task { await loopStore.restore(itemID: itemID) }
          }
        }
        .font(.subheadline.weight(.semibold)).frame(minWidth: 44, minHeight: 44)
        .foregroundStyle(Palette.teal)
        .accessibilityIdentifier("undo-discard")
      }
      .padding(.horizontal, 24).padding(.vertical, 10)
      .background(Palette.card)
      .overlay(Rectangle().fill(Palette.line.opacity(0.5)).frame(height: 1), alignment: .top)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("undo-bar")
    }
  }

  // MARK: - 进门策略

  private var pendingPhotoNames: [String] {
    store.state.importedPhotos.filter { name in
      store.state.recognitionTasks.first(where: { $0.photoName == name })?.job == nil
    }
  }

  private var isUploading: Bool {
    store.state.recognitionTasks.contains { $0.job == nil && store.busyTasks.contains($0.id) }
  }

  private var connectionReady: Bool {
    guard store.pairing != nil else { return false }
    if store.pairing?.isCloud == true { return store.connectionState == .ready }
    return true
  }

  private var recognizedCount: Int {
    store.state.recognitionTasks.filter { ["completed", "partial"].contains($0.job?.status ?? "") }.count
  }

  /// 同意只问一次；同意后新加的照片自动上传。已自动尝试过的不重复自动提交
  /// （失败的照片由卡片上的「上传」按钮手动重试）。
  private func runIntake() {
    switch IntakePolicy.next(hasConsented: store.hasUploadConsent, connectionReady: connectionReady,
      pendingPhotos: pendingPhotoNames, isUploading: isUploading) {
    case .idle, .waitForConnection:
      break
    case .askConsent(let names):
      if consentBatch == nil { consentBatch = UploadConsentBatch(names: names) }
    case .upload(let names):
      let fresh = names.filter { !attemptedAutoUpload.contains($0) }
      guard !fresh.isEmpty else { return }
      attemptedAutoUpload.formUnion(fresh)
      Task { await store.submitPhotos(fresh) }
    }
  }

  /// 卡片上的手动「上传」：未同意先问一次，已同意直接传。
  private func uploadPending(_ name: String) {
    if store.hasUploadConsent {
      attemptedAutoUpload.insert(name)
      Task { await store.submitPhotos([name]) }
    } else {
      consentBatch = UploadConsentBatch(names: [name])
    }
  }
}

// MARK: - 照片进度行

private struct PhotoProgressRow: Identifiable {
  enum Kind { case pending, recognizing, failed, unknown, pick }
  var id: String { name }
  let name: String
  let task: LocalRecognitionTask?
  let kind: Kind
}

private struct PhotoRetry: Identifiable {
  var id: UUID { taskID }
  let taskID: UUID
}

/// sheet(item:) 用的题目引用。
struct ItemReference: Identifiable {
  var id: String { itemID }
  let itemID: String
}

// MARK: - 整题裁图缩略（共用实现见 CropViews.swift 的 CropThumbnail）

// MARK: - 题目详情

struct LoopItemDetailView: View {
  let itemID: String
  let onCorrect: (String) -> Void
  let onDiscard: (String) -> Void
  @Environment(LoopStore.self) private var loopStore

  private var card: V2ItemCard? {
    loopStore.week?.items.first { $0.id == itemID } ?? loopStore.week?.backlog.first { $0.id == itemID }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        // T6g：整题大图（含全部手写证据），取不到时 FullCropImage 内部退回题干小图。
        FullCropImage(itemID: itemID, caption: "整题裁图 · 双指缩放")
        if let evidence = loopStore.evidence {
          VStack(alignment: .leading, spacing: 10) {
            Text(evidence.questionText).font(.body).foregroundStyle(Palette.ink)
            Text([evidence.subject, evidence.knowledgeTags.joined(separator: "、")].filter { !$0.isEmpty }.joined(separator: " · "))
              .font(.caption).foregroundStyle(Palette.muted)
            ForEach(evidence.observations, id: \.id) { observation in
              VStack(alignment: .leading, spacing: 4) {
                Text(LoopText.observationKind(observation.kind)).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
                Text(observation.text).font(.subheadline).foregroundStyle(Palette.ink)
              }
              .accessibilityIdentifier("detail-observation-\(observation.id)")
            }
          }
        } else {
          ProgressView("正在读取识别结果…")
        }
        if let card {
          HStack(spacing: 12) {
            if LoopText.canDiscard(card.status) {
              Button("不是错题") { onDiscard(card.id) }
                .font(.subheadline).frame(minHeight: 44).foregroundStyle(Palette.muted)
                .accessibilityIdentifier("item-discard-\(card.id)")
            }
            Button("不对，改一下") { onCorrect(card.id) }
              .font(.subheadline.weight(.semibold)).frame(minHeight: 44).foregroundStyle(Palette.teal)
              .accessibilityIdentifier("item-correct-\(card.id)")
          }
        }
      }
      .padding(24)
    }
    .background(Palette.paper)
    .navigationTitle(card?.shortId ?? "题目")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      await loopStore.loadEvidence(itemID: itemID)
    }
  }
}

// MARK: - 录结果入口

/// 录结果页要这份练习的详情：不是当前打开的那份时先取详情（周末 B 录上一份时会走到这里）。
struct PracticeRecordEntry: View {
  let practiceID: String
  @Environment(LoopStore.self) private var store

  var body: some View {
    Group {
      if let practice = store.currentPractice, practice.id == practiceID {
        PracticeReturnView(practice: practice)
      } else if let error = store.lastError {
        Text(error).font(.subheadline).foregroundStyle(CardTone.red.color).padding(24)
      } else {
        Text("正在读取练习…").font(.subheadline).foregroundStyle(Palette.muted)
      }
    }
    .task {
      if store.currentPractice?.id != practiceID { await store.openPractice(id: practiceID) }
    }
  }
}
