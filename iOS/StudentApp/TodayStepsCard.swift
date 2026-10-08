import SwiftUI

// 学生端重做第 1 期（设计稿 §4.1、§4.9、§3.4）：主页顶部的「今天」卡。
// 周末 A / 周末 B 是步骤清单（做完打勾、当前一步描边写「现在做这个」、每步大约几分钟）；
// 「做完了」「周中」是两种首页状态（§4.9）；没连上时说清楚这一步要谁帮。
// 主页其余部分（连接、拍照、照片进度、本周错题、本周练习）第 1 期原样留在这张卡下面。

/// 把今天已有的状态交给 WeekPlan（只读，不新增任何持久化字段）。
@MainActor
enum TodayPlan {
  static func input(store: StudyStore, loopStore: LoopStore, skipped: Set<WeekPlan.StepKind>,
    now: Date = Date()) -> WeekPlan.Input {
    WeekPlan.Input(connection: connection(store: store, loopStore: loopStore),
      weekKey: loopStore.week?.week,
      weekPhotoJobIDs: loopStore.week?.photos.map(\.jobId) ?? [],
      weekItemCount: loopStore.week?.items.count ?? 0,
      localPhotos: localPhotos(store: store, weekJobIDs: Set(loopStore.week?.photos.map(\.jobId) ?? [])),
      practices: practices(loopStore),
      preparingPrintID: preparingPrintID(loopStore),
      skipped: skipped, today: now, calendar: .current)
  }

  static func plan(store: StudyStore, loopStore: LoopStore, skipped: Set<WeekPlan.StepKind>) -> WeekPlan.Result {
    WeekPlan.make(input(store: store, loopStore: loopStore, skipped: skipped))
  }

  private static func connection(store: StudyStore, loopStore: LoopStore) -> WeekPlan.Connection {
    guard store.pairing != nil else { return .unpaired }
    switch store.connectionState {
    case .unpaired: return .unpaired
    case .unauthorized: return .unauthorized
    case .incompatible: return .incompatible
    case .busy: return .busy
    case .failed: return .failed
    default: return loopStore.weekIssue == .offline ? .offline : .ok
    }
  }

  /// 本周的本机照片：还没走完识别流程的（与「照片进度」同一套判断），按导入顺序编号；
  /// 已识别完成的看周视图里的 photos，只用来让编号和周视图对得上。
  private static func localPhotos(store: StudyStore, weekJobIDs: Set<String>) -> [WeekPlan.LocalPhoto] {
    var number = 0
    var photos: [WeekPlan.LocalPhoto] = []
    for name in store.state.importedPhotos {
      let task = store.state.recognitionTasks.first { $0.photoName == name }
      let uploading = task.map { store.busyTasks.contains($0.id) && $0.job == nil } ?? false
      let state = WeekPlan.localState(task: task, uploading: uploading)
      let registeredThisWeek = task?.job.map { weekJobIDs.contains($0.id) } ?? false
      guard state != nil || registeredThisWeek else { continue }
      number += 1
      if let state {
        photos.append(WeekPlan.LocalPhoto(number: number, taskID: task?.id, jobID: task?.job?.id, state: state))
      }
    }
    return photos
  }

