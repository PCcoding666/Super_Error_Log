import Foundation

/// M1 状态引导：照片卡的语义色与文案。配色映射在视图层（Theme.swift）。
enum CardTone: String, Equatable, Sendable { case gray, blue, orange, green, red }

/// 照片卡聚合结果：标题 + 真实计数 + 一句下一步。
/// 规则（与设计稿 5.0 节一致）：只有题目数 > 0 且全部 confirmed 才是「全部已确认」；
/// 零候选、全跳过、全失败、未知状态均不得误报；「已处理」计数含失败；needs_check 叫「待核对」不叫「可用」。
struct PhotoCardPresentation: Equatable, Sendable {
  let tone: CardTone
  let headline: String
  let counts: String
  let nextStep: String
  /// 有待核对/可重试动作（决定归入「待你处理」区）。
  let actionable: Bool
  /// 存在未知状态 → 单独「状态待更新」区，不混入「已确认」。
  let needsRefresh: Bool
}

/// 刷新失败分类：lastError 是广义请求/缓存错误，不等于离线。
enum RefreshIssue: String, Codable, Sendable {
  case offline, serviceUnavailable, unauthorized, unknown
  var studentText: String {
    switch self {
    case .offline: "当前离线，显示的是上次保存的内容"
    case .serviceUnavailable: "进度暂未更新（服务暂不可用）"
    case .unauthorized: "配对已失效，需要重新配对"
    case .unknown: "进度暂未更新"
    }
  }
}

enum TaskPresentation {
  static let knownStatuses: Set<String> = ["queued", "processing", "ready", "needs_check", "confirmed", "skipped", "failed"]
  /// 任务级状态同理：未来新增的任务状态不得落到「全部已确认」分支。
  static let knownJobStatuses: Set<String> = ["queued", "processing", "completed", "partial", "interrupted", "failed"]

  static func photoCard(task: LocalRecognitionTask, uploading: Bool) -> PhotoCardPresentation {
    if uploading {
      return PhotoCardPresentation(tone: .blue, headline: "正在上传到识别服务", counts: "",
        nextStep: "等待上传完成", actionable: false, needsRefresh: false)
    }
    guard let job = task.job else {
      if task.consentedAt == nil {
        return PhotoCardPresentation(tone: .gray, headline: "仅保存在本机，尚未上传", counts: "",
          nextStep: "选择后上传识别", actionable: false, needsRefresh: false)
      }
      return PhotoCardPresentation(tone: .red, headline: "上传待重试，照片仍在本机", counts: "",
        nextStep: "重新上传", actionable: true, needsRefresh: false)
    }
    let questions = job.questions
    let n = questions.count
    func countOf(_ status: String) -> Int { questions.filter { $0.status == status }.count }
    let ready = countOf("ready"), check = countOf("needs_check"), failed = countOf("failed")
    let confirmed = countOf("confirmed"), skipped = countOf("skipped")
    let active = countOf("queued") + countOf("processing")
    let unknown = questions.filter { !knownStatuses.contains($0.status) }.count
    var parts: [String] = []
    if ready + check > 0 { parts.append("待核对 \(ready + check)") }
    if active > 0 { parts.append("识别中 \(active)") }
    if failed > 0 { parts.append("失败 \(failed)") }
    if confirmed > 0 { parts.append("已确认 \(confirmed)") }
    if skipped > 0 { parts.append("已跳过 \(skipped)") }
    if unknown > 0 { parts.append("状态需核对 \(unknown)") }
    let counts = parts.joined(separator: " · ")

    // 任务级未知状态优先于一切题目级推断：未来状态不得显示为「全部已确认」。
    guard knownJobStatuses.contains(job.status) else {
      return PhotoCardPresentation(tone: .gray, headline: "状态需核对 · 任务状态无法识别", counts: counts,
        nextStep: "请刷新；状态明确前不做确认或复盘", actionable: false, needsRefresh: true)
    }
    if job.status == "failed" || job.status == "interrupted" {
      // 中断/失败仍保留每题计数（如「已确认 1 · 识别中 2」），不把整卡压平成无信息。
      return PhotoCardPresentation(tone: .red,
        headline: job.status == "failed" ? "没识别成功" : "识别已中断", counts: counts,
        nextStep: "查看详情，重试或继续这张照片", actionable: true, needsRefresh: false)
    }

    // 优先级：未知 > 失败 > 待核对 > 进行中 > 已确认 > 跳过。
    if unknown > 0 {
      return PhotoCardPresentation(tone: .gray, headline: "部分题目状态需核对", counts: counts,
        nextStep: "请稍后刷新；状态明确前不能确认或复盘这些题", actionable: false, needsRefresh: true)
    }
    if n == 0 {
      if job.active {
        return PhotoCardPresentation(tone: .blue, headline: "正在识别 · 仍在定位题目", counts: "",
          nextStep: "暂无候选题，完成后再来看", actionable: false, needsRefresh: false)
      }
      return PhotoCardPresentation(tone: .gray, headline: "没有发现可识别的题目", counts: "",
        nextStep: "可以重新拍摄，或查看详情", actionable: false, needsRefresh: false)
    }
    if failed == n {
      return PhotoCardPresentation(tone: .red, headline: "\(n) 道都没识别成功", counts: counts,
        nextStep: "逐题重试（只影响失败题）", actionable: true, needsRefresh: false)
    }
    if skipped == n {
      return PhotoCardPresentation(tone: .gray, headline: "全部已跳过", counts: counts,
        nextStep: "仅可查看 · 当前版本不能恢复", actionable: false, needsRefresh: false)
    }
    if confirmed == n {
      return PhotoCardPresentation(tone: .green, headline: "全部已确认", counts: counts,
        nextStep: "可去复盘", actionable: false, needsRefresh: false)
    }
    if failed > 0 {
      return PhotoCardPresentation(tone: .red, headline: "部分完成 · \(failed) 道失败", counts: counts,
        nextStep: ready + check > 0 ? "可先核对已就绪的题，再重试失败题" : "重试失败的 \(failed) 道题",
        actionable: true, needsRefresh: false)
    }
    if ready + check > 0 {
      return PhotoCardPresentation(tone: .orange, headline: "待你核对 \(ready + check) 道题", counts: counts,
        nextStep: active > 0 ? "先核对已就绪的题，不用等其余题" : "逐题对照原图",
        actionable: true, needsRefresh: false)
    }
    if active > 0 {
      // 计数含失败——文案写「已处理」不写「已成功」。
      return PhotoCardPresentation(tone: .blue, headline: "正在识别 · 已处理 \(n - active)/\(n) 道", counts: counts,
        nextStep: "可离开，稍后回来", actionable: false, needsRefresh: false)
    }
    // 仅剩 confirmed + skipped。
    return PhotoCardPresentation(tone: .green, headline: "已确认 \(confirmed) 道", counts: counts,
      nextStep: "可去复盘已确认的题", actionable: false, needsRefresh: false)
  }

