import SwiftUI

// T6d-w：主页「本周练习」整块。
// 出现时与回前台时取练习列表与回报。练习卡的状态句与下一步由 PracticeCardText.make 决定：
// 说说为什么错 → PracticeDetailView；打印/再打印 → PracticePrintView；录结果 → PracticeReturnView；
// 看结果 → PracticeSummaryView。界面只求可用清楚，不做视觉设计。
// 学生端重做第 1 期：路由提到主页（HomeFlow.path + LoopHomeView 的 navigationDestination），
// 练习卡按钮、「今天」清单行、底部下一步按钮推同一套页面。
// T6h：练习卡下方有「选下一份要练的题」（已打印才出现）与「更早的练习」折叠区
// （点一行切换当前显示的练习并取它的回报）。

struct LoopPracticeSection: View {
  @Environment(LoopStore.self) private var store
  @Environment(HomeFlow.self) private var flow
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("本周练习").font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
      content
    }
    // T6j：每次出现（含从打印/录结果等页面返回主页）都重取一次练习与回报，
    // 不只是首次出现和回前台。
    .onAppear { Task { await load() } }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await load() } }
    }
  }

  /// 取练习列表（currentPractice 默认最新一份），随后取这份练习的回报供状态句与摘要使用。
  private func load() async {
    await store.loadPractices()
    if let id = store.currentPractice?.id {
      await store.loadSummary(practiceID: id)
    }
  }

  // MARK: - 练习卡 / 空状态

  @ViewBuilder private var content: some View {
    if let practice = store.currentPractice {
      practiceCard(practice)
      pickNext(practice)
      olderPractices
    } else {
      Text("选 5–8 道，打印出来，隔几天在纸上重做。")
        .font(.subheadline).foregroundStyle(Palette.muted)
      Button("选这周要练的题") { flow.push(.pick) }
        .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
        .foregroundStyle(noCandidates ? Palette.muted : Palette.teal)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.line.opacity(0.5)))
        .buttonStyle(.plain)
        .disabled(noCandidates)
        .accessibilityIdentifier("pick-practice")
      if noCandidates {
        Text("先拍几张错题").font(.caption).foregroundStyle(Palette.muted)
          .accessibilityIdentifier("pick-unavailable")
      }
    }
  }

  /// 周视图已取到且没有任何候选题时，选题按钮不可用。
  private var noCandidates: Bool {
    guard let week = store.week else { return false }
    return week.items.isEmpty && week.backlog.isEmpty
  }

  private func practiceCard(_ practice: V2PracticeDetail) -> some View {
    let summary = store.summaryPracticeID == practice.id ? store.summary : nil
    let card = PracticeCardText.make(detail: practice, summary: summary)
    return VStack(alignment: .leading, spacing: 10) {
      Text(card.statusLine).font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink)
      ForEach(card.steps, id: \.self) { step in
        Button(step.title) { advance(step, practice: practice) }
          .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
          .foregroundStyle(Palette.teal)
          .accessibilityIdentifier(stepIdentifier(step))
      }
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.line.opacity(0.5)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("practice-card")
  }

  private func advance(_ step: PracticeCardText.NextStep, practice: V2PracticeDetail) {
    switch step {
    case .reflect: flow.push(.detail(practice.id))
    case .print, .reprint: flow.push(.print(practice.id))
    case .record: flow.push(.record(practice.id))
    case .viewSummary: flow.push(.summary(practice.id))
    }
  }

  private func stepIdentifier(_ step: PracticeCardText.NextStep) -> String {
    switch step {
    case .reflect: "practice-reflect"
    case .print: "practice-print"
    case .reprint: "practice-reprint"
    case .record: "practice-record"
    case .viewSummary: "practice-summary"
    }
  }

  // MARK: - 选下一份要练的题（T6h §1）

  /// 当前练习已打印（含已录一部分、已录完）时出现：已录完是主要按钮；
  /// 已打印但没录完是次要样式，并提示上一份结果还没录完。
  @ViewBuilder private func pickNext(_ practice: V2PracticeDetail) -> some View {
    let summary = store.summaryPracticeID == practice.id ? store.summary : nil
    let card = PracticeCardText.make(detail: practice, summary: summary)
    if card.canPickNext {
      if card.allRecorded {
        Button("选下一份要练的题") { flow.push(.pick) }
          .buttonStyle(PrimaryButton())
          .accessibilityIdentifier("pick-next-practice")
      } else {
        VStack(alignment: .leading, spacing: 6) {
          Button("选下一份要练的题") { flow.push(.pick) }
            .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(Palette.teal)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.line.opacity(0.5)))
            .buttonStyle(.plain)
            .accessibilityIdentifier("pick-next-practice")
          Text("上一份的结果还没录完，也可以先选下一份")
            .font(.caption).foregroundStyle(Palette.muted)
        }
      }
    }
  }

  // MARK: - 更早的练习（T6h §2）

  /// 练习列表里除当前显示之外的各份；只有一份时不显示。点一行切换成当前练习并取它的回报。
  @ViewBuilder private var olderPractices: some View {
    let others = store.practices.filter { $0.id != store.currentPractice?.id }
    if !others.isEmpty {
      DisclosureGroup("更早的练习（\(others.count)）") {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(others, id: \.id) { practice in
            Button(PracticeCardText.olderLine(practice)) {
              Task {
                await store.openPractice(id: practice.id)
                await store.loadSummary(practiceID: practice.id)
              }
            }
            .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .multilineTextAlignment(.leading)
            .foregroundStyle(Palette.ink)
            .accessibilityIdentifier("older-practice-\(practice.id)")
          }
        }.padding(.top, 8)
      }
      .foregroundStyle(Palette.ink)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("older-practices")
    }
  }
}
