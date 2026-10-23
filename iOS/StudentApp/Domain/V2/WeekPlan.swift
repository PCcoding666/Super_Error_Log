import Foundation

// 学生端重做第 1 期（设计稿 2026-10-06 §3.2–3.5、§4.0、§4.9）：
// 「现在处在一周的哪段、今天的步骤、下一步按钮」全部由这个纯函数从现有状态算出来。
// 输入只用今天已有的东西（配对与连接状态、周视图、本机照片与识别任务、练习列表/详情/回报、手机时钟），
// 不新增任何持久化字段；两处「跳过」只在本次打开内记在内存里（由调用方传入）。

/// 下一步按钮与清单行能做的事。视图层把它翻译成导航或主页上的现有动作（拍照、勾选面板、上传）。
enum NextStepAction: Hashable, Sendable {
  /// 未登录：打开邀请码登录页（旧扫码配对是登录页里的次要入口）。
  case scan
  /// 登录失效 / 版本不一致：先清凭据，再打开登录页。
  case rescan
  /// 拍照（真机打开系统相机；没有相机的设备打开相册）。
  case capture
  /// 「这周没发卷子，跳过」：只记在内存里。
  case skipShoot
  /// 照片还在手机上：上传（第一次会先弹上传说明）。
  case uploadPending
  /// 打开某张照片的勾选面板。
  case openPick(taskID: UUID)
  /// 选这周要练的题。
  case choose
  /// 说说为什么错（练习详情）。
  case why(practiceID: String)
  /// 「跳过，直接打印」：记在内存里并去打印。
  case skipWhy(practiceID: String)
  /// 打印练习纸。
  case print(practiceID: String)
  /// 录练习纸的结果。
  case record(practiceID: String)
  /// 「先跳过，下次再录」：只记在内存里。
  case skipRecord
  /// 看这次的结果。
  case summary(practiceID: String)
  /// 回到今天（首页）。
  case goHome

  /// 界面稳定标识用的短名（`next-step-secondary-<key>`、`today-step-…`）。
  var key: String {
    switch self {
    case .scan: "scan"
    case .rescan: "rescan"
    case .capture: "capture"
    case .skipShoot: "skipShoot"
    case .uploadPending: "upload"
    case .openPick: "openPick"
    case .choose: "choose"
    case .why: "why"
    case .skipWhy: "skipWhy"
    case .print: "print"
    case .record: "record"
    case .skipRecord: "skipRecord"
    case .summary: "summary"
    case .goHome: "goHome"
    }
  }

  /// 是否要连服务器才能做（没联网 / 服务器忙 / 连不上时变灰）。拍照与两种「跳过」只在手机上。
  var needsServer: Bool {
    switch self {
    case .capture, .skipShoot, .skipRecord, .goHome, .scan, .rescan: false
    default: true
    }
  }
}

/// 底部固定的下一步按钮（设计稿 §4.0）：上面一行小字，下面一个主按钮，旁边可有次要按钮。
/// 主按钮可以没有（「做完了」「周中」两种首页状态是有意不给主按钮的，§4.9）。
struct NextStepModel: Equatable, Sendable {
  struct Choice: Equatable, Sendable {
    let title: String
    let systemImage: String?
    let action: NextStepAction
  }

  let caption: String
  let primary: Choice?
  /// 主按钮可不可点（等待 AI 或没联网时不可点）。
  let isEnabled: Bool
  /// 等待 AI：主按钮带转圈、不可点。
  let isWaiting: Bool
  let secondary: [Choice]

  init(caption: String, primary: Choice?, isEnabled: Bool = true, isWaiting: Bool = false, secondary: [Choice] = []) {
    self.caption = caption
    self.primary = primary
    self.isEnabled = isEnabled
    self.isWaiting = isWaiting
    self.secondary = secondary
  }
}

enum WeekPlan {

  // MARK: - 常量（试用后可调）

  /// 「距练习纸生成几天」三档阈值（§3.2）：≤ 1 天「做完了」，2–4 天「周中」，≥ 5 天「下个周末」。
  enum Threshold {
    static let doneMaxDays = 1
    static let midweekMaxDays = 4
    /// 上一份练习纸生成后超过这么多天还没录完：录结果那行写明是哪天的那一份（§3.4「两周没打开」）。
    static let staleRecordDays = 12
    /// 选了题还没生成练习纸的那份，跨进新的 ISO 周后还算「这周的练习」的天数（周日选、周一打开仍提示打印）；
    /// 更久的不再算，也不让「拍这周的卷子」显示为做完。
    static let unprintedCarryDays = 2
  }

