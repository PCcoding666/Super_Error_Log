import SwiftUI
import UIKit

// S2：勾选面板——无批改痕迹的页由学生勾出错题。
// 点选或报/输入题号：输入匹配随输入框内容整体重算（PickSelection，S2-R1 起不再只增不减），
// 学生手点的勾上/取消单独记忆；只有勾出的题才精读。
// 候选缩略图只在面板存续期间留在内存，不落盘、不写日志；学生输入的题号不落盘。

struct PhotoPickSheet: View {
  let taskID: UUID
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var speech = SpeechInput()
  @State private var input = ""
  @State private var selection = PickSelection()
  @State private var inputIDs: Set<String> = []
  @State private var missing: [Int] = []
  @State private var submitting = false
  @State private var source: PhotoReference?
  @State private var thumbnails = CandidateImageCache()

  private var task: LocalRecognitionTask? {
    store.state.recognitionTasks.first { $0.id == taskID }
  }
  private var questions: [RecognitionQuestion] { task?.job?.questions ?? [] }
  /// 仍可勾的题（未选）；其余状态显示为已勾选、置灰。
  private var selectable: [RecognitionQuestion] { questions.filter { $0.status == "unselected" } }
  /// 当前勾上的题：输入匹配整体重算 + 学生手点记忆。
  private var checked: Set<String> { selection.checked(inputIDs: inputIDs) }
  private var checkedCount: Int { selectable.filter { checked.contains($0.id) }.count }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          inputSection
          candidateList
          confirmSection
        }.padding(24)
      }
      .background(Palette.paper)
      .navigationTitle("勾出这一页做错的题")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if let task {
          ToolbarItem(placement: .topBarTrailing) {
            Button("看完整原图") {
              source = PhotoReference(url: store.originalURL(task.photoName), title: "完整原图")
            }
            .frame(minWidth: 44, minHeight: 44)
            .accessibilityIdentifier("pick-source")
          }
        }
      }
    }
    .sheet(item: $source) { SourcePhotoView(reference: $0) }
    .onAppear {
      speech.currentText = { input }
      speech.onText = { text in input = text }
      speech.refresh()
      for question in selectable { thumbnails.load(taskID: taskID, questionID: question.id, store: store) }
    }
    .onChange(of: input) { _, text in applyInput(text) }
  }

  // MARK: - 输入区

  private var inputSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField("输入或说出题号，例如 第3题、第7题，或 5到8", text: $input)
        .textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("pick-input")
      SpeechControls(speech: speech, holdIdentifier: "pick-hold-to-talk",
        typeInsteadIdentifier: "pick-type-instead", hintIdentifier: "pick-speech-hint")
      if !missing.isEmpty {
        Text("这页没找到第 \(missing.map(String.init).joined(separator: "、")) 题")
          .font(.caption).foregroundStyle(CardTone.orange.color)
          .accessibilityIdentifier("pick-missing")
      }
    }
  }

  /// 每次输入变化：解析并整体重算匹配的题（可增可减）；学生手点的勾上/取消不受影响。
  private func applyInput(_ text: String) {
    let numbers = QuestionNumberParser.parse(text)
    let result = QuestionNumberParser.match(numbers: numbers,
      candidates: selectable.map { (id: $0.id, number: $0.number) })
    inputIDs = Set(result.ids)
    missing = result.missing
  }

  // MARK: - 候选列表（按服务器返回的顺序）

  private var candidateList: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(questions) { question in
        candidateRow(question)
      }
    }
  }

  @ViewBuilder private func candidateRow(_ question: RecognitionQuestion) -> some View {
    let isSelectable = question.status == "unselected"
    let isChecked = !isSelectable || checked.contains(question.id)
    Button {
      guard isSelectable else { return }
      selection.toggle(question.id, inputIDs: inputIDs)
    } label: {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: isChecked ? "checkmark.circle.fill" : "circle")
          .font(.title3)
          .foregroundStyle(isChecked ? Palette.teal : Palette.muted)
          .frame(width: 44, height: 44)
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            Text(QuestionNumberParser.displayLabel(question.number)).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
            if !isSelectable {
              Text(question.active ? "正在识别" : "已在错题本")
                .font(.caption2.weight(.medium)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Palette.line.opacity(0.4), in: Capsule())
            }
          }
          CandidateThumb(cache: thumbnails, taskID: taskID, questionID: question.id)
            .frame(maxWidth: .infinity, maxHeight: 96, alignment: .leading)
            .clipped()
            .accessibilityHidden(true)
        }
        Spacer(minLength: 0)
      }
      .padding(12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .background(isChecked ? Palette.mint : Palette.card, in: RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(
        isChecked ? Palette.teal : Palette.line.opacity(0.5), lineWidth: isChecked ? 1.5 : 1))
      .contentShape(RoundedRectangle(cornerRadius: 14))
    }
    .buttonStyle(.plain)
    .disabled(!isSelectable)
    .accessibilityLabel("\(QuestionNumberParser.displayLabel(question.number))，\(isChecked ? "已选" : "未选")")
    .accessibilityIdentifier("pick-row-\(question.id)")
  }

  // MARK: - 底部确认

  private var confirmSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let error = store.errorMessage {
        Text(error).font(.subheadline).foregroundStyle(CardTone.red.color)
          .accessibilityIdentifier("pick-error")
      }
      Button(submitting ? "正在提交…" : "把这 \(checkedCount) 道加入错题本") {
        let ids = selectable.filter { checked.contains($0.id) }.map(\.id)
        submitting = true
        Task {
          let ok = await store.selectQuestions(taskID: taskID, questionIDs: ids)
          submitting = false
          if ok { dismiss() }
        }
      }
      .buttonStyle(PrimaryButton())
      .disabled(checkedCount == 0 || submitting)
      .accessibilityIdentifier("pick-confirm")
      Text("只有勾出的题会被识别；AI 不判断你答得对不对。")
        .font(.caption).foregroundStyle(Palette.muted)
    }
  }
}

