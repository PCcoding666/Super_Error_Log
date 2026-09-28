import SwiftUI
import UIKit

struct RecognitionView: View {
  let taskID: UUID
  @Binding var tab: Int
  @Environment(StudyStore.self) private var store
  @State private var markedOnly = false
  @State private var source: PhotoReference?
  private var task: LocalRecognitionTask? { store.state.recognitionTasks.first { $0.id == taskID } }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let task, let job = task.job {
          Text(job.statusTitle).font(.title2.weight(.semibold))
          if job.active { ProgressView("\(job.questions.filter { !$0.active }.count) / \(job.questions.count) 道候选题已处理") }
          Button("查看完整原图") { source = PhotoReference(url: store.originalURL(task.photoName), title: "完整原图") }
            .frame(minHeight: 44)
          Picker("候选范围", selection: $markedOnly) {
            Text("全部候选").tag(false)
            Text("批改标记 / 订正痕迹").tag(true)
          }.pickerStyle(.segmented)
          if let warning = job.inventoryWarnings.first { Text(warning).font(.subheadline).foregroundStyle(Palette.muted) }
          if let error = job.error { Text(error.message).font(.subheadline) }
          if job.phase == "inventory", ["failed", "interrupted"].contains(job.status), job.error?.canRecover == true {
            RecoveryButton(title: "重新识别这张照片", scope: "这张照片") { await store.act(taskID: taskID, questionID: nil, retry: true) }
          }
          ForEach(job.questions.filter { !markedOnly || $0.marked }) { question in
            NavigationLink { RecognitionQuestionView(taskID: taskID, initialQuestionID: question.id, tab: $tab) } label: {
              PaperCard {
                VStack(alignment: .leading, spacing: 10) {
                  HStack { Text("第 \(question.number) 题").font(.headline); Spacer(); Text(question.statusTitle).font(.caption) }
                  if let text = question.evidence?.questionText { Text(text).lineLimit(3).font(.subheadline).foregroundStyle(Palette.ink) }
                  if question.marked { Text("原图有批改标记或订正痕迹").font(.caption).foregroundStyle(Palette.muted) }
                }
              }
            }.buttonStyle(.plain).accessibilityIdentifier("candidate-\(question.id)")
          }
          if let error = task.lastError { Text(error).font(.caption).foregroundStyle(Palette.muted) }
          Button("刷新已保存的识别进度") { Task { await store.refreshJobs() } }.frame(minHeight: 44)
        }
      }.padding(24)
    }.background(Palette.paper).navigationTitle("照片识别").navigationBarTitleDisplayMode(.inline)
      .sheet(item: $source) { SourcePhotoView(reference: $0) }
      .disabled(store.busyTasks.contains(taskID))
  }
}

struct RecognitionQuestionView: View {
  let taskID: UUID
  @Binding var tab: Int
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  /// M1：确认后可「继续下一道待处理」——题号是状态，返回仍回题目列表；题目身份由 SourceBinding 保证。
  @State private var questionID: String
  @State private var source: PhotoReference?
  /// M1：页内原图可读门禁（任务+题目+revision+源图 URL 四元绑定；迟到旧图解码不生效）。
  @State private var gate = InlineSourceGate()
  /// 「我已逐项对照原图」勾选绑定到具体来源身份；换题/revision 变化/加载失败即清除。
  @State private var comparedBinding: SourceBinding? = nil  /// M1 review：放行弹窗呈现时捕获的来源身份；确认时必须与当前绑定一致，并按捕获的 revision 在改动边界校验。
  @State private var releaseContext: SourceBinding? = nil
  @State private var manualReleaseRequested = false
  @State private var reflectionProblem: StudyProblem?

  init(taskID: UUID, initialQuestionID: String, tab: Binding<Int>) {
    self.taskID = taskID
    _questionID = State(initialValue: initialQuestionID)
    _tab = tab
  }