  /// 每步大约几分钟（§3.5，估计值，试用后按真实耗时校准）。
  static func minutes(_ kind: StepKind) -> Int {
    switch kind {
    case .shoot: 2
    case .record: 3
    case .pick: 3
    case .choose: 1
    case .why: 5
    case .print: 2
    }
  }

  // MARK: - 输入

  enum StepKind: String, CaseIterable, Hashable, Sendable {
    case shoot, record, pick, choose, why, print
  }

  enum Connection: Equatable, Sendable {
    /// 正常（含「等待检查」「正在检查」）。
    case ok
    case unpaired, unauthorized, incompatible
    case offline, busy, failed
  }

  /// 一张还没走完识别流程的本机照片（已识别完成的看周视图里的 photos）。
  struct LocalPhoto: Equatable, Sendable {
    enum State: Equatable, Sendable {
      /// 还在手机上，没上传（等同意或等连接）。
      case notUploaded
      case uploading
      /// AI 正在找题 / 读题。
      case finding
      /// 这页没有批改痕迹，要他自己勾。
      case needsPick
      /// 没认出来（整张或部分）；不挡路。
      case failed
    }
    /// 「第几张」（按导入顺序）。
    let number: Int
    let taskID: UUID?
    /// 已上传时的识别任务 ID（用来和周视图的 photos 去重）。
    let jobID: String?
    let state: State
  }

  /// 一份练习：来自练习列表（摘要），有详情 / 回报时补上已说过、已录的数目。
  /// 是否录完只看这份练习自己的回报（answered/total，API 文档 §3.16），不看练习列表的 status（文档没写它的取值）。
  struct Practice: Equatable, Sendable {
    let id: String
    let week: String
    /// 建包时间（列表与详情都有）；判断没生成练习纸的那份是不是太旧了。
    let createdAt: Date?
    let generatedAt: Date?
    let itemCount: Int
    let practiceSlot: String?
    /// 说过为什么错的题数；nil = 没有这份的详情。
    let reflectedCount: Int?
    /// 录了几道；nil = 还没取到这份的回报。
    let answered: Int?
    /// 独立做对几道；nil = 还没取到这份的回报。
    let independentCorrect: Int?

    init(id: String, week: String, createdAt: Date? = nil, generatedAt: Date?, itemCount: Int,
      practiceSlot: String? = nil, reflectedCount: Int? = nil, answered: Int? = nil, independentCorrect: Int? = nil) {
      self.id = id; self.week = week; self.createdAt = createdAt; self.generatedAt = generatedAt
      self.itemCount = itemCount; self.practiceSlot = practiceSlot; self.reflectedCount = reflectedCount
      self.answered = answered; self.independentCorrect = independentCorrect
    }

    /// 录完了吗：有这份的回报看 answered/total；没有 = 不知道（nil）。
    var allRecorded: Bool? {
      guard let answered else { return nil }
      return itemCount > 0 && answered >= itemCount
    }
  }

  struct Input: Equatable, Sendable {
    var connection: Connection
    /// 周视图的 ISO 周（如 2026-W41）；nil = 还没取到（也没有缓存）。
    var weekKey: String?
    /// 周视图里本周已登记的照片（识别任务 ID）。
    var weekPhotoJobIDs: [String]
    /// 本周错题数（周视图 items）。
    var weekItemCount: Int
    /// 还没走完识别流程的本机照片。
    var localPhotos: [LocalPhoto]
    /// 练习，新的在前。
    var practices: [Practice]
    /// 正在准备打印内容的练习。
    var preparingPrintID: String?
    /// 本次打开里点过的「跳过」（只在内存里）。
    var skipped: Set<StepKind>
    var today: Date
    var calendar: Calendar

