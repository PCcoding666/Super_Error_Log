import SwiftUI
import UIKit

// T6d-w：追问复盘——按 LoopStore 的复盘状态机一屏一件事：问题 → 回答 → 确认 → 提交。
// T6g：回答输入框接「按住说话」（与 CorrectionSheet 同一用法，语音只回填文字、学生仍自己点发送）；
// 顶部题图换整题大图（含全部手写证据，取不到退回题干小图）。
// 硬规则：AI 从不替学生提交复盘；没有学生点「提交复盘」就不产生复盘记录；
// 学生的回答与 AI 归纳不写日志、不落本机缓存。
// 确认页规则全部在 ReflectionForm（Domain/V2），视图只绑定、不重写。
// 界面只求可用清楚，不做视觉设计。

struct FollowupView: View {
  let itemID: String
  @Environment(LoopStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var speech = SpeechInput()
  @State private var answer = ""
  @State private var lastQuestion = ""
  @State private var form = ReflectionForm()
  @State private var submitted = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        cropHeader
        phaseContent
      }.padding(24)
    }
    .background(Palette.paper)
    .navigationTitle("复盘这道题")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      // 语音回填：SpeechInput 已给出「基底 + 本次整句」，直接替换输入框内容（不追加）。
      speech.currentText = { answer }
      speech.onText = { text in answer = text }
      speech.refresh()
      await beginIfNeeded()
    }
    .onChange(of: store.reflectionPhase, initial: true) { old, new in
      if case .waitingAnswer(let question, _) = new { lastQuestion = question }
      if case .confirming(let summary, let cause, let attemptState) = new, !old.isSubmitting {
        buildForm(summary: summary, cause: cause, attemptState: attemptState)
      }
      if case .done = new { markDone() }
    }
  }

  /// 进入即发起追问（服务器幂等：已有未答问题原样返回）；已有进行中状态时原样接上。
  private func beginIfNeeded() async {
    switch store.reflectionPhase {
    case .idle, .done:
      await store.startReflection(itemID: itemID)
    default:
      break
    }
  }

  /// 进入确认页时建表单：有上次复盘记录用「上次的选择」，否则用 AI 建议；都没有则空表单。
  private func buildForm(summary: String?, cause: String?, attemptState: String?) {
    if let record = store.reflectionPreviousRecord {
      form = ReflectionForm(record: record)
    } else {
      form = ReflectionForm(suggestionSummary: summary, suggestedCause: cause, suggestedAttemptState: attemptState)
    }
  }

  private func markDone() {
    guard !submitted else { return }
    submitted = true
    Task {
      try? await Task.sleep(for: .seconds(1))
      dismiss()
    }
  }

  // MARK: - 整题大图（可缩放）

  private var cropHeader: some View {
    FullCropImage(itemID: itemID, maxHeight: 200)
      .accessibilityIdentifier("followup-crop")
  }

  // MARK: - 状态机内容

  @ViewBuilder private var phaseContent: some View {
    switch store.reflectionPhase {
    case .idle:
      if let error = store.lastError {
        PaperCard {
          VStack(alignment: .leading, spacing: 12) {
            Text(error).font(.body).foregroundStyle(Palette.ink)
            Button("再试一次") { Task { await store.startReflection(itemID: itemID) } }
              .buttonStyle(PrimaryButton())
              .disabled(store.isBusyReflection)
              .accessibilityIdentifier("followup-retry")
          }
        }
      } else {
        ProgressView("正在出题…").accessibilityIdentifier("followup-asking")
      }
    case .asking:
      ProgressView("正在出题…").accessibilityIdentifier("followup-asking")
    case .waitingAnswer(let question, _):
      questionSection(question, sending: false)
    case .summarizing:
      questionSection(lastQuestion, sending: true)
    case .confirming, .submitting:
      confirmSection
    case .done:
      Text("记下了").font(.title3.weight(.semibold)).foregroundStyle(Palette.teal)
        .accessibilityIdentifier("reflection-done")
    }
  }

  // MARK: - 问题与回答

  private func questionSection(_ question: String, sending: Bool) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(question).font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("followup-question")
      TextEditor(text: $answer)
        .frame(minHeight: 96)
        .padding(8)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line))
        .disabled(sending)
        .accessibilityIdentifier("followup-answer")
      Text("还能写 \(ReflectionForm.answerRemaining(answer)) 字")
        .font(.caption)
        .foregroundStyle(ReflectionForm.isValidAnswer(answer) || answer.isEmpty ? Palette.muted : CardTone.red.color)
      SpeechControls(speech: speech, holdIdentifier: "followup-hold-to-talk",
        typeInsteadIdentifier: "followup-type-instead", hintIdentifier: "followup-speech-hint")
      if sending {
        ProgressView("AI 在看你的回答…").accessibilityIdentifier("followup-sending")
      }
      if let error = store.lastError {
        Text(error).font(.subheadline).foregroundStyle(CardTone.red.color)
      }
      Button("说完了") {
        let text = answer
        Task { await store.answerFollowup(text) }
      }
      .buttonStyle(PrimaryButton())
      .disabled(!ReflectionForm.isValidAnswer(answer) || sending || store.isBusyReflection)
      .accessibilityIdentifier("followup-send")
      Button("跳过追问，直接选") { store.skipFollowup() }
        .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44)
        .foregroundStyle(Palette.muted)
        .disabled(sending)
        .accessibilityIdentifier("followup-skip")
    }
  }

  // MARK: - 确认页

  private var isSubmitting: Bool {
    if case .submitting = store.reflectionPhase { return true }
    return false
  }

  private var confirmSection: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("确认一下").font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
      summarySection
      choiceSection(title: "当时的状态", options: ReflectionForm.attemptStateOptions,
        selected: form.attemptState, mark: form.attemptStateMark, idPrefix: "reflect-state") {
        form.selectAttemptState($0)
      }
      choiceSection(title: "主要错因", options: ReflectionForm.causeOptions,
        selected: form.cause, mark: form.causeMark, idPrefix: "reflect-cause") {
        form.selectCause($0)
      }
      masterySection
      if !form.missingHints.isEmpty {
        Text(form.missingHints.joined(separator: "；")).font(.caption).foregroundStyle(Palette.muted)
          .accessibilityIdentifier("reflection-missing")
      }
      if let error = store.lastError {
        Text(error).font(.subheadline).foregroundStyle(CardTone.red.color)
      }
      if isSubmitting {
        ProgressView("正在提交…").accessibilityIdentifier("reflection-submitting")
      }
      Button("提交复盘") { submit() }
        .buttonStyle(PrimaryButton())
        .disabled(!form.canSubmit || store.isBusyReflection)
        .accessibilityIdentifier("reflection-submit")
    }
  }

  private var summarySection: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text("AI 的归纳").font(.headline).foregroundStyle(Palette.ink)
        if let mark = form.summaryMark { markBadge(mark) }
      }
      TextField("用一句话写下你错在哪", text: summaryBinding, axis: .vertical)
        .textFieldStyle(.roundedBorder)
        .frame(minHeight: 44)
        .accessibilityIdentifier("reflection-summary")
      Text("\(form.summaryLength)/60")
        .font(.caption)
        .foregroundStyle(form.summaryIsValid ? Palette.muted : CardTone.red.color)
    }
  }

  private var summaryBinding: Binding<String> {
    Binding(get: { form.summary }, set: { form.editSummary($0) })
  }

  private func choiceSection(title: String, options: [String], selected: String?,
    mark: ReflectionForm.Mark?, idPrefix: String, select: @escaping (String) -> Void) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text(title).font(.headline).foregroundStyle(Palette.ink)
        if let mark { markBadge(mark) }
      }
      ForEach(options, id: \.self) { option in
        ChoiceRow(title: option, isSelected: selected == option) { select(option) }
          .accessibilityIdentifier("\(idPrefix)-\(option)")
      }
    }
  }

  private var masterySection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("现在的把握").font(.headline).foregroundStyle(Palette.ink)
      ForEach(Array(ReflectionForm.masteryOptions.enumerated()), id: \.offset) { index, text in
        ChoiceRow(title: "\(index) \(text)", isSelected: form.masteryFeeling == index) {
          form.selectMasteryFeeling(index)
        }
        .accessibilityIdentifier("reflect-mastery-\(index)")
      }
    }
  }

  private func markBadge(_ mark: ReflectionForm.Mark) -> some View {
    Text(mark == .aiSuggestion ? "AI 建议" : "上次的选择")
      .font(.caption2.weight(.medium)).foregroundStyle(Palette.teal)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .background(Palette.teal.opacity(0.12), in: Capsule())
  }

  /// 点一次只发一次请求（LoopStore 忙时按钮禁用且内部拒绝重入）。
  private func submit() {
    guard let submission = form.submission() else { return }
    Task {
      await store.submitReflection(attemptState: submission.attemptState, cause: submission.cause,
        masteryFeeling: submission.masteryFeeling, summary: submission.summary)
    }
  }
}

private extension LoopStore.ReflectionPhase {
  var isSubmitting: Bool {
    if case .submitting = self { return true }
    return false
  }
}