  private var task: LocalRecognitionTask? { store.state.recognitionTasks.first { $0.id == taskID } }
  private var question: RecognitionQuestion? { task?.job?.questions.first { $0.id == questionID } }
  /// 当前来源身份：换题、证据更新（revision 变化）、源图不同都会得到新绑定。
  private var binding: SourceBinding? {
    guard let task, let question else { return nil }
    return SourceBinding(taskID: taskID, questionID: question.id, revision: question.revision,
      url: store.originalURL(task.photoName))
  }
  private var sourceReadable: Bool { binding.map { gate.isReadable($0) } ?? false }
  /// M1：云端模式下连接非 ready 时，确认/放行/重试等需要服务器的操作禁用并说明；回环模式行为不变。
  private var serverBlockReason: String? {
    guard store.pairing?.isCloud == true, let state = store.connectionState, state != .ready else { return nil }
    return "照片和已保存的结果仍可看；连接恢复后才能确认、放行或重试。"
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        if let task, let job = task.job, let question, let binding {
          HStack { Text("第 \(question.number) 题").font(.title2.weight(.semibold)); Spacer(); Text(question.statusTitle).foregroundStyle(Palette.teal) }
          // M1：原图在当前页可读、可原地双指缩放/平移；全屏查看器降级为可选放大入口。
          InlineOriginalPhoto(binding: binding, onStarted: {
            // 每次加载开始（含同绑定重载）：可读、勾选、放行结论一并作废。
            gate.begin(binding)
            comparedBinding = nil
            releaseContext = nil
          }, onResolved: { ok in
            if ok {
              gate.complete(binding)
            } else {
              // 加载失败：可读作废，基于旧可读的勾选与放行结论一并清除。
              gate.fail(binding)
              if comparedBinding == binding { comparedBinding = nil }
              if releaseContext == binding { releaseContext = nil }
            }
          })
          Button("放大查看完整原图") { source = PhotoReference(url: store.originalURL(task.photoName), title: "完整原图 · 第 \(question.number) 题") }
            .frame(minHeight: 44)
            .accessibilityIdentifier("compare-original")
          Text("请对照原图确认是这一题；同一页可能出现相同题号。").font(.caption)
          if let box = question.candidateBox, box.valid {
            DisclosureGroup("查看识别位置") {
              Text("初步定位，尚未核实：左 \(Int(box.x * 100))%，上 \(Int(box.y * 100))%，宽 \(Int(box.width * 100))%，高 \(Int(box.height * 100))%。")
                .font(.caption).accessibilityIdentifier("candidate-position")
            }.font(.caption)
          } else { Text("旧记录没有公开初始定位，请在完整原图核对题目位置。").font(.caption) }
          if let evidence = question.evidence {
            PaperCard {
              VStack(alignment: .leading, spacing: 12) {
                Text("识别的印刷题干").font(.headline)
                Text(evidence.questionText).textSelection(.enabled).lineSpacing(6)
              }
            }
            if let media = question.questionMediaId {
              Button {
                source = PhotoReference(url: store.mediaURL(jobID: job.id, mediaID: media), title: "识别裁剪区域（可能不完整）", role: .crop)
              } label: {
                Label(question.verification?.questionCropComplete == true && question.verification?.questionCropPure == true
                  ? "查看来源区域（含原作痕迹）" : "检查未通过核对的裁剪（以完整原图为准）", systemImage: "viewfinder")
              }.font(.caption).frame(minHeight: 44)
            }
            ForEach(evidence.observations) { observation in
              VStack(alignment: .leading, spacing: 8) {
                Text(observation.label).font(.headline)
                Text(observation.text).textSelection(.enabled)
              }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.peach, in: RoundedRectangle(cornerRadius: 16))
            }
            if question.verification?.diagramSafe == true {
              ForEach(question.diagramMediaIds, id: \.self) { id in
                VStack(alignment: .leading) {
                  Text("待你对照的题目图示").font(.caption)
                  LocalPhotoThumbnail(url: store.mediaURL(jobID: job.id, mediaID: id)).frame(maxHeight: 260)
                }
              }
            }
          } else { Text("题目内容还未识别完成。你仍可查看原图。") }
          if let issue = question.currentIssue {
            PaperCard {
              VStack(alignment: .leading, spacing: 12) {
                Label("先核对这一处", systemImage: "questionmark.circle").font(.headline)
                Text(issue)
                Text("看不清或仍有疑问，就保留待核对；这道题暂不进入复盘和打印。").font(.caption).foregroundStyle(Palette.muted)
              }
            }
          }
          if let serverBlockReason, !["confirmed", "skipped"].contains(question.status) {
            Text(serverBlockReason).font(.caption.weight(.medium)).foregroundStyle(Palette.muted)
              .padding(12).frame(maxWidth: .infinity, alignment: .leading)
              .background(Palette.mint.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
              .accessibilityIdentifier("server-blocked-note")
          }
          if question.status == "ready", question.canAccept {
            let readable = sourceReadable
            let diagramsReady = store.hasCachedDiagrams(job: job, question: question)
            Toggle("我已逐项对照原图，题干、图示和原作记录都准确", isOn: Binding(
              get: { comparedBinding == binding },
              set: { comparedBinding = $0 ? binding : nil }))
              .disabled(!readable || !diagramsReady || serverBlockReason != nil)
              .accessibilityIdentifier("source-compared")
            if !readable {
              Text("原图正在打开或暂时不可用，能看清后才能勾选。").font(.caption).foregroundStyle(Palette.muted)
            }
            if !diagramsReady {
              Text("必要图示还未保存在本机，请返回刷新后再对照确认。").font(.caption)
              Button("重新读取题目图示") { Task { await store.refreshMedia(job) } }
                .frame(minHeight: 44)
                .accessibilityIdentifier("reload-question-media")
            }
            Button("确认这道题") {
              // M1 review：用勾选那一刻捕获的不可变身份（任务/题目/revision），
              // 并与动作发生时的 self.binding 现值重验（不用 body 渲染期冻结的旧值）。
              guard let ack = comparedBinding, ack == self.binding, sourceReadable,
                store.hasCachedDiagrams(job: job, question: question) else { return }
              Task { await store.act(taskID: ack.taskID, questionID: ack.questionID, sourceCompared: true, expectedRevision: ack.revision) }
            }
              .buttonStyle(PrimaryButton())
              .disabled(comparedBinding != binding || !readable || !diagramsReady || serverBlockReason != nil)
              .accessibilityIdentifier("confirm-question")
          }
          if question.status == "confirmed" {
            Label("已确认，可去“复盘”回想这道题", systemImage: "checkmark.circle").foregroundStyle(Palette.teal)
            // M1：确认后双出口——继续下一道待处理（不强迫逐题复盘），或去复盘本题。题目身份与返回路径保留。
            if let next = TaskPresentation.nextActionableQuestion(in: job, after: questionID) {
              Button("继续下一道待处理（第 \(next.number) 题）") {
                questionID = next.id
              }
              .buttonStyle(PrimaryButton())
              .accessibilityIdentifier("continue-next-question")
            }
            if let problem = store.state.problem(job.id + "/" + questionID) {
              Button("去复盘本题") { reflectionProblem = problem }
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityIdentifier("reflect-this-question")
            }
          }
          if question.status == "needs_check" {
            Button("保留待核对，稍后再看") { dismiss() }.frame(minHeight: 44).accessibilityIdentifier("keep-unclear")
            // 人工放行：学生对照原图后主动拍板。原图真实可读（页内解码成功）才出现按钮；
            // 点击后弹确认（明确这是人工放行、AI 没把握），确认后走 manualRelease 通道。
            if sourceReadable, question.evidence != nil {
              Button("我已对照原图，确认放行这道题") {
                releaseContext = binding   // 呈现时捕获：题目 + revision + 源图身份
                manualReleaseRequested = true
              }
                .frame(minHeight: 44)
                .disabled(serverBlockReason != nil)
                .accessibilityIdentifier("manual-release")
                .alert("确认人工放行？", isPresented: $manualReleaseRequested) {
                  Button("确认放行") {
                    // M1 review：确认时与动作发生时的 self.binding 现值逐项重验（题目/revision/源图/任务），
                    // 并要求此刻原图仍可读、必要图示仍在本机；任何一项不符都不发请求。
                    if let context = releaseContext, context == self.binding, sourceReadable,
                      store.hasCachedDiagrams(job: job, question: question) {
                      Task { await store.act(taskID: context.taskID, questionID: context.questionID, sourceCompared: true, manualRelease: true, expectedRevision: context.revision) }
                    } else {
                      store.errorMessage = "这道题的内容已更新，请重新对照后再放行。"
                    }
                    releaseContext = nil
                  }
                    .accessibilityIdentifier("confirm-manual-release")
                  Button("暂不放行", role: .cancel) { releaseContext = nil }
                } message: { Text("AI 没有把握这题的裁图是否完整准确。你刚才已对照过完整原图；确认后这道题将标记为已确认并进入复盘。") }
            } else if question.evidence != nil {
              Text("原图可读后，可选择放行这道题进入复盘。").font(.caption).foregroundStyle(Palette.muted)
            }
          }
          if question.status == "failed", question.error?.canRecover == true {
            if serverBlockReason != nil {
              Text("连接恢复后才能重试。").font(.caption).foregroundStyle(Palette.muted)
            } else {
              RecoveryButton(title: "重新识别这道题", scope: "这道题") { await store.act(taskID: taskID, questionID: questionID, retry: true) }
            }
          }
          if !question.active, !["confirmed", "skipped"].contains(question.status) {
            Button("暂不处理这道题") { Task { await store.act(taskID: taskID, questionID: questionID, skip: true) } }
              .frame(minHeight: 44)
              .accessibilityIdentifier("skip-question")
          }
        }
      }.padding(24)
    }.background(Palette.paper).navigationTitle("对照题目").navigationBarTitleDisplayMode(.inline)
      .sheet(item: $source) { SourcePhotoView(reference: $0) }
      .sheet(item: $reflectionProblem) { ReflectionFlow(problem: $0, tab: $tab) }
      .onAppear { beginBinding() }
      .onChange(of: binding) { _, _ in beginBinding() }
      .onDisappear {
        // 页面消失（返回/切题/覆盖）同样作废勾选与放行结论。
        comparedBinding = nil
        releaseContext = nil
      }
      .disabled(store.busyTasks.contains(taskID))
  }

  /// 换题/revision 变化/源图变化/题目消失 → 重新建立绑定：旧可读、勾选、放行结论立即作废。
  private func beginBinding() {
    guard let binding else {
      comparedBinding = nil
      releaseContext = nil
      return
    }
    gate.begin(binding)
    if comparedBinding != binding { comparedBinding = nil }
    if releaseContext != binding { releaseContext = nil }
  }
}