    init(connection: Connection = .ok, weekKey: String?, weekPhotoJobIDs: [String] = [], weekItemCount: Int = 0,
      localPhotos: [LocalPhoto] = [], practices: [Practice] = [], preparingPrintID: String? = nil,
      skipped: Set<StepKind> = [], today: Date, calendar: Calendar = .current) {
      self.connection = connection; self.weekKey = weekKey; self.weekPhotoJobIDs = weekPhotoJobIDs
      self.weekItemCount = weekItemCount; self.localPhotos = localPhotos; self.practices = practices
      self.preparingPrintID = preparingPrintID; self.skipped = skipped; self.today = today; self.calendar = calendar
    }
  }

  // MARK: - 输出

  enum ConnectReason: Equatable, Sendable { case unpaired, unauthorized, incompatible }

  enum Stage: Equatable, Sendable {
    /// 规则 0：先连上（不显示步骤）。
    case connect(ConnectReason)
    /// 周视图还没取到：只说正在读取 / 没联网。
    case loading
    /// 规则 1：周末 A 打印完（距生成 ≤ 1 天）。
    case done
    /// 规则 2：周中（距生成 2–4 天）。
    case midweek
    /// 规则 3：下个周末（含「录练习纸的结果」）。
    case weekendB
    /// 规则 4：周末 A。
    case weekendA
  }

  struct Step: Equatable, Sendable {
    let kind: StepKind
    let title: String
    /// 标题下一句：没做时是说明 / 进行中的说法，做完时是完成的说法。
    let detail: String
    /// 这一句的语气色：gray 说明，blue AI 在干活，orange 要你处理，green 好了。
    let tone: CardTone
    /// 做完了但要提醒的一句（橙字，如「1 张没认出来」）。
    let warning: String?
    let isDone: Bool
    let isOptional: Bool
    let minutes: Int
    /// 点这一行去哪（做完的也能点回去看）；nil = 这一行没有可去的页面。
    let action: NextStepAction?
  }

  struct Result: Equatable, Sendable {
    let stage: Stage
    let steps: [Step]
    /// 第一个没做完的步骤（「现在做这个」）。
    let currentIndex: Int?
    let next: NextStepModel?
    /// 「做完了」「周中」时是哪一份练习纸。
    let practice: Practice?

    var totalMinutes: Int { steps.reduce(0) { $0 + $1.minutes } }
    /// 清单头：「今天大约 13 分钟，一共 5 步」。
    var header: String { "今天大约 \(totalMinutes) 分钟，一共 \(steps.count) 步" }
  }

  // MARK: - 规则（§3.2，从上往下，命中即停）

  static func make(_ input: Input) -> Result {
    switch input.connection {
    case .unpaired: return connect(.unpaired)
    case .unauthorized: return connect(.unauthorized)
    case .incompatible: return connect(.incompatible)
    default: break
    }
    guard let weekKey = input.weekKey else {
      return Result(stage: .loading, steps: [], currentIndex: nil, next: nil, practice: nil)
    }

    // 规则 1、2：最近一份已生成练习纸、没录完。
    if let latest = input.practices.first, let generatedAt = latest.generatedAt, latest.allRecorded != true {
      let days = daysSince(generatedAt, today: input.today, calendar: input.calendar)
      if days <= Threshold.doneMaxDays {
        return gate(Result(stage: .done, steps: [], currentIndex: nil, next: doneNext(latest), practice: latest),
          connection: input.connection)
      }
      if days <= Threshold.midweekMaxDays {
        return gate(Result(stage: .midweek, steps: [], currentIndex: nil, next: midweekNext(latest), practice: latest),
          connection: input.connection)
      }
    }

    // 规则 3、4：步骤清单。
    let steps = buildSteps(input, weekKey: weekKey)
    let stage: Stage = steps.contains { $0.kind == .record } ? .weekendB : .weekendA
    let currentIndex = steps.firstIndex { !$0.isDone }
    let next = currentIndex.map { stepNext(steps: steps, index: $0, input: input, weekKey: weekKey) }
    return gate(Result(stage: stage, steps: steps, currentIndex: currentIndex, next: next, practice: nil),
      connection: input.connection)
  }

  /// 「距生成几天」= generatedAt 所在本地日历日到今天的天数。
  static func daysSince(_ date: Date, today: Date, calendar: Calendar) -> Int {
    let start = calendar.startOfDay(for: date)
    let end = calendar.startOfDay(for: today)
    return calendar.dateComponents([.day], from: start, to: end).day ?? 0
  }

