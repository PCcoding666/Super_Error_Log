import SwiftUI
import UIKit

// T6e-w：录结果页（task-6ew-brief §4）。PracticeReturnView(practice:) 独立进入，从环境取 LoopStore。
// 表单规则全部在 ReturnForm（Domain/V2），视图只绑定、不重写规则。
// 掌握判定由服务器完成（§3.15 逐条 ok/reason/error），手机不自行判断掌握。
// 界面只求可用清楚，不做视觉设计。

struct PracticeReturnView: View {
  let practice: V2PracticeDetail
  @Environment(LoopStore.self) private var store
  @State private var form: ReturnForm
  @State private var commonDate: Date
  @State private var submitting = false

  init(practice: V2PracticeDetail) {
    self.practice = practice
    let today = Date()
    _form = State(initialValue: ReturnForm(detail: practice, today: today, calendar: .current))
    _commonDate = State(initialValue: today)
  }

  private static let completionOptions: [(V2Completion, String)] = [
    (.independent, "独立做出"),
    (.hint1, "看了一级提示"),
    (.hint2, "看了二级提示"),
    (.notSolved, "没做出来"),
    (.notDone, "没做"),
  ]

  var body: some View {
    // T6d-w：从主页导航栈推入，去掉内层 NavigationStack；内部「看结果」由主页栈推入回报页。
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        SectionTitle(title: "录结果", subtitle: "几道题纸上做完后，逐题告诉系统结果。")
        Text("当天做对不算掌握，隔 3–7 天独立做对才算。")
          .font(.subheadline.weight(.medium)).foregroundStyle(Palette.teal)
        commonDateCard
        ForEach(form.rows.filter { !$0.isRecorded }) { row in
          rowCard(row)
        }
        recordedSection
        submitSection
        summaryLink
      }.padding(24)
    }
    .background(Palette.paper)
    .navigationTitle("录结果")
    .navigationBarTitleDisplayMode(.inline)
  }

  // MARK: - 共用日期

  private var commonDateCard: some View {
    PaperCard {
      VStack(alignment: .leading, spacing: 8) {
        DatePicker("你是哪天在纸上做的？", selection: $commonDate, in: ...Date(), displayedComponents: .date)
          .accessibilityIdentifier("return-common-date")
        Text("所有题共用这一天；哪天单独做的可以在那道题下面改。")
          .font(.caption).foregroundStyle(Palette.muted)
      }
    }
    .onChange(of: commonDate) { _, date in
      form.setCommonDate(ReturnForm.dayString(date, calendar: .current))
    }
  }

  // MARK: - 逐题卡片

  @ViewBuilder private func rowCard(_ row: ReturnForm.Row) -> some View {
    PaperCard {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 12) {
          ReturnCropThumbnail(itemID: row.itemId)
          VStack(alignment: .leading, spacing: 4) {
            Text(row.shortId ?? "题目").font(.headline).foregroundStyle(Palette.ink)
            if let subject = row.subject {
              Text(subject).font(.caption).foregroundStyle(Palette.muted)
            }
          }
          Spacer(minLength: 0)
        }
        ForEach(Self.completionOptions, id: \.0.rawValue) { option, title in
          ChoiceRow(title: title, isSelected: row.completion == option) {
            form.selectCompletion(option, for: row.itemId)
          }
          .accessibilityIdentifier("return-completion-\(row.itemId)-\(option.rawValue)")
        }
        if needsCorrect(row) {
          HStack(spacing: 12) {
            ChoiceRow(title: "对了", isSelected: row.correct == true) {
              form.setCorrect(true, for: row.itemId)
            }
            .accessibilityIdentifier("return-correct-\(row.itemId)-yes")
            ChoiceRow(title: "错了", isSelected: row.correct == false) {
              form.setCorrect(false, for: row.itemId)
            }
            .accessibilityIdentifier("return-correct-\(row.itemId)-no")
          }
        }
        if row.completion == .notSolved {
          TextField("卡在哪一步（可不填）", text: stuckBinding(for: row.itemId))
            .textFieldStyle(.roundedBorder)
            .frame(minHeight: 44)
            .accessibilityIdentifier("return-stuck-\(row.itemId)")
        }
        HStack(spacing: 8) {
          Text("做题日期：\(form.resolvedDate(row) ?? "—")")
            .font(.caption).foregroundStyle(Palette.muted)
          Spacer(minLength: 0)
          if row.performedOn != nil {
            Button("用共用日期") { form.setPerformedOn(nil, for: row.itemId) }
              .font(.caption).frame(minHeight: 44)
              .accessibilityIdentifier("return-date-reset-\(row.itemId)")
          }
          DatePicker("", selection: performedBinding(for: row), in: ...Date(), displayedComponents: .date)
            .labelsHidden()
            .accessibilityIdentifier("return-date-\(row.itemId)")
        }
        if let error = row.serverError {
          Text(error).font(.caption).foregroundStyle(CardTone.red.color)
            .accessibilityIdentifier("return-error-\(row.itemId)")
        }
      }
    }
  }

  private func needsCorrect(_ row: ReturnForm.Row) -> Bool {
    guard let completion = row.completion else { return false }
    return completion == .independent || completion == .hint1 || completion == .hint2
  }

  private func stuckBinding(for itemId: String) -> Binding<String> {
    Binding(
      get: { form.rows.first { $0.itemId == itemId }?.stuckStep ?? "" },
      set: { form.setStuckStep($0, for: itemId) })
  }

  private func performedBinding(for row: ReturnForm.Row) -> Binding<Date> {
    Binding(
      get: { Self.parseDay(form.resolvedDate(row) ?? form.today) ?? Date() },
      set: { form.setPerformedOn(ReturnForm.dayString($0, calendar: .current), for: row.itemId) })
  }

  /// YYYY-MM-DD → 本机日历日的 Date（供 DatePicker）。
  private static func parseDay(_ text: String) -> Date? {
    let parts = text.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
    return Calendar.current.date(from: DateComponents(year: year, month: month, day: day))
  }

  // MARK: - 已记录

  @ViewBuilder private var recordedSection: some View {
    let recorded = form.rows.filter(\.isRecorded)
    if !recorded.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Eyebrow(text: "已记录")
        ForEach(recorded) { row in
          PaperCard {
            VStack(alignment: .leading, spacing: 4) {
              Text(row.shortId ?? "题目").font(.body.weight(.medium)).foregroundStyle(Palette.ink)
              Text(row.serverReason ?? "已记录").font(.caption).foregroundStyle(Palette.muted)
            }
          }
          .accessibilityIdentifier("return-recorded-\(row.itemId)")
        }
      }
    }
  }

  // MARK: - 提交

  @ViewBuilder private var submitSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button("这次先提交已填的 \(form.completedCount) 道", action: submit)
        .buttonStyle(PrimaryButton())
        .disabled(form.completedCount == 0 || submitting)
        .accessibilityIdentifier("return-submit")
      if submitting { ProgressView("正在提交…") }
      if let error = store.lastError {
        Text(error).font(.subheadline).foregroundStyle(CardTone.red.color)
      }
    }
  }

  /// 提交：服务器逐条判定。ok 的题进"已记录"（显示服务器给的那句话，来自 LoopStore.lastReturnResults）；
  /// 被拒的题留在列表带原因，可改后再提交；本次没发出去的（网络失败，仍在待提交列表且无原因）保持未提交状态。
  private func submit() {
    let entries = form.entries()
    guard !entries.isEmpty, !submitting else { return }
    submitting = true
    let ids = entries.map(\.itemId)
    Task {
      await store.submitReturn(practiceID: practice.id, entries: entries)
      var results: [V2ReturnResult] = []
      for id in ids {
        if let result = store.lastReturnResults.first(where: { $0.itemId == id }) {
          results.append(result)
        } else if let issue = store.returnIssues[id] {
          results.append(V2ReturnResult(itemId: id, ok: false, toStatus: nil, reason: nil, error: issue))
        } else if !store.pendingReturns.contains(where: { $0.itemId == id }) {
          results.append(V2ReturnResult(itemId: id, ok: true, toStatus: nil, reason: nil, error: nil))
        }
      }
      form.applyResults(results)
      submitting = false
    }
  }

  // MARK: - 看结果

  @ViewBuilder private var summaryLink: some View {
    if form.allRecorded {
      Text("这份练习全部录完了。").font(.subheadline).foregroundStyle(Palette.teal)
      NavigationLink("看结果") { PracticeSummaryView(practiceID: practice.id) }
        .buttonStyle(PrimaryButton())
        .accessibilityIdentifier("return-view-summary")
    } else if form.rows.contains(where: \.isRecorded) {
      NavigationLink("看结果") { PracticeSummaryView(practiceID: practice.id) }
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityIdentifier("return-view-summary")
    }
  }
}

/// 裁图缩略图：从 LoopStore 的本地缓存读整题裁图（不走 AsyncImage 直连服务器）。
/// T6e-w 临时放在本文件；主页的同类视图交付后应合并为一个共用视图。
private struct ReturnCropThumbnail: View {
  let itemID: String
  @Environment(LoopStore.self) private var store
  @State private var image: UIImage?

  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: "photo").foregroundStyle(Palette.muted)
      }
    }
    .frame(width: 56, height: 72).clipped()
    .accessibilityHidden(true)
    .task(id: itemID) {
      guard let url = await store.cropFileURL(itemID: itemID) else { return }
      image = await Task.detached { UIImage(contentsOfFile: url.path) }.value
    }
  }
}