/// 候选题缩略图：等比缩放、高度不超过 96pt、居左；加载中占位，失败显示「图没加载出来」。
private struct CandidateThumb: View {
  let cache: CandidateImageCache
  let taskID: UUID
  let questionID: String
  @Environment(StudyStore.self) private var store

  var body: some View {
    Group {
      if let image = cache.images[questionID] {
        Image(uiImage: image).resizable().scaledToFit()
      } else if cache.failed.contains(questionID) {
        Text("图没加载出来").font(.caption).foregroundStyle(Palette.muted)
      } else {
        ProgressView().controlSize(.small)
      }
    }
    .onAppear { cache.load(taskID: taskID, questionID: questionID, store: store) }
  }
}

/// 候选缩略图内存缓存：面板存续期间有效，不落盘。同一题只取一次（失败不重试，仍可勾选）。
@MainActor @Observable
final class CandidateImageCache {
  private(set) var images: [String: UIImage] = [:]
  private(set) var failed: Set<String> = []
  private var requested: Set<String> = []

  func load(taskID: UUID, questionID: String, store: StudyStore) {
    guard !requested.contains(questionID) else { return }
    requested.insert(questionID)
    Task {
      let data = await store.candidateImage(taskID: taskID, questionID: questionID)
      if let image = data.flatMap({ UIImage(data: $0) }) {
        images[questionID] = image
      } else {
        failed.insert(questionID)
      }
    }
  }
}

/// 「漏了题？从照片里补选」的列表：每张照片一行（缩略图 + 还有 N 道没选），点进去是勾选面板。
struct MissedPickListSheet: View {
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var pickTask: PickReference?

  private var tasks: [LocalRecognitionTask] {
    PhotoPickReminder.missedTasks(store.state.recognitionTasks)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(tasks) { task in
            let count = PhotoPickReminder.unselectedQuestions(of: task).count
            Button { pickTask = PickReference(taskID: task.id) } label: {
              HStack(spacing: 12) {
                LocalPhotoThumbnail(url: store.photoURL(task.photoName))
                  .frame(width: 48, height: 60).clipped()
                  .accessibilityHidden(true)
                Text("还有 \(count) 道没选").font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink)
                Spacer(minLength: 0)
              }
              .padding(12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
              .background(Palette.card, in: RoundedRectangle(cornerRadius: 14))
              .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Palette.line.opacity(0.5)))
              .contentShape(RoundedRectangle(cornerRadius: 14))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pick-missed-\(task.photoName)")
          }
        }.padding(24)
      }
      .background(Palette.paper)
      .navigationTitle("从照片里补选")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarLeading) { Button("关闭") { dismiss() } } }
    }
    .sheet(item: $pickTask) { PhotoPickSheet(taskID: $0.taskID) }
  }
}

/// sheet(item:) 用的照片任务引用。
struct PickReference: Identifiable {
  var id: UUID { taskID }
  let taskID: UUID
}