  // MARK: - 规则 0

  private static func connect(_ reason: ConnectReason) -> Result {
    let primary: NextStepModel.Choice = switch reason {
    case .unpaired: .init(title: "输入邀请码", systemImage: "person.badge.key", action: .scan)
    case .unauthorized: .init(title: "重新登录", systemImage: "person.badge.key", action: .rescan)
    case .incompatible: .init(title: "重新登录", systemImage: "person.badge.key", action: .rescan)
    }
    return Result(stage: .connect(reason), steps: [], currentIndex: nil,
      next: NextStepModel(caption: "用老师或家长给的邀请码", primary: primary), practice: nil)
  }

  // MARK: - 做完了 / 周中（§4.9）

  private static func doneNext(_ practice: Practice) -> NextStepModel {
    NextStepModel(caption: "下次打开：下个周末，录结果", primary: nil,
      secondary: [.init(title: "没打出来？现在打印", systemImage: "printer", action: .print(practiceID: practice.id))])
  }

  private static func midweekNext(_ practice: Practice) -> NextStepModel {
    NextStepModel(caption: "", primary: nil, secondary: [
      .init(title: "已经做完了？现在录结果", systemImage: "square.and.pencil", action: .record(practiceID: practice.id)),
      .init(title: "又发了卷子？现在拍", systemImage: "camera", action: .capture),
    ])
  }

  // MARK: - 步骤（§3.2「步骤与完成判定」，§4.1 文案）

  /// 这周的练习（最近一份）：
  /// - 还没生成练习纸：本周建的；或跨周没多久（≤ unprintedCarryDays 天，选了题没打印就关了，先把它打出来）。
  ///   更旧的不算，免得一份忘了打印的旧练习永远挡在「这周」。
  /// - 已生成练习纸：本周建的、且生成后还不到「下个周末」（≤ midweekMaxDays 天）。
  ///   周一、周二生成的到同一 ISO 周的周末已满 5 天，算上一份（要录结果），不再算这周的。
  static func currentPractice(_ input: Input, weekKey: String) -> Practice? {
    guard let latest = input.practices.first else { return nil }
    if let generatedAt = latest.generatedAt {
      let fresh = daysSince(generatedAt, today: input.today, calendar: input.calendar) <= Threshold.midweekMaxDays
      return latest.week == weekKey && fresh ? latest : nil
    }
    if latest.week == weekKey { return latest }
    guard let createdAt = latest.createdAt else { return nil }
    return daysSince(createdAt, today: input.today, calendar: input.calendar) <= Threshold.unprintedCarryDays ? latest : nil
  }

  /// 上一份练习纸：不是这周的那份、已生成练习纸的最近一份（不管哪个 ISO 周）。
  static func previousPractice(_ input: Input, weekKey: String) -> Practice? {
    let current = currentPractice(input, weekKey: weekKey)
    return input.practices.first { $0.id != current?.id && $0.generatedAt != nil }
  }

  /// 把练习列表、当前打开的详情、按练习分开的回报合成 WeekPlan 的输入（新的在前）。
  /// 刚建的练习还没进列表、或离线只有缓存的详情时，当前详情就是最新的一份。
  static func practices(list: [V2PracticeSummary], current: V2PracticeDetail?,
    summaries: [String: V2ReturnSummary]) -> [Practice] {
    func make(id: String, week: String, createdAt: Date, generatedAt: Date?, itemCount: Int, slot: String?) -> Practice {
      let detail = current?.id == id ? current : nil
      let summary = summaries[id]
      return Practice(id: id, week: week, createdAt: createdAt, generatedAt: detail?.generatedAt ?? generatedAt,
        itemCount: summary?.total ?? detail?.items.count ?? itemCount, practiceSlot: slot,
        reflectedCount: detail.map { $0.items.filter(\.reflected).count },
        answered: summary?.answered, independentCorrect: summary?.independentCorrect)
    }
    var result = list.map {
      make(id: $0.id, week: $0.week, createdAt: $0.createdAt, generatedAt: $0.generatedAt,
        itemCount: $0.itemCount, slot: $0.practiceSlot)
    }
    if let current, !result.contains(where: { $0.id == current.id }) {
      result.insert(make(id: current.id, week: current.week, createdAt: current.createdAt,
        generatedAt: current.generatedAt, itemCount: current.items.count, slot: current.practiceSlot), at: 0)
    }
    return result
  }

