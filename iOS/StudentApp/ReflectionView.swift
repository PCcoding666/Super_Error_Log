import SwiftUI

struct ReflectionListView: View {
  @Environment(StudyStore.self) private var store
  @Binding var tab: Int
  @State private var selected: StudyProblem?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        Eyebrow(text: "停一停，看一看，再试一次")
        SectionTitle(
          title: "留下这次收获。",
          subtitle:
            "选一道题，回想当时是怎么做的。可以随时停下，稍后再回来。")
        ForEach(store.state.allProblems) { problem in
          if problem.id == SampleProblem.all.first?.id {
            Text("示例练习 · 不计入真实学习进度").font(.headline).padding(.top)
          }
          Button {
            selected = problem
          } label: {
            PaperCard {
              VStack(alignment: .leading, spacing: 16) {
                HStack {
                  Image(systemName: problem.symbol).font(.title2).foregroundStyle(Palette.teal)
                    .frame(width: 48, height: 48).background(
                      Palette.mint, in: RoundedRectangle(cornerRadius: 14))
                  Spacer()
                  Text(status(problem.id)).font(.caption.weight(.medium)).foregroundStyle(
                    Palette.teal)
                }
                VStack(alignment: .leading, spacing: 6) {
                  Text(problem.title).font(.system(.title2, design: .serif, weight: .semibold))
                  Text("\(problem.topic) · 第 \(problem.number) 题").font(.subheadline).foregroundStyle(
                    Palette.muted)
                }
                HStack {
                  Text("\(problem.isExample ? "示例题" : "已确认题目") · \(problem.source)").font(.caption2).foregroundStyle(
                    Palette.muted)
                  Spacer()
                  Image(systemName: "arrow.up.right").foregroundStyle(Palette.teal)
                }
              }
            }
          }.buttonStyle(.plain).accessibilityIdentifier("reflect-\(problem.id)")
        }
        Text("复盘属于你自己，这里没有分数。")
          .font(.caption).foregroundStyle(Palette.muted).padding(.bottom)
      }.padding(24)
    }.background(Palette.paper).navigationTitle("复盘").navigationBarTitleDisplayMode(.inline)
      .sheet(item: $selected) { problem in ReflectionFlow(problem: problem, tab: $tab) }
  }

  private func status(_ id: String) -> String {
    guard let draft = store.state.drafts[id] else { return "准备好就开始" }
    return draft.submittedAt == nil ? "继续草稿" : "复盘已保存"
  }
}

struct ReflectionFlow: View {
  let problem: StudyProblem
  @Binding var tab: Int
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var draft = ReflectionDraft()
  @State private var step = 0
  @State private var finished = false
  @State private var source: PhotoReference?
  @State private var draftSaveFailed = false

