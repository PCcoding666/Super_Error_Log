import SwiftUI

// T6e-w：回报页（task-6ew-brief §5）。PracticeSummaryView(practiceID:) 独立进入（宿主需包一层
// NavigationStack；从录结果页进入时由录结果页的导航栈推入），从环境取 LoopStore。
// 内容全部来自 GET /v2/practice/:id/summary（§3.16）：掌握/再练分组、校准句、下次确认日期，
// 手机不做任何掌握判定。语气就事论事，不夸张、不打分。界面只求可用清楚，不做视觉设计。

struct PracticeSummaryView: View {
  let practiceID: String
  @Environment(LoopStore.self) private var store

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        if let summary = store.summary {
          summaryContent(summary)
        } else if let error = store.lastError {
          SectionTitle(title: "练习回报", subtitle: "")
          PaperCard {
            VStack(alignment: .leading, spacing: 12) {
              Text(error).font(.body).foregroundStyle(Palette.ink)
              Button("再试一次") { Task { await store.loadSummary(practiceID: practiceID) } }
                .buttonStyle(PrimaryButton())
                .accessibilityIdentifier("summary-retry")
            }
          }
        } else {
          ProgressView("正在读取回报…").accessibilityIdentifier("summary-loading")
        }
      }.padding(24)
    }
    .background(Palette.paper)
    .navigationTitle("练习回报")
    .navigationBarTitleDisplayMode(.inline)
    .task { await store.loadSummary(practiceID: practiceID) }
  }

  @ViewBuilder private func summaryContent(_ summary: V2ReturnSummary) -> some View {
    SectionTitle(
      title: "练习回报",
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

    if !summary.again.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Eyebrow(text: "还要再练的")
        ForEach(summary.again, id: \.id) { item in
          itemCard(shortId: item.shortId, subject: item.subject, knowledgeTags: item.knowledgeTags, reason: item.reason)
            .accessibilityIdentifier("summary-again-\(item.id)")
        }
      }
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