  private static func buildSteps(_ input: Input, weekKey: String) -> [Step] {
    let current = currentPractice(input, weekKey: weekKey)
    let previous = previousPractice(input, weekKey: weekKey)
    let registered = Set(input.weekPhotoJobIDs)
    // 本周的照片：周视图里已登记的 + 本机还没走完流程、也还没登记进周视图的。
    let unregisteredLocal = input.localPhotos.filter { photo in photo.jobID.map { !registered.contains($0) } ?? true }
    let photoCount = registered.count + unregisteredLocal.count
    var steps: [Step] = []

    // 1. 拍这周的卷子
    let shootDone = photoCount > 0 || input.skipped.contains(.shoot) || current != nil
    steps.append(Step(kind: .shoot, title: "拍这周的卷子",
      detail: shootDone ? (photoCount > 0 ? "已拍 \(photoCount) 张" : "这周没拍卷子") : "整页拍，一页一张",
      tone: shootDone ? .green : .gray, warning: nil, isDone: shootDone, isOptional: false,
      minutes: minutes(.shoot), action: .capture))

    // 周末 B：录练习纸的结果（上一份生成后 ≥ 5 天）
    if let previous, let generatedAt = previous.generatedAt,
      daysSince(generatedAt, today: input.today, calendar: input.calendar) > Threshold.midweekMaxDays {
      steps.append(recordStep(previous, input: input))
    }

    // 2. 勾出做错的题
    steps.append(pickStep(input, current: current, photoCount: photoCount))

    // 3. 选这周要练的题
    steps.append(Step(kind: .choose, title: "选这周要练的题",
      detail: current.map { "选了 \($0.itemCount) 道" } ?? "AI 先帮你选好，5–8 道",
      tone: current == nil ? .gray : .green, warning: nil, isDone: current != nil, isOptional: false,
      minutes: minutes(.choose), action: current.map { .why(practiceID: $0.id) } ?? .choose))

    // 4. 说说为什么错（可跳过）
    steps.append(whyStep(input, current: current))

    // 5. 打印练习纸
    let printed = current?.generatedAt != nil
    let preparing = current.map { input.preparingPrintID == $0.id } ?? false
    steps.append(Step(kind: .print, title: "打印练习纸",
      detail: printed ? "练习纸已生成" : (preparing ? "正在准备练习纸…" : "打出来，带回学校"),
      tone: printed ? .green : (preparing ? .blue : .gray), warning: nil, isDone: printed, isOptional: false,
      minutes: minutes(.print), action: current.map { .print(practiceID: $0.id) } ?? .choose))
    return steps
  }

  private static func recordStep(_ previous: Practice, input: Input) -> Step {
    let skipped = input.skipped.contains(.record)
    let recorded = previous.allRecorded == true
    let done = recorded || skipped
    let detail: String
    let tone: CardTone
    if recorded {
      detail = previous.independentCorrect.map { "录完了，\(previous.itemCount) 道里独立做对 \($0) 道" } ?? "录完了"
      tone = .green
    } else if skipped {
      detail = "先跳过了，下次再录"
      tone = .gray
    } else if let answered = previous.answered, answered > 0 {
      detail = "录了 \(answered)/\(previous.itemCount) 道"
      tone = .orange
    } else if let generatedAt = previous.generatedAt,
      daysSince(generatedAt, today: input.today, calendar: input.calendar) >= Threshold.staleRecordDays {
      let parts = input.calendar.dateComponents([.month, .day], from: generatedAt)
      detail = "上一份练习纸（\(parts.month ?? 0)/\(parts.day ?? 0)）还没录"
      tone = .orange
    } else {
      detail = "AI 找题要几分钟，正好先录这个"
      tone = .gray
    }
    return Step(kind: .record, title: "录练习纸的结果", detail: detail, tone: tone, warning: nil,
      isDone: done, isOptional: false, minutes: minutes(.record),
      action: recorded ? .summary(practiceID: previous.id) : .record(practiceID: previous.id))
  }