  /// 练习列表（新的在前），有详情 / 回报的那一份补上已说过、已录的数目。
  /// 刚建的练习还没进列表、或离线只有缓存的详情时，当前练习就是最新的一份。
  private static func practices(_ loopStore: LoopStore) -> [WeekPlan.Practice] {
    let current = loopStore.currentPractice
    let report = loopStore.summary
    func make(id: String, week: String, generatedAt: Date?, itemCount: Int, slot: String?, status: String?) -> WeekPlan.Practice {
      let detail = current?.id == id ? current : nil
      let summary = loopStore.summaryPracticeID == id ? report : nil
      return WeekPlan.Practice(id: id, week: week, generatedAt: detail?.generatedAt ?? generatedAt,
        itemCount: summary?.total ?? detail?.items.count ?? itemCount, practiceSlot: slot,
        reflectedCount: detail.map { $0.items.filter(\.reflected).count },
        answered: summary?.answered, independentCorrect: summary?.independentCorrect, status: status)
    }
    var list = loopStore.practices.map {
      make(id: $0.id, week: $0.week, generatedAt: $0.generatedAt, itemCount: $0.itemCount,
        slot: $0.practiceSlot, status: $0.status)
    }
    if let current, !list.contains(where: { $0.id == current.id }) {
      list.insert(make(id: current.id, week: current.week, generatedAt: current.generatedAt,
        itemCount: current.items.count, slot: current.practiceSlot, status: current.status), at: 0)
    }
    return list
  }

  private static func preparingPrintID(_ loopStore: LoopStore) -> String? {
    if case .preparing = loopStore.printPhase { return loopStore.currentPractice?.id }
    return nil
  }
}

struct TodayStepsCard: View {
  let result: WeekPlan.Result
  /// 做题时间（练习纸上的 practiceSlot；没有时用设置里的）。
  let practiceSlot: String?
  /// 没联网时那一行（「没联网，显示的是 14:20 保存的内容」）；nil = 联网正常。
  let offlineNote: String?
  let perform: (NextStepAction) -> Void