  /// 确认后「继续下一道待处理」：按列表顺序取当前题之后的下一道 ready/needs_check；没有则回到最前面的待处理。
  static func nextActionableQuestion(in job: RecognitionJob, after currentID: String?) -> RecognitionQuestion? {
    func actionable(_ q: RecognitionQuestion) -> Bool { q.status == "ready" || q.status == "needs_check" }
    guard let currentID, let index = job.questions.firstIndex(where: { $0.id == currentID }) else {
      return job.questions.first(where: actionable)
    }
    if let later = job.questions[(index + 1)...].first(where: actionable) { return later }
    return job.questions[..<index].first(where: actionable)
  }

  static func classifyRefreshIssue(_ error: Error) -> RefreshIssue {
    if case RecognitionClientError.server(let status, _) = error {
      if status == 401 { return .unauthorized }
      if status == 429 || (500...599).contains(status) { return .serviceUnavailable }
      return .unknown
    }
    if case RecognitionClientError.networkFailure(let urlError) = error {
      switch urlError.code {
      case .notConnectedToInternet, .networkConnectionLost, .internationalRoamingOff, .dataNotAllowed:
        return .offline
      case .timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .resourceUnavailable:
        return .serviceUnavailable
      default: return .unknown
      }
    }
    return .unknown
  }
}

/// 页内原图的身份绑定：任务 + 题目 + revision + 源图片 URL 四元。
/// 确认门禁以「这份来源真实解码显示」为准，不用「打开过模态框」的布尔值代替核对。
struct SourceBinding: Equatable, Hashable, Sendable {
  let taskID: UUID
  let questionID: String
  let revision: Int
  let url: URL
}

/// 页内原图可读状态机：begin 换绑即作废旧可读；complete 只接受当前 pending（迟到旧图不生效）；
/// fail 清除对应可读状态。视图层在换题、图片 URL 变化、加载失败时调用 begin/fail。
struct InlineSourceGate: Equatable, Sendable {
  private(set) var pending: SourceBinding?
  private(set) var readable: SourceBinding?
  mutating func begin(_ binding: SourceBinding) {
    pending = binding
    readable = nil   // 每次开始加载（含同绑定重载）都作废旧可读；对应勾选由视图层一并清除
  }
  /// 返回这次解码完成是否生效（false = 迟到的旧图，不得启用新题）。
  @discardableResult
  mutating func complete(_ binding: SourceBinding) -> Bool {
    guard pending == binding else { return false }
    readable = binding
    pending = nil
    return true
  }
  mutating func fail(_ binding: SourceBinding) {
    if pending == binding { pending = nil }
    if readable == binding { readable = nil }
  }
  func isReadable(_ binding: SourceBinding) -> Bool { readable == binding }
}

/// M1 review：页内图片加载定序器。每次加载得到递增代次；只有「当前 token + 当代代次」
/// 的完成才允许写界面/上报门禁——迟到旧图（先开始的 A 晚于 B 完成）一律忽略。
struct LoadSequencer<Token: Hashable & Sendable>: Equatable, Sendable {
  private var generation: UInt64 = 0
  private(set) var activeToken: Token?
  private(set) var activeGeneration: UInt64 = 0
  /// 开始一次加载；替换旧 token。返回本次代次。
  mutating func begin(_ token: Token) -> UInt64 {
    generation += 1
    activeToken = token
    activeGeneration = generation
    return generation
  }
  /// 完成是否仍属当前加载（绑定未换、未被更新的 begin 覆盖）。
  func isCurrent(_ token: Token, generation check: UInt64) -> Bool {
    activeToken == token && activeGeneration == check
  }
}
