import SwiftUI

// T6d-w：主页「本周练习」整块（含底部「上一份练习的结果」摘要）。
// 练习相关的状态、导航、刷新全部在本视图内：出现时与回前台时取练习列表与回报，
// 自己管理 navigationDestination。练习卡的状态句与下一步由 PracticeCardText.make 决定：
// 去复盘 → PracticeDetailView；打印/再打印 → PracticePrintView；录结果 → PracticeReturnView；
// 看结果 → PracticeSummaryView。界面只求可用清楚，不做视觉设计。

struct LoopPracticeSection: View {
  @Environment(LoopStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var route: Route?

  /// 从主页导航栈推入的练习页面。
  private enum Route: Hashable {
    case pick
    case detail(String)
    case print(String)
    case record(String)
    case summary(String)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("本周练习").font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
      content
      previousResult
    }
    .task { await load() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await load() } }
    }
    .navigationDestination(item: $route) { route in
      switch route {
      case .pick:
        PracticePickView()
      case .detail(let practiceID):
        PracticeDetailView(practiceID: practiceID)
      case .print(let practiceID):
        PracticePrintView(practiceID: practiceID)
      case .record(let practiceID):
        if let practice = store.currentPractice, practice.id == practiceID {
          PracticeReturnView(practice: practice)
        } else {
          Text("正在读取练习…").font(.subheadline).foregroundStyle(Palette.muted)
        }
      case .summary(let practiceID):
        PracticeSummaryView(practiceID: practiceID)
      }
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
    } else {
      Text("选 5–8 道，打印出来，隔几天在纸上重做。")
        .font(.subheadline).foregroundStyle(Palette.muted)
      Button("选这周要练的题") { route = .pick }
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
    .accessibilityIdentifier("practice-card")
  }

  private func advance(_ step: PracticeCardText.NextStep, practice: V2PracticeDetail) {
    switch step {
    case .reflect: route = .detail(practice.id)
    case .print, .reprint: route = .print(practice.id)
    case .record: route = .record(practice.id)
    case .viewSummary: route = .summary(practice.id)
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

  // MARK: - 上一份练习的结果摘要

  @ViewBuilder private var previousResult: some View {
    if let id = store.summaryPracticeID, let summary = store.summary, summary.answered > 0 {
      HStack(spacing: 12) {
        Text("上一次练习：录了 \(summary.answered)/\(summary.total) 道，独立做对 \(summary.independentCorrect) 道。")
          .font(.caption).foregroundStyle(Palette.muted)
        Spacer(minLength: 0)
        Button("看详情") { route = .summary(id) }
          .font(.caption.weight(.semibold)).frame(minWidth: 44, minHeight: 44)
          .foregroundStyle(Palette.teal)
          .accessibilityIdentifier("practice-summary-detail")
      }
      .accessibilityIdentifier("practice-previous-result")
    }
  }
}