  /// 与练习纸封面三条规则同一说法（printService.ts 55 行）。
  private static let paperRules = "做的时候：不看答案，独立做；卡住先看一级提示，再看二级；做完打勾，写上做题日期。"

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("今天").font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
      if let offlineNote {
        Text(offlineNote).font(.caption).foregroundStyle(Palette.muted)
          .accessibilityIdentifier("today-offline")
      }
      content
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.line.opacity(0.5)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("today-card")
  }

  @ViewBuilder private var content: some View {
    switch result.stage {
    case .connect(let reason):
      connectContent(reason)
    case .loading:
      Text(offlineNote == nil ? "正在读取…" : "没联网，连上后再看今天要做什么")
        .font(.subheadline).foregroundStyle(Palette.muted)
        .accessibilityIdentifier("today-loading")
    case .done:
      doneContent
    case .midweek:
      midweekContent
    case .weekendA, .weekendB:
      checklist
    }
  }

  // MARK: - 先连上（§4.2 的文案；连接页本身是第 2 期）

  @ViewBuilder private func connectContent(_ reason: WeekPlan.ConnectReason) -> some View {
    let (title, detail): (String, String) = switch reason {
    case .unpaired:
      ("先连上服务器", "这一步要大人帮一下：请帮你装 App 的人打开配对二维码，你点下面的按钮扫一下。只要做一次。")
    case .unauthorized:
      ("需要重新扫码", "连接过期了。请帮你装 App 的人给你一个新的二维码。照片和错题都还在。")
    case .incompatible:
      ("App 和服务器对不上", "请帮你装 App 的人更新 App，或者给你一个新的二维码。")
    }
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.headline).foregroundStyle(Palette.ink)
      Text(detail).font(.subheadline).foregroundStyle(Palette.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("today-connect")
  }

  // MARK: - 做完了 / 周中（§4.9）

  private var doneContent: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label {
        Text("这周的事做完了").font(.headline).foregroundStyle(Palette.ink)
      } icon: {
        Image(systemName: "checkmark.circle.fill").foregroundStyle(CardTone.green.color)
      }
      .accessibilityIdentifier("today-done-title")
      Text("把练习纸带回学校，\(practiceSlot ?? "过几天")在纸上做。")
        .font(.subheadline).foregroundStyle(Palette.ink)
      Text(Self.paperRules).font(.subheadline).foregroundStyle(Palette.ink)
        .fixedSize(horizontal: false, vertical: true)
      Text("下个周末打开 App，录一下做的结果。").font(.subheadline).foregroundStyle(Palette.muted)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("today-done")
  }

  private var midweekContent: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("现在是在纸上做练习的时候").font(.headline).foregroundStyle(Palette.ink)
        .accessibilityIdentifier("today-midweek-title")
      if let practice = result.practice {
        Text(["练习纸：\(practice.itemCount) 道", practiceSlot].compactMap { $0 }.joined(separator: " · "))
          .font(.subheadline).foregroundStyle(Palette.ink)
      }
      Text(Self.paperRules).font(.subheadline).foregroundStyle(Palette.ink)
        .fixedSize(horizontal: false, vertical: true)
      Text("没做完也没关系，周末回来再录。当天做对不算真会，隔几天再做对才算，所以别急着对答案。")
        .font(.subheadline).foregroundStyle(Palette.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("today-midweek")
  }

  // MARK: - 步骤清单（§4.1）

  private var checklist: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(result.header).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
          .accessibilityIdentifier("today-header")
        Spacer(minLength: 8)
        Text("\(result.steps.filter(\.isDone).count)/\(result.steps.count)")
          .font(.caption).foregroundStyle(Palette.muted)
      }
      ForEach(Array(result.steps.enumerated()), id: \.element.kind) { index, step in
        row(step, index: index, isCurrent: index == result.currentIndex)
      }
    }
  }

  private func row(_ step: WeekPlan.Step, index: Int, isCurrent: Bool) -> some View {
    Button { if let action = step.action { perform(action) } } label: {
      HStack(alignment: .top, spacing: 12) {
        ZStack {
          Circle().fill(step.isDone ? CardTone.green.color.opacity(0.15) : (isCurrent ? Palette.teal : Palette.mint))
          if step.isDone {
            Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(CardTone.green.color)
          } else {
            Text("\(index + 1)").font(.caption.weight(.bold))
              .foregroundStyle(isCurrent ? Palette.onTeal : Palette.ink)
          }
        }
        .frame(width: 26, height: 26)
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(step.title).font(.subheadline.weight(.semibold))
              .foregroundStyle(step.isDone ? Palette.muted : Palette.ink)
            if step.isOptional, !step.isDone {
              Text("可跳过").font(.caption2.weight(.medium)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Palette.mint, in: Capsule())
            }
            if isCurrent {
              Text("现在做这个").font(.caption2.weight(.semibold)).foregroundStyle(Palette.teal)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Palette.teal.opacity(0.12), in: Capsule())
            }
          }
          HStack(spacing: 0) {
            Text(step.detail).foregroundStyle(detailColor(step))
            if let warning = step.warning {
              Text(" · ").foregroundStyle(Palette.muted)
              Text(warning).foregroundStyle(CardTone.orange.color)
            }
          }
          .font(.caption)
          .multilineTextAlignment(.leading)
        }
        Spacer(minLength: 4)
        if step.isDone {
          EmptyView()
        } else {
          Text("约 \(step.minutes) 分钟").font(.caption2).foregroundStyle(Palette.muted)
        }
        if step.action != nil {
          Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 9)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(isCurrent ? Palette.teal : Color.clear, lineWidth: 1.5))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(step.action == nil)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(rowLabel(step, index: index, isCurrent: isCurrent))
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("today-step-\(step.kind.rawValue)")
  }

  private func detailColor(_ step: WeekPlan.Step) -> Color {
    switch step.tone {
    case .gray: Palette.muted
    case .green: Palette.muted
    case .blue, .orange, .red: step.tone.color
    }
  }

  /// VoiceOver：「第 2 步，勾出做错的题，现在做这个」（§7.6）。
  private func rowLabel(_ step: WeekPlan.Step, index: Int, isCurrent: Bool) -> String {
    var parts = ["第 \(index + 1) 步", step.title]
    if step.isDone { parts.append("做完了") }
    if isCurrent { parts.append("现在做这个") }
    parts.append(step.detail)
    if let warning = step.warning { parts.append(warning) }
    return parts.joined(separator: "，")
  }
}