  private static func pickStep(_ input: Input, current: Practice?, photoCount: Int) -> Step {
    let photos = input.localPhotos
    let needsPick = photos.filter { $0.state == .needsPick }
    let notUploaded = photos.filter { $0.state == .notUploaded }
    let working = photos.filter { $0.state == .uploading || $0.state == .finding }
    let failed = photos.filter { $0.state == .failed }
    let found = "找到 \(input.weekItemCount) 道错题"
    let failedWarning = failed.isEmpty ? nil : "\(failed.count) 张没认出来"
    let title = "勾出做错的题"
    let desc = "有红叉的题 AI 自己找；没批改的页要你勾"

    func make(_ detail: String, _ tone: CardTone, done: Bool, warning: String? = nil, action: NextStepAction?) -> Step {
      Step(kind: .pick, title: title, detail: detail, tone: tone, warning: warning, isDone: done,
        isOptional: false, minutes: minutes(.pick), action: action)
    }

    if photoCount == 0 {
      let done = input.skipped.contains(.shoot) || current != nil
      return make(done ? "这周没有新卷子" : desc, done ? .green : .gray, done: done, action: nil)
    }
    // 已经选过这周的题：这一步算完成（后面又拍的照片在主页照片进度里照常处理）。
    if current != nil {
      return make(found, .green, done: true, warning: failedWarning, action: nil)
    }
    if let first = needsPick.first {
      return make("第 \(first.number) 张要你勾", .orange, done: false,
        action: first.taskID.map { .openPick(taskID: $0) })
    }
    if !notUploaded.isEmpty {
      return make("\(notUploaded.count) 张还没上传", .orange, done: false, action: .uploadPending)
    }
    if !working.isEmpty {
      return make("AI 正在找题（\(working.count) 张）", .blue, done: false, action: nil)
    }
    // 没认出来的照片不挡路：这一行算完成，橙字写明（§3.2）。
    return make(found, .green, done: true, warning: failedWarning, action: nil)
  }

  private static func whyStep(_ input: Input, current: Practice?) -> Step {
    let title = "说说为什么错"
    guard let current else {
      return Step(kind: .why, title: title, detail: "每道 AI 问你一句，说一句就行", tone: .gray, warning: nil,
        isDone: false, isOptional: true, minutes: minutes(.why), action: .choose)
    }
    let reflected = current.reflectedCount ?? 0
    let allReflected = current.reflectedCount.map { $0 >= current.itemCount && current.itemCount > 0 } ?? false
    let done = allReflected || input.skipped.contains(.why) || current.generatedAt != nil
    let detail: String
    if reflected > 0 {
      detail = "说了 \(reflected)/\(current.itemCount) 道"
    } else if done {
      detail = "跳过了"
    } else {
      detail = "每道 AI 问你一句，说一句就行"
    }
    return Step(kind: .why, title: title, detail: detail, tone: done ? .green : (reflected > 0 ? .orange : .gray),
      warning: nil, isDone: done, isOptional: true, minutes: minutes(.why), action: .why(practiceID: current.id))
  }

  // MARK: - 下一步按钮（§3.2 末段、§4.0）