/// M1：页内可读原图——复用 ZoomablePhoto（双指缩放/平移），按 SourceBinding 身份重建，
/// 不显示旧题旧图；解码成功/失败如实上报给门禁。
private struct InlineOriginalPhoto: View {
  let binding: SourceBinding
  /// 加载开始（含同绑定重载）：父层据此作废可读/勾选/放行结论。
  let onStarted: () -> Void
  let onResolved: (Bool) -> Void
  @State private var image: UIImage?
  @State private var failed = false
  /// 加载定序：写 image 与上报门禁前都必须仍是当前代次，迟到旧图完成一律忽略。
  @State private var sequencer = LoadSequencer<SourceBinding>()
  var body: some View {
    Group {
      if let image {
        ZoomablePhoto(image: image, role: .original)
          .id(binding)
      } else if failed {
        ContentUnavailableView("原图暂时打不开", systemImage: "photo.badge.exclamationmark",
          description: Text("原始照片在本机但暂时无法解码，不会用其他图片替代。"))
      } else {
        ProgressView("正在打开原图…")
      }
    }
    .frame(maxWidth: .infinity).frame(height: 300)
    .clipShape(RoundedRectangle(cornerRadius: 16))
    .task(id: binding) {
      let generation = sequencer.begin(binding)
      image = nil; failed = false            // 换绑/重载：清除旧图与旧结论
      onStarted()
      let decoded = await Task.detached { UIImage(contentsOfFile: binding.url.path) }.value
      // 双重校验：任务被取消（换题）或已有更新的加载接管 → 这次完成作废。
      guard !Task.isCancelled, sequencer.isCurrent(binding, generation: generation) else { return }
      if let decoded { image = decoded; onResolved(true) } else { failed = true; onResolved(false) }
    }
  }
}

private struct RecoveryButton: View {
  let title: String
  let scope: String
  let action: () async -> Void
  @State private var requested = false
  var body: some View {
    Button(title) { requested = true }.frame(minHeight: 44).accessibilityIdentifier("request-stage-recovery")
      .alert("重新尝试识别？", isPresented: $requested) {
        Button("重新识别") { Task { await action() } }.accessibilityIdentifier("confirm-stage-recovery")
        Button("暂不重试", role: .cancel) {}
      } message: { Text("只继续处理\(scope)，已完成的内容和历史记录都会保留。此操作会再次请求 AI 服务。") }
  }
}
