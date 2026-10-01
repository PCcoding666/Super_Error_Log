import SwiftUI

// T6c：修改识别结果面板。上方是当前识别结果；「说一句/写一句」生成修改建议（语音或键盘），
// 「自己动手改」走键盘直改。语音只把文字填进输入框，不自动发送。
// 409（内容已更新）由 LoopStore 重新载入并给提示；限流/生成失败原样显示服务器文案。

struct CorrectionSheet: View {
  let itemID: String
  @Environment(LoopStore.self) private var loopStore
  @Environment(\.dismiss) private var dismiss
  @State private var speech = SpeechInput()
  @State private var instruction = ""
  @State private var usedVoice = false
  @State private var directMode = false
  @State private var directQuestion = ""
  @State private var directSubject = "数学"
  @State private var directTags = ""
  @State private var directObservations: [String: String] = [:]

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          evidenceSection
          if let notice = loopStore.proposalNotice {
            Text(notice).font(.subheadline).foregroundStyle(CardTone.orange.color)
              .accessibilityIdentifier("correction-notice")
          }
          if let clarify = loopStore.clarifyPrompt {
            Text(clarify).font(.subheadline).foregroundStyle(CardTone.orange.color)
              .accessibilityIdentifier("correction-clarify")
          }
          if let error = loopStore.lastError {
            HStack(spacing: 12) {
              Text(error).font(.subheadline).foregroundStyle(CardTone.red.color)
              Spacer(minLength: 0)
              Button("知道了") { loopStore.clearError() }
                .font(.caption).frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("correction-error-dismiss")
            }
            if loopStore.proposalRetryable {
              Button("再试一次（同一请求）") { Task { await loopStore.retryProposal() } }
                .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                .foregroundStyle(Palette.teal)
                .disabled(loopStore.isBusyProposal)
                .accessibilityIdentifier("correction-retry")
            }
          }
          if let proposal = loopStore.proposal {
            proposalSection(proposal)
          } else if directMode {
            directSection
          } else {
            instructionSection
          }
        }.padding(24)
      }
      .background(Palette.paper)
      .navigationTitle("不对，改一下")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarLeading) { Button("关闭") { dismiss() } } }
    }
    .task {
      // 语音回填：SpeechInput 已给出「基底 + 本次整句」，直接替换输入框内容（不追加）。
      speech.currentText = { instruction }
      speech.onText = { text in
        instruction = text
        usedVoice = true
      }
      speech.refresh()
      await loopStore.loadEvidence(itemID: itemID)
      // 等载入完成后显式填充直改输入框（不靠 onChange：从详情页进来时值没变不触发）。
      if let evidence = loopStore.evidence { seedDirect(evidence) }
    }
    // 修改已生效：用 LoopStore 的显式信号关面板（接受/直改成功后识别结果保留并重取）。
    .onChange(of: loopStore.correctionAppliedCount) { _, _ in dismiss() }
  }

  // MARK: - 当前识别结果

  @ViewBuilder private var evidenceSection: some View {
    if let evidence = loopStore.evidence {
      VStack(alignment: .leading, spacing: 10) {
        Text("当前识别结果").font(.headline).foregroundStyle(Palette.ink)
        Text(evidence.questionText).font(.body).foregroundStyle(Palette.ink)
        Text([evidence.subject, evidence.knowledgeTags.joined(separator: "、")].filter { !$0.isEmpty }.joined(separator: " · "))
          .font(.caption).foregroundStyle(Palette.muted)
        ForEach(evidence.observations, id: \.id) { observation in
          VStack(alignment: .leading, spacing: 4) {
            Text(LoopText.observationKind(observation.kind)).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
            Text(observation.text).font(.subheadline).foregroundStyle(Palette.ink)
          }
        }
      }
    } else {
      ProgressView("正在读取识别结果…")
    }
  }

  // MARK: - 说一句 / 写一句

  private var instructionSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("说一句或写一句要改的地方").font(.headline).foregroundStyle(Palette.ink)
      TextField("比如：题目求的是 y 不是 x", text: $instruction, axis: .vertical)
        .lineLimit(2...4)
        .textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("correction-instruction")
      switch speech.presentation {
      case .holdToTalk, .askOnPress:
        HoldToTalkButton(speech: speech, identifier: "correction-hold-to-talk")
        if let hint = speech.hint {
          Text(hint).font(.caption).foregroundStyle(Palette.muted)
            .accessibilityIdentifier("correction-speech-hint")
        }
      case .keyboardOnly:
        Text("可以直接打字").font(.caption).foregroundStyle(Palette.muted)
          .accessibilityIdentifier("correction-type-instead")
      }
      Button("生成修改") {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { await loopStore.proposeCorrection(instruction: text, method: usedVoice ? .voice : .keyboard) }
      }
      .buttonStyle(PrimaryButton())
      .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || loopStore.isBusyProposal)
      .accessibilityIdentifier("correction-generate")
      Button("自己动手改") { directMode = true }
        .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44)
        .foregroundStyle(Palette.teal)
        .accessibilityIdentifier("correction-direct")
    }
  }

  // MARK: - 修改建议：改前 → 改后

  private func proposalSection(_ proposal: V2CorrectionProposal) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      if let clarify = proposal.clarify, !clarify.isEmpty {
        Text(clarify).font(.subheadline).foregroundStyle(CardTone.orange.color)
          .accessibilityIdentifier("correction-clarify")
      }
      ForEach(Array(proposal.changes.enumerated()), id: \.offset) { _, change in
        VStack(alignment: .leading, spacing: 6) {
          Text(fieldLabel(change)).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
          highlightedText(change).font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line.opacity(0.5)))
      }
      Button("接受修改") { Task { await loopStore.acceptProposal() } }
        .buttonStyle(PrimaryButton())
        .disabled(loopStore.isBusyApply)
        .accessibilityIdentifier("correction-accept")
      Button("不改了") { dismiss() }
        .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44)
        .foregroundStyle(Palette.muted)
        .accessibilityIdentifier("correction-cancel")
    }
  }

  private func fieldLabel(_ change: V2CorrectionChange) -> String {
    switch change.field {
    case .questionText: return "题干"
    case .subject: return "学科"
    case .knowledgeTags: return "知识点"
    case .observation:
      let kind = loopStore.evidence?.observations.first { $0.id == change.observationId }?.kind
      return kind.map { LoopText.observationKind($0) } ?? "识别记录"
    case .unknown: return "识别结果"
    }
  }

  /// 用 find/replace 把被替换的片段高亮；找不到时整体对照（由纯逻辑决定）。
  private func highlightedText(_ change: V2CorrectionChange) -> Text {
    var text = Text("")
    for segment in CorrectionHighlight.segments(before: change.before, after: change.after,
      find: change.find, replace: change.replace) {
      switch segment {
      case .plain(let value):
        text = text + Text(value).foregroundStyle(Palette.ink)
      case .removed(let value):
        text = text + Text(value).strikethrough().foregroundStyle(CardTone.red.color)
      case .added(let value):
        text = text + Text(value).fontWeight(.semibold).foregroundStyle(Palette.teal)
      }
    }
    return text
  }

  // MARK: - 自己动手改（键盘直改）

  private var directSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("自己动手改").font(.headline).foregroundStyle(Palette.ink)
      Text("题干").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
      TextEditor(text: $directQuestion)
        .frame(minHeight: 80)
        .padding(6)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line.opacity(0.5)))
        .accessibilityIdentifier("correction-direct-question")
      Text("学科").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
      Picker("学科", selection: $directSubject) {
        Text("数学").tag("数学")
        Text("物理").tag("物理")
        Text("化学").tag("化学")
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("correction-direct-subject")
      Text("知识点（多个用逗号分隔）").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
      TextField("比如：一元一次方程， 移项", text: $directTags)
        .textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("correction-direct-tags")
      if let evidence = loopStore.evidence {
        ForEach(evidence.observations, id: \.id) { observation in
          VStack(alignment: .leading, spacing: 4) {
            Text(LoopText.observationKind(observation.kind)).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
            TextEditor(text: Binding(
              get: { directObservations[observation.id] ?? observation.text },
              set: { directObservations[observation.id] = $0 }))
              .frame(minHeight: 48)
              .padding(6)
              .background(Palette.card, in: RoundedRectangle(cornerRadius: 10))
              .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line.opacity(0.5)))
              .accessibilityIdentifier("correction-direct-observation-\(observation.id)")
          }
        }
      }
      Button("保存修改") {
        guard let evidence = loopStore.evidence else { return }
        let changes = DirectCorrection.changes(evidence: evidence, questionText: directQuestion,
          subject: directSubject, knowledgeTagsText: directTags, observationTexts: directObservations)
        Task { await loopStore.applyDirect(changes: changes) }
      }
      .buttonStyle(PrimaryButton())
      .disabled(loopStore.isBusyApply || directChanges.isEmpty)
      .accessibilityIdentifier("correction-save-direct")
    }
  }

  private var directChanges: [V2CorrectionChange] {
    guard let evidence = loopStore.evidence else { return [] }
    return DirectCorrection.changes(evidence: evidence, questionText: directQuestion,
      subject: directSubject, knowledgeTagsText: directTags, observationTexts: directObservations)
  }

  private func seedDirect(_ evidence: V2Evidence) {
    directQuestion = evidence.questionText
    directSubject = ["数学", "物理", "化学"].contains(evidence.subject) ? evidence.subject : "数学"
    directTags = evidence.knowledgeTags.joined(separator: "，")
    directObservations = Dictionary(uniqueKeysWithValues: evidence.observations.map { ($0.id, $0.text) })
  }
}