  private static func stepNext(steps: [Step], index: Int, input: Input, weekKey: String) -> NextStepModel {
    let step = steps[index]
    let caption = "第 \(index + 1) 步，共 \(steps.count) 步 · 大约 \(step.minutes) 分钟"
    let current = currentPractice(input, weekKey: weekKey)
    switch step.kind {
    case .shoot:
      return NextStepModel(caption: caption,
        primary: .init(title: "拍第一页", systemImage: "camera", action: .capture),
        secondary: [.init(title: "这周没发卷子，跳过", systemImage: nil, action: .skipShoot)])
    case .record:
      let action = step.action ?? .goHome
      return NextStepModel(caption: caption,
        primary: .init(title: "录练习纸的结果", systemImage: "square.and.pencil", action: action),
        secondary: [.init(title: "先跳过，下次再录", systemImage: nil, action: .skipRecord)])
    case .pick:
      switch step.action {
      case .openPick(let taskID):
        let number = input.localPhotos.first { $0.taskID == taskID }?.number ?? 1
        return NextStepModel(caption: caption,
          primary: .init(title: "勾第 \(number) 张", systemImage: "checklist", action: .openPick(taskID: taskID)))
      case .uploadPending:
        return NextStepModel(caption: "照片还在手机上，传上去 AI 才能找题",
          primary: .init(title: "上传照片", systemImage: "icloud.and.arrow.up", action: .uploadPending))
      default:
        // 等 AI 找题：主按钮不可点；周末 B 给一个次要按钮先去录结果。
        let record = steps.first { $0.kind == .record && !$0.isDone }
        let secondary: [NextStepModel.Choice] = record?.action.map {
          [.init(title: "先录结果", systemImage: nil, action: $0)]
        } ?? []
        return NextStepModel(
          caption: secondary.isEmpty ? "大约 1–2 分钟。找好了这里会变成下一步" : "大约 1–2 分钟。可以先做下一步",
          primary: .init(title: "AI 正在找题…", systemImage: nil, action: .goHome),
          isEnabled: false, isWaiting: true, secondary: secondary)
      }
    case .choose:
      return NextStepModel(caption: caption,
        primary: .init(title: "选这周要练的题", systemImage: "list.bullet.rectangle", action: .choose))
    case .why:
      guard let current else {
        return NextStepModel(caption: caption,
          primary: .init(title: "选这周要练的题", systemImage: "list.bullet.rectangle", action: .choose))
      }
      return NextStepModel(caption: caption,
        primary: .init(title: "说说为什么错", systemImage: "bubble.left", action: .why(practiceID: current.id)),
        secondary: [.init(title: "跳过，直接打印", systemImage: nil, action: .skipWhy(practiceID: current.id))])
    case .print:
      guard let current else {
        return NextStepModel(caption: caption,
          primary: .init(title: "选这周要练的题", systemImage: "list.bullet.rectangle", action: .choose))
      }
      return NextStepModel(caption: caption,
        primary: .init(title: "打印练习纸", systemImage: "printer", action: .print(practiceID: current.id)))
    }
  }

  // MARK: - 没联网 / 服务器忙 / 连不上（§3.4、§4.0「被挡」）

  /// 需要服务器的主按钮变灰并换说明；需要服务器的次要按钮收起，只在手机上的保留。
  static func gate(_ result: Result, connection: Connection) -> Result {
    guard let next = result.next else { return result }
    let note: String
    switch connection {
    case .offline: note = "没联网，连上后再继续"
    case .busy: note = "服务器有点忙，过一会儿再试"
    case .failed: note = "连不上服务器，连上后再继续"
    default: return result
    }
    let secondary = next.secondary.filter { !$0.action.needsServer }
    // 等 AI 找题时没联网，AI 那边也等不到结果：同样变灰、换说明。
    let primaryBlocked = next.primary.map { $0.action.needsServer || next.isWaiting } ?? false
    let gated: NextStepModel
    if primaryBlocked {
      gated = NextStepModel(caption: note, primary: next.primary, isEnabled: false, isWaiting: false, secondary: secondary)
    } else if secondary != next.secondary {
      // 没有主按钮的状态（做完了 / 周中）保留原来那句；原来没有说明的换成没联网的说明。
      let caption = next.primary == nil && !next.caption.isEmpty ? next.caption : (next.primary == nil ? note : next.caption)
      gated = NextStepModel(caption: caption, primary: next.primary,
        isEnabled: next.isEnabled, isWaiting: next.isWaiting, secondary: secondary)
    } else {
      return result
    }
    return Result(stage: result.stage, steps: result.steps, currentIndex: result.currentIndex, next: gated,
      practice: result.practice)
  }

  // MARK: - 本机照片归类（与主页「照片进度」同一套判断）

  /// 一张本机照片现在处在哪一段；nil = 已经走完（识别完成、没有要他处理的），或已被他从照片进度里移除。
  static func localState(task: LocalRecognitionTask?, uploading: Bool) -> LocalPhoto.State? {
    guard let task else { return .notUploaded }
    guard let job = task.job else { return uploading ? .uploading : .notUploaded }
    if job.status == "completed" || job.status == "partial" {
      if task.dismissedFromProgress != true, PhotoFailurePlan.plan(for: task) != nil { return .failed }
      if PhotoPickReminder.showsNoMarksRow(task) { return .needsPick }
      return nil
    }
    if job.status == "failed" || job.status == "interrupted" {
      return task.dismissedFromProgress == true ? nil : .failed
    }
    // 识别中，或未知 / 待更新状态：都按「AI 在干活」算，不误报完成。
    return .finding
  }
}