  private var prompts: [String] {
    [
      "这次做题时是什么状态？", "下次怎样会更有帮助？", "再做一次时，你有多大把握？",
      "这周还想再看一遍吗？",
    ]
  }
  private var explanations: [String] {
    [
      "先回想第一次尝试，不用看订正答案。",
      "选择最符合真实感受的答案，不必猜应用想听什么。",
      "想象面前是一张新纸，旁边没有解答。",
      "练习包应该帮助你，而不是变成更多作业。",
    ]
  }
  private var canContinue: Bool {
    switch step {
    case 0: draft.attempt != nil
    case 1: draft.takeaway != nil
    case 2: draft.confidence != nil
    default: draft.revisit != nil
    }
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            if finished {
              savedContent
            } else {
              HStack {
                Eyebrow(text: "花一点时间复盘")
                Spacer()
                Text("\(step + 1) / 4").font(.system(.caption, design: .monospaced))
                  .foregroundStyle(Palette.teal)
              }
              HStack(spacing: 6) {
                ForEach(0..<4) { index in
                  Capsule().fill(index <= step ? Palette.teal : Palette.line).frame(height: 4)
                }
              }.accessibilityLabel("第 \(step + 1) 个问题，共 4 个")
              questionContext
              SectionTitle(title: prompts[step], subtitle: explanations[step])
              VStack(spacing: 10) {
                switch step {
                case 0:
                  ForEach(ReflectionOptions.attempts, id: \.self) { title in
                    choice(title, selected: draft.attempt) { draft.attempt = title }
                  }
                case 1:
                  ForEach(ReflectionOptions.takeaways, id: \.self) { title in
                    choice(title, selected: draft.takeaway) { draft.takeaway = title }
                  }
                case 2:
                  ForEach(ReflectionOptions.confidences, id: \.self) { title in
                    choice(title, selected: draft.confidence) { draft.confidence = title }
                  }
                default:
                  ChoiceRow(title: "想再做一次", isSelected: draft.revisit == true) {
                    draft.revisit = true
                    saveDraft()
                  }
                  ChoiceRow(title: "这周先不做", isSelected: draft.revisit == false) {
                    draft.revisit = false
                    saveDraft()
                  }
                  TextField("写给下次的自己（可选）", text: $draft.note, axis: .vertical)
                    .lineLimit(2...4).padding(16).background(
                      .white, in: RoundedRectangle(cornerRadius: 16)
                    )
                    .onChange(of: draft.note) { _, _ in saveDraft() }
                }
              }
            }
          }.padding(24)
        }.id(step).clipped()
        if !finished {
          VStack(spacing: 10) {
            HStack(spacing: 12) {
              if step > 0 {
                Button {
                  step -= 1
                } label: {
                  Image(systemName: "arrow.left").frame(width: 48, height: 52)
                }.accessibilityLabel("上一个问题")
              }
              Button(step == 3 ? "保存复盘" : "继续") {
                if step < 3 {
                  withAnimation { step += 1 }
                } else if store.submit(problem.id, draft: draft) {
                  draftSaveFailed = false
                  withAnimation { finished = true }
                } else {
                  draftSaveFailed = true
                }
              }.buttonStyle(PrimaryButton()).disabled(!canContinue)
                .accessibilityIdentifier(step == 3 ? "Save reflection" : "reflection-next")
            }
            if draftSaveFailed {
              Button("草稿未保存——点按重试") { saveDraft() }.font(.caption)
            } else {
              Text("回答会随进度保存在本机").font(.caption2).foregroundStyle(
                Palette.muted)
            }
          }.padding(.horizontal, 24).padding(.vertical, 12).background(Palette.paper)
        }
      }.background(Palette.paper)
        .navigationTitle("第 \(problem.number) 题").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button(finished ? "完成" : "关闭") { dismiss() }
          }
        }
    }.sheet(item: $source) { SourcePhotoView(reference: $0) }
      .onAppear {
        draft = store.state.drafts[problem.id] ?? ReflectionDraft()
        finished = draft.submittedAt != nil
        if !finished {
          step =
            draft.attempt == nil ? 0 : draft.takeaway == nil ? 1 : draft.confidence == nil ? 2 : 3
        }
      }
  }

  private var savedContent: some View {
    VStack(alignment: .leading, spacing: 24) {
      Image(systemName: "checkmark.seal.fill").font(.system(size: 48)).foregroundStyle(Palette.teal)
        .padding(.top, 30)
      SectionTitle(
        title: "复盘已保存",
        subtitle: "你已经认真想过了。现在选择哪些题值得再试一次。")
      PaperCard {
        VStack(alignment: .leading, spacing: 12) {
          Eyebrow(text: "我的收获")
          Text(ReflectionOptions.displayTitle(for: draft.takeaway ?? "")).font(.title3.weight(.medium))
          Text(
            draft.revisit == true ? "我想再做一次。" : "我暂时不把它加入练习。"
          ).font(.subheadline).foregroundStyle(Palette.muted)
          if !draft.note.isEmpty { Text(draft.note).font(.subheadline) }
        }
      }
      Button("加入练习包") {
        tab = 2
        dismiss()
      }.buttonStyle(PrimaryButton())
      Button("编辑复盘") {
        finished = false
        step = 0
      }.frame(maxWidth: .infinity)
      Button("查看原图") { showOriginal() }.frame(maxWidth: .infinity)
      questionContext
    }
  }

  private var questionContext: some View {
    PaperCard {
      VStack(alignment: .leading, spacing: 12) {
        Text("第 \(problem.number) 题").font(.caption.weight(.bold))
        Button("查看原图") { showOriginal() }.font(.caption.weight(.semibold))
        DisclosureGroup {
          VStack(alignment: .leading, spacing: 16) {
            Text(problem.stem).font(.body).lineSpacing(5).textSelection(.enabled)
            ForEach(Array(problem.diagramPaths.enumerated()), id: \.offset) { index, _ in
              SnapshotDiagram(url: store.diagramURL(problem, index: index), index: index)
            }
            ForEach(problem.observations) { observation in
              VStack(alignment: .leading, spacing: 8) {
                Text(observation.label).font(.headline)
                Text(observation.text).textSelection(.enabled)
              }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.peach, in: RoundedRectangle(cornerRadius: 12))
            }
            if !problem.observations.isEmpty {
              Text("以上是已确认的来源记录，不是你的本次复盘，也不会印入练习题。").font(.caption)
            }
          }.padding(.top, 10)
        } label: { Text("查看题目").font(.subheadline.weight(.medium)) }
        Text(problem.displaySourceNote).font(.subheadline).foregroundStyle(Palette.muted)
          .fixedSize(horizontal: false, vertical: true)
        Text(problem.isExample ? "示例题 · 原题中文保持不变" : "已对照原图确认 · 原题内容保持不变").font(.caption2).foregroundStyle(Palette.muted)
      }
    }
  }

  private func choice(_ title: String, selected: String?, action: @escaping () -> Void) -> some View
  {
    ChoiceRow(title: ReflectionOptions.displayTitle(for: title), isSelected: selected == title) {
      action()
      saveDraft()
      // 点选即推进（第 1–3 问）：短暂停顿让勾选可见，然后自动进入下一问。
      // 期间用户点「上一个问题」则不推进；重复点选同一问的多个选项只推进一次（绝对目标步）。
      if step < 3 {
        let current = step
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(280))
          guard self.step == current else { return }
          withAnimation { self.step = current + 1 }
        }
      }
    }
  }
  private func saveDraft() { draftSaveFailed = !store.updateDraft(problem.id, draft) }
  private func showOriginal() {
    if let url = store.sourceURL(problem) {
      source = PhotoReference(url: url, title: "\(problem.source) · 第 \(problem.number) 题")
    } else {
      store.errorMessage =
        "未包含私有示例照片。请按照 iOS README 中的本机照片设置说明操作。"
    }
  }
}

private struct SnapshotDiagram: View {
  let url: URL?
  let index: Int
  @State private var image: UIImage?
  @State private var loading = true
  var body: some View {
    VStack(alignment: .leading) {
      Text("已确认题目图示").font(.caption)
      if let image {
        Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 280)
          .accessibilityLabel("已确认题目图示 \(index + 1)").accessibilityIdentifier("reflection-diagram-\(index)")
      } else if loading { ProgressView("正在读取本机图示…") }
      else { Text("这张必要图示在本机不可用。请查看完整原图；这里不会以其他图片替代。").font(.caption) }
    }.task(id: url) {
      image = await Task.detached {
        guard let url, let data = try? Data(contentsOf: url), MediaReadability.isReadableJPEG(data) else { return nil as UIImage? }
        return UIImage(data: data)
      }.value
      loading = false
    }
  }
}
