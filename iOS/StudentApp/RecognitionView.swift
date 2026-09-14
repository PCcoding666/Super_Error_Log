import SwiftUI

struct RecognitionView: View {
  let taskID: UUID
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
            NavigationLink { RecognitionQuestionView(taskID: taskID, questionID: question.id) } label: {
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
          Button("刷新已保存的识别进度") { Task { await store.refreshJobs() } }
        }
      }.padding(24)
    }.background(Palette.paper).navigationTitle("照片识别").navigationBarTitleDisplayMode(.inline)
      .sheet(item: $source) { SourcePhotoView(reference: $0) }
      .disabled(store.busyTasks.contains(taskID))
  }
}

struct RecognitionQuestionView: View {
  let taskID: UUID
  let questionID: String
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var source: PhotoReference?
  @State private var originalOpened = false
  @State private var compared = false
  private var task: LocalRecognitionTask? { store.state.recognitionTasks.first { $0.id == taskID } }
  private var question: RecognitionQuestion? { task?.job?.questions.first { $0.id == questionID } }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        if let task, let job = task.job, let question {
          HStack { Text("第 \(question.number) 题").font(.title2.weight(.semibold)); Spacer(); Text(question.statusTitle).foregroundStyle(Palette.teal) }
          LocalPhotoThumbnail(url: store.originalURL(task.photoName)).frame(maxHeight: 240)
          Button("查看完整原图并对照") { openOriginal(task) }
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
              }.font(.caption)
            }
            ForEach(evidence.observations) { observation in
              VStack(alignment: .leading, spacing: 8) {
                Text(observation.label).font(.headline)
                Text(observation.text).textSelection(.enabled)
                Button("在原图中核对") { openOriginal(task) }.font(.caption)
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
          if question.status == "ready", question.canAccept {
            Toggle("我已逐项对照原图，题干、图示和原作记录都准确", isOn: $compared)
              .disabled(!originalOpened || !store.hasCachedDiagrams(job: job, question: question)).accessibilityIdentifier("source-compared")
            Button("确认这道题") { Task { await store.act(taskID: taskID, questionID: questionID, sourceCompared: compared) } }
              .buttonStyle(PrimaryButton()).disabled(!compared || !originalOpened || !store.hasCachedDiagrams(job: job, question: question)).accessibilityIdentifier("confirm-question")
            if !store.hasCachedDiagrams(job: job, question: question) {
              Text("必要图示还未保存在本机，请返回刷新后再对照确认。").font(.caption)
              Button("重新读取题目图示") { Task { await store.refreshMedia(job) } }
                .accessibilityIdentifier("reload-question-media")
            }
          }
          if question.status == "confirmed" { Label("已确认，可去“复盘”回想这道题", systemImage: "checkmark.circle").foregroundStyle(Palette.teal) }
          if question.status == "needs_check" {
            Button("保留待核对，稍后再看") { dismiss() }.accessibilityIdentifier("keep-unclear")
          }
          if question.status == "failed", question.error?.canRecover == true {
            RecoveryButton(title: "重新识别这道题", scope: "这道题") { await store.act(taskID: taskID, questionID: questionID, retry: true) }
          }
          if !question.active, !["confirmed", "skipped"].contains(question.status) {
            Button("暂不处理这道题") { Task { await store.act(taskID: taskID, questionID: questionID, skip: true) } }
              .accessibilityIdentifier("skip-question")
          }
        }
      }.padding(24)
    }.background(Palette.paper).navigationTitle("对照题目").navigationBarTitleDisplayMode(.inline)
      .sheet(item: $source) { reference in
        SourcePhotoView(reference: reference, onViewed: {
          if let task, reference.url == store.originalURL(task.photoName) { originalOpened = true }
        })
      }
      .onChange(of: question?.revision) { _, _ in originalOpened = false; compared = false }
      .disabled(store.busyTasks.contains(taskID))
  }
  private func openOriginal(_ task: LocalRecognitionTask) {
    source = PhotoReference(url: store.originalURL(task.photoName), title: "完整原图 · 第 \(question?.number ?? "") 题")
  }
}

private struct RecoveryButton: View {
  let title: String
  let scope: String
  let action: () async -> Void
  @State private var requested = false
  var body: some View {
    Button(title) { requested = true }.accessibilityIdentifier("request-stage-recovery")
      .alert("重新尝试识别？", isPresented: $requested) {
        Button("重新识别") { Task { await action() } }.accessibilityIdentifier("confirm-stage-recovery")
        Button("暂不重试", role: .cancel) {}
      } message: { Text("只继续处理\(scope)，已完成的内容和历史记录都会保留。此操作会再次请求 AI 服务。") }
  }
}
