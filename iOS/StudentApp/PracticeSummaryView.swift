import SwiftUI

// T6e-w：回报页（task-6ew-brief §5）。PracticeSummaryView(practiceID:) 独立进入（宿主需包一层
// NavigationStack；从录结果页进入时由录结果页的导航栈推入），从环境取 LoopStore。
// 内容全部来自 GET /v2/practice/:id/summary（§3.16）：掌握/再练分组、校准句、下次确认日期，
// 手机不做任何掌握判定。语气就事论事，不夸张、不打分。界面只求可用清楚，不做视觉设计。

struct PracticeSummaryView: View {
  let practiceID: String
  @Environment(LoopStore.self) private var store
  @Environment(StudyStore.self) private var studyStore
  @Environment(HomeFlow.self) private var flow

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        // T6d-w：summary 按练习包区分——别的练习的回报不得在此显示。
        if let summary = store.summary, store.summaryPracticeID == practiceID {
          summaryContent(summary)
        } else if let error = store.lastError {
          SectionTitle(title: "这次的结果", subtitle: "")
          PaperCard {
            VStack(alignment: .leading, spacing: 12) {
              Text(error).font(.body).foregroundStyle(Palette.ink)
              Button("再试一次") { Task { await store.loadSummary(practiceID: practiceID) } }
                .buttonStyle(PrimaryButton())
                .accessibilityIdentifier("summary-retry")
            }
          }
        } else {
          ProgressView("正在读取结果…").accessibilityIdentifier("summary-loading")
        }
      }.padding(24)
    }
    .background(Palette.paper)
    .safeAreaInset(edge: .bottom, spacing: 0) { NextStepBar(model: nextStep, perform: flow.perform) }
    .navigationTitle("这次的结果")
    .navigationBarTitleDisplayMode(.inline)
    .task { await store.loadSummary(practiceID: practiceID) }
  }

  @ViewBuilder private func summaryContent(_ summary: V2ReturnSummary) -> some View {
    SectionTitle(
      title: "这次的结果",
      subtitle: "记录了 \(summary.answered) / \(summary.total) 道，其中独立做对 \(summary.independentCorrect) 道。")

    if !summary.masteredNow.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Eyebrow(text: "这次掌握的")
        ForEach(summary.masteredNow, id: \.id) { item in
          itemCard(shortId: item.shortId, subject: item.subject, knowledgeTags: item.knowledgeTags, reason: nil)
            .accessibilityIdentifier("summary-mastered-\(item.id)")
        }
      }
    }

    // T6h §4：当天独立做对、还要隔几天再验证的题（§3.16 pending），显示服务器给的 reason。
    if !summary.pending.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Eyebrow(text: "做对了，过几天再验证")
        ForEach(summary.pending, id: \.id) { item in
          itemCard(shortId: item.shortId, subject: item.subject, knowledgeTags: item.knowledgeTags, reason: item.reason)
            .accessibilityIdentifier("summary-pending-\(item.id)")
        }
      }
    }

    if !summary.again.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Eyebrow(text: "还要再练的")
        ForEach(summary.again, id: \.id) { item in
          itemCard(shortId: item.shortId, subject: item.subject, knowledgeTags: item.knowledgeTags, reason: item.reason)
            .accessibilityIdentifier("summary-again-\(item.id)")
        }
      }
    }

    // T6h §4：三组都为空且已录过题时不留空白页。
    if summary.masteredNow.isEmpty, summary.pending.isEmpty, summary.again.isEmpty, summary.answered > 0 {
      PaperCard {
        Text("这次的结果已记下").font(.body).foregroundStyle(Palette.ink)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("summary-recorded")
    }

    if let text = summary.calibration.text {
      PaperCard {
        VStack(alignment: .leading, spacing: 8) {
          Text(text).font(.body).foregroundStyle(Palette.ink)
          let shortIds = summary.calibration.items.compactMap(\.shortId)
          if !shortIds.isEmpty {
            Text(shortIds.joined(separator: "、")).font(.caption).foregroundStyle(Palette.muted)
          }
        }
      }
      .accessibilityIdentifier("summary-calibration")
    }

    if let next = summary.nextConfirmOn {
      PaperCard {
        VStack(alignment: .leading, spacing: 8) {
          Text("下次确认：\(next)").font(.body.weight(.medium)).foregroundStyle(Palette.ink)
          Text("到时候会再放进你的练习里。").font(.caption).foregroundStyle(Palette.muted)
        }
      }
      .accessibilityIdentifier("summary-next-confirm")
    }
  }

  /// 第 1 期：结果页不再是死胡同。周末 B 录完后直接给今天的下一步（如「下一步：勾出做错的题」）；
  /// 下一步还要等（AI 在找题）、或者就是这份的录结果、或者今天没有下一步时，「回到今天」。
  private var nextStep: NextStepModel {
    let plan = TodayPlan.plan(store: studyStore, loopStore: store, skipped: flow.skipped)
    if let index = plan.currentIndex, let next = plan.next, let primary = next.primary, next.isEnabled,
      primary.action != .record(practiceID: practiceID), primary.action != .summary(practiceID: practiceID) {
      return NextStepModel(caption: next.caption,
        primary: .init(title: "下一步：\(plan.steps[index].title)", systemImage: primary.systemImage,
          action: primary.action))
    }
    return NextStepModel(caption: "", primary: .init(title: "回到今天", systemImage: "house", action: .goHome))
  }

  private func itemCard(shortId: String?, subject: String?, knowledgeTags: [String], reason: String?) -> some View {
    PaperCard {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(shortId ?? "题目").font(.body.weight(.medium)).foregroundStyle(Palette.ink)
          if let subject, !subject.isEmpty {
            Text(subject).font(.caption).foregroundStyle(Palette.muted)
          }
        }
        if !knowledgeTags.isEmpty {
          Text(knowledgeTags.joined(separator: "、")).font(.caption).foregroundStyle(Palette.muted)
        }
        if let reason {
          Text(reason).font(.caption).foregroundStyle(Palette.muted)
        }
      }
    }
  }
}
