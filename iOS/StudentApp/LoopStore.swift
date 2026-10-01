import Foundation
import Observation

// T6b：LoopStore——学生一周闭环的界面状态（纯逻辑，不含界面；docs/mobile-v2-api.md 为唯一接口依据）。
// 服务器是记录源，本机磁盘缓存只用于离线时显示「上次看到的内容」并标注为缓存。
// 不写任何日志；错误文案只用服务器返回的中文 message 或通用连接提示。

/// 「生成修改建议」的一次点击：clientRequestId 是幂等键，同一次点击的重试复用同一个。
private struct PendingCorrectionRequest: Equatable, Sendable {
  let instruction: String
  let method: V2CorrectionMethod
  let clientRequestId: String
}

/// 离线缓存形状（loop-cache.json）：周视图、当前练习、设置、最近一次回报与保存时间。
/// 不缓存学生的追问回答与 AI 归纳。
private struct LoopCacheSnapshot: Codable {
  var week: V2WeekView?
  var currentPractice: V2PracticeDetail?
  var settings: V2Settings?
  var summary: V2ReturnSummary?
  var savedAt: Date
}

@MainActor @Observable
final class LoopStore {
  /// 复盘状态机：idle → asking → waitingAnswer → summarizing → confirming → submitting → done。
  /// 有第二轮问题时回到 waitingAnswer；任一步失败回到上一个稳定状态并设置 lastError。
  enum ReflectionPhase: Equatable, Sendable {
    case idle
    case asking
    case waitingAnswer(question: String, turn: Int)
    case summarizing
    case confirming(summary: String?, suggestedCause: String?, suggestedAttemptState: String?)
    case submitting
    case done
  }

  /// 打印状态机：none → preparing(progress) → ready(snapshot) / failed(message)。
  /// ready 仅在快照登记的全部图片下载到缓存目录后进入（可生成 PDF 的前提）。
  enum PrintPhase: Equatable, Sendable {
    case none
    case preparing(V2PrintProgress?)
    case ready(V2PrintSnapshot)
    case failed(String)
  }

  private var client: V2Client?
  /// 客户端代次：updateClient 换客户端时 +1，进行中的异步流程落地前比对代次，
  /// 旧客户端的迟到响应一律丢弃（不复活已清除的进行中状态）。
  private var generation = 0
  private let cacheDirectory: URL
  private let pollInterval: Duration
  private let pollTimeout: Duration

  private(set) var week: V2WeekView?
  /// 周视图刷新失败分类（离线/服务暂不可用/配对失效/未知），复用 TaskPresentation.classifyRefreshIssue。
  private(set) var weekIssue: RefreshIssue?
  /// 最近一次失败的服务器中文文案（或通用连接提示）。
  private(set) var lastError: String?
  private(set) var settings: V2Settings?

  private(set) var recommended: [V2RecommendedItem] = []
  private(set) var others: [V2RecommendedItem] = []
  private(set) var notes: [String] = []
  private(set) var limits: V2Recommendation.Limits?
  /// 学生当前勾选的题目 ID（初始为推荐的那几道），限制 1–8 道。
  private(set) var selectedItemIDs: [String] = []

  private(set) var practices: [V2PracticeSummary] = []
  private(set) var currentPractice: V2PracticeDetail?
  private(set) var summary: V2ReturnSummary?
  /// 本地暂存的「不是错题」卡片：restore 成功后就地加回，不必整页重取。
  private(set) var discardedItems: [V2ItemCard] = []

  private(set) var reflectionPhase: ReflectionPhase = .idle
  private(set) var evidence: V2Evidence?
  private(set) var proposal: V2CorrectionProposal?
  /// 修改接口 409（revision 冲突）后给学生的提示。
  private(set) var proposalNotice: String?
  private(set) var printPhase: PrintPhase = .none

  /// 回传待提交列表：ok:false 的保留并带原因（returnIssues），ok:true 的移除。
  private(set) var pendingReturns: [V2ReturnEntry] = []
  private(set) var returnIssues: [String: String] = [:]

  private(set) var isShowingCache = false
  private(set) var cacheSavedAt: Date?

  /// 会调用模型的动作进行中标记（界面据此禁用按钮；进行中重复调用直接返回）。
  private(set) var isBusyReflection = false
  private(set) var isBusyProposal = false
  private(set) var isBusyApply = false
  private(set) var isBusyPrint = false
  /// 上次「生成修改建议」失败是否属于连接失败（没有收到服务器回应）：
  /// 界面只在此时提供原样重试（retryProposal 复用同一 clientRequestId）；
  /// 收到了服务器回应（含 502/429）则重试必须走 proposeCorrection 换新的请求标识。
  private(set) var proposalRetryable = false

  private var reflectionItemID: String?
  private var evidenceItemID: String?
  private var pendingProposal: PendingCorrectionRequest?
  private var printTask: Task<Void, Never>?
  private var cropDownloads: [String: Task<URL, Error>] = [:]

  private static let genericConnectionText = "暂时连不上学习服务。请检查连接后重试。"

  init(client: V2Client?, cacheDirectory: URL,
    pollInterval: Duration = .seconds(2), pollTimeout: Duration = .seconds(300)) {
    self.client = client
    self.cacheDirectory = cacheDirectory
    self.pollInterval = pollInterval
    self.pollTimeout = pollTimeout
    loadCache()
  }

  // MARK: - 客户端切换与错误清除

  /// 配对变化后换上新客户端（nil = 未配对）：取消进行中的打印轮询，
  /// 清掉与旧服务相关的进行中状态（复盘、修改、打印）；已显示的数据保留并标为缓存，
  /// 直到下一次刷新成功。旧客户端的迟到响应由代次守卫丢弃。
  func updateClient(_ client: V2Client?) {
    generation += 1
    self.client = client
    printTask?.cancel()
    printTask = nil
    for (_, download) in cropDownloads { download.cancel() }
    cropDownloads = [:]
    reflectionPhase = .idle
    reflectionItemID = nil
    evidence = nil
    evidenceItemID = nil
    proposal = nil
    pendingProposal = nil
    proposalNotice = nil
    proposalRetryable = false
    printPhase = .none
    isBusyReflection = false
    isBusyProposal = false
    isBusyApply = false
    isBusyPrint = false
    if week != nil || currentPractice != nil || settings != nil || summary != nil {
      isShowingCache = true
    }
  }

  /// 界面关掉错误提示时调用。
  func clearError() { lastError = nil }

  // MARK: - 周视图

  func refreshWeek() async {
    guard let client else { return }
    do {
      week = try await client.week()
      weekIssue = nil
      persistCache()
    } catch {
      // 失败保留旧数据，只更新失败分类。
      weekIssue = TaskPresentation.classifyRefreshIssue(error)
    }
  }

  // MARK: - 不是错题 / 恢复（成功后就地更新本地列表）

  func discard(itemID: String) async {
    guard let client else { return }
    do {
      _ = try await client.discard(itemId: itemID)
      if let current = week, let index = current.items.firstIndex(where: { $0.id == itemID }) {
        let card = current.items[index]
        var items = current.items
        items.remove(at: index)
        week = current.with(items: items)
        discardedItems.append(card)
        persistCache()
      }
    } catch { lastError = Self.errorText(error) }
  }

  func restore(itemID: String) async {
    guard let client else { return }
    do {
      let change = try await client.restore(itemId: itemID)
      if let index = discardedItems.firstIndex(where: { $0.id == itemID }), let current = week {
        let restored = discardedItems.remove(at: index).with(status: change.status)
        week = current.with(items: current.items + [restored])
        persistCache()
      }
    } catch { lastError = Self.errorText(error) }
  }

  // MARK: - 设置

  func loadSettings() async {
    guard let client else { return }
    do {
      settings = try await client.settings()
      persistCache()
    } catch { lastError = Self.errorText(error) }
  }

  func saveSettings(practiceSlot: String, paperLocation: V2PaperLocation) async {
    guard let client else { return }
    do {
      settings = try await client.updateSettings(V2Settings(practiceSlot: practiceSlot, paperLocation: paperLocation))
      persistCache()
    } catch { lastError = Self.errorText(error) }
  }

  // MARK: - 推荐与勾选

  func loadRecommendation() async {
    guard let client else { return }
    do {
      let recommendation = try await client.recommend()
      recommended = recommendation.recommended
      others = recommendation.others
      notes = recommendation.notes
      limits = recommendation.limits
      selectedItemIDs = recommendation.recommended.map(\.id)
    } catch { lastError = Self.errorText(error) }
  }

  /// 勾选候选里的题（推荐或候选池）；至多 8 道。
  func selectItem(_ id: String) {
    guard selectedItemIDs.count < 8, !selectedItemIDs.contains(id),
      recommended.contains(where: { $0.id == id }) || others.contains(where: { $0.id == id })
    else { return }
    selectedItemIDs.append(id)
  }

  /// 取消勾选；至少保留 1 道。
  func deselectItem(_ id: String) {
    guard selectedItemIDs.count > 1 else { return }
    selectedItemIDs.removeAll { $0 == id }
  }

  // MARK: - 练习

  func createPractice(practiceSlot: String? = nil) async {
    guard let client, !selectedItemIDs.isEmpty else { return }
    do {
      currentPractice = try await client.createPractice(itemIds: selectedItemIDs, practiceSlot: practiceSlot)
      // 成功后清空推荐状态。
      recommended = []; others = []; notes = []; limits = nil; selectedItemIDs = []
      persistCache()
    } catch RecognitionClientError.server(status: 409, let message) {
      lastError = message
      await loadRecommendation()
    } catch { lastError = Self.errorText(error) }
  }

  func loadPractices() async {
    guard let client else { return }
    do {
      practices = try await client.practiceList()
      // currentPractice 默认取最新一份。
      if currentPractice == nil, let latest = practices.first {
        await openPractice(id: latest.id)
      }
    } catch { lastError = Self.errorText(error) }
  }

  func openPractice(id: String) async {
    guard let client else { return }
    do {
      currentPractice = try await client.practiceDetail(id: id)
      persistCache()
    } catch { lastError = Self.errorText(error) }
  }

  // MARK: - 复盘状态机

  func startReflection(itemID: String) async {
    guard let client, !isBusyReflection else { return }
    isBusyReflection = true
    let requestGeneration = generation
    reflectionItemID = itemID
    reflectionPhase = .asking
    do {
      let question = try await client.askReflection(itemId: itemID)
      guard requestGeneration == generation else { return }
      reflectionPhase = .waitingAnswer(question: question.question, turn: question.turn)
    } catch {
      guard requestGeneration == generation else { return }
      reflectionPhase = .idle
      lastError = Self.errorText(error)
    }
    isBusyReflection = false
  }

  func answerFollowup(_ text: String) async {
    guard let client, !isBusyReflection, let itemID = reflectionItemID,
      case .waitingAnswer(let question, let turn) = reflectionPhase else { return }
    isBusyReflection = true
    let requestGeneration = generation
    reflectionPhase = .summarizing
    do {
      let result = try await client.answerReflection(itemId: itemID, answer: text)
      guard requestGeneration == generation else { return }
      if let secondQuestion = result.secondQuestion {
        // 有第二轮问题时回到 waitingAnswer。
        reflectionPhase = .waitingAnswer(question: secondQuestion, turn: result.turn + 1)
      } else {
        // 归纳失败时三个建议字段为 nil：进入手选。
        reflectionPhase = .confirming(summary: result.summary,
          suggestedCause: result.suggestedCause, suggestedAttemptState: result.suggestedAttemptState)
      }
    } catch {
      guard requestGeneration == generation else { return }
      reflectionPhase = .waitingAnswer(question: question, turn: turn)
      lastError = Self.errorText(error)
    }
    isBusyReflection = false
  }

  func submitReflection(attemptState: String, cause: String, masteryFeeling: Int, summary: String?) async {
    guard let client, !isBusyReflection, let itemID = reflectionItemID,
      case .confirming(let confirmedSummary, let suggestedCause, let suggestedAttemptState) = reflectionPhase
    else { return }
    isBusyReflection = true
    let requestGeneration = generation
    reflectionPhase = .submitting
    do {
      let record = try await client.submitReflection(itemId: itemID,
        submission: V2ReflectionSubmission(attemptState: attemptState, cause: cause,
          masteryFeeling: masteryFeeling, summary: summary))
      guard requestGeneration == generation else { return }
      reflectionPhase = .done
      applyReflectionResult(itemID: itemID, status: record.status)
    } catch {
      guard requestGeneration == generation else { return }
      reflectionPhase = .confirming(summary: confirmedSummary,
        suggestedCause: suggestedCause, suggestedAttemptState: suggestedAttemptState)
      lastError = Self.errorText(error)
    }
    isBusyReflection = false
  }

  /// 提交成功后更新对应题卡的 reflected 与状态（周视图、推荐、当前练习）。
  private func applyReflectionResult(itemID: String, status: V2ItemStatus?) {
    guard let status else { return }
    if let current = week {
      var items = current.items
      var backlog = current.backlog
      var changed = false
      if let index = items.firstIndex(where: { $0.id == itemID }) {
        items[index] = items[index].with(status: status); changed = true
      }
      if let index = backlog.firstIndex(where: { $0.id == itemID }) {
        backlog[index] = backlog[index].with(status: status); changed = true
      }
      if changed { week = current.with(items: items, backlog: backlog) }
    }
    if let index = recommended.firstIndex(where: { $0.id == itemID }) {
      recommended[index] = recommended[index].with(status: status, reflected: true)
    }
    if let index = others.firstIndex(where: { $0.id == itemID }) {
      others[index] = others[index].with(status: status, reflected: true)
    }
    if let practice = currentPractice, let index = practice.items.firstIndex(where: { $0.id == itemID }) {
      var items = practice.items
      items[index] = items[index].with(status: status, reflected: true)
      currentPractice = practice.with(items: items)
    }
    persistCache()
  }

  // MARK: - 修改识别结果

  func loadEvidence(itemID: String) async {
    guard let client else { return }
    do {
      evidence = try await client.evidence(itemId: itemID)
      evidenceItemID = itemID
      proposal = nil
      pendingProposal = nil
      proposalNotice = nil
    } catch { lastError = Self.errorText(error) }
  }

  /// 每次「生成建议」生成新的 clientRequestId（UUID）；连接失败后的原样重试走 retryProposal 复用同一个。
  func proposeCorrection(instruction: String, method: V2CorrectionMethod) async {
    guard let evidence, let itemID = evidenceItemID, !isBusyProposal else { return }
    let request = PendingCorrectionRequest(instruction: instruction, method: method,
      clientRequestId: UUID().uuidString)
    pendingProposal = request
    proposalRetryable = false
    await sendProposal(request, itemID: itemID, revision: evidence.revision)
  }

  /// 连接失败（没有收到服务器回应）后的原样重试：复用上次的指令与 clientRequestId
  /// （服务器幂等，不重复调用模型）。收到了服务器回应的失败不得走这里。
  func retryProposal() async {
    guard proposalRetryable, let request = pendingProposal, let itemID = evidenceItemID,
      let evidence, !isBusyProposal else { return }
    await sendProposal(request, itemID: itemID, revision: evidence.revision)
  }

  private func sendProposal(_ request: PendingCorrectionRequest, itemID: String, revision: Int) async {
    guard let client, !isBusyProposal else { return }
    isBusyProposal = true
    let requestGeneration = generation
    do {
      let proposal = try await client.proposeCorrection(itemId: itemID, instruction: request.instruction,
        method: request.method, revision: revision, clientRequestId: request.clientRequestId)
      guard requestGeneration == generation else { return }
      self.proposal = proposal
      proposalNotice = nil
      proposalRetryable = false
    } catch V2ClientError.revisionConflict {
      guard requestGeneration == generation else { return }
      proposalRetryable = false
      await refreshEvidenceAfterConflict(itemID: itemID, client: client)
    } catch {
      guard requestGeneration == generation else { return }
      lastError = Self.errorText(error)
      // 只有连接失败（没有收到服务器回应）才可原样重试；服务器回了话（含 502/429）必须换新请求标识。
      proposalRetryable = Self.isConnectionFailure(error)
    }
    isBusyProposal = false
  }

  /// 连接失败判定：传输层错误（未收到服务器任何回应）。
  private static func isConnectionFailure(_ error: Error) -> Bool {
    if case RecognitionClientError.networkFailure = error { return true }
    if case RecognitionClientError.service = error { return true }
    return false
  }

  func acceptProposal() async {
    guard let client, let proposal, let itemID = evidenceItemID, !isBusyApply else { return }
    isBusyApply = true
    let requestGeneration = generation
    do {
      let acceptance = try await client.acceptCorrection(itemId: itemID,
        proposalId: proposal.proposalId, revision: proposal.revision)
      guard requestGeneration == generation else { return }
      applyUpdatedCard(acceptance.card)
      self.proposal = nil
      pendingProposal = nil
      evidence = nil
      evidenceItemID = nil
      proposalNotice = nil
    } catch V2ClientError.revisionConflict {
      guard requestGeneration == generation else { return }
      await refreshEvidenceAfterConflict(itemID: itemID, client: client)
    } catch {
      guard requestGeneration == generation else { return }
      lastError = Self.errorText(error)
    }
    isBusyApply = false
  }

  func applyDirect(changes: [V2CorrectionChange]) async {
    guard let client, let evidence, let itemID = evidenceItemID, !isBusyApply else { return }
    isBusyApply = true
    let requestGeneration = generation
    do {
      let acceptance = try await client.correctDirectly(itemId: itemID, revision: evidence.revision, changes: changes)
      guard requestGeneration == generation else { return }
      applyUpdatedCard(acceptance.card)
      self.evidence = nil
      evidenceItemID = nil
      proposal = nil
      pendingProposal = nil
      proposalNotice = nil
    } catch V2ClientError.revisionConflict {
      guard requestGeneration == generation else { return }
      await refreshEvidenceAfterConflict(itemID: itemID, client: client)
    } catch {
      guard requestGeneration == generation else { return }
      lastError = Self.errorText(error)
    }
    isBusyApply = false
  }

  /// 修改接口 409（顶层带 revision）：用新 revision 重新取识别结果，提示学生再看一眼；不自动重放。
  private func refreshEvidenceAfterConflict(itemID: String, client: V2Client) async {
    proposal = nil
    do {
      evidence = try await client.evidence(itemId: itemID)
      proposalNotice = "内容已更新，请再看一眼。"
    } catch { lastError = Self.errorText(error) }
  }

  /// 接受/直改成功后用返回的卡片更新本地列表。
  private func applyUpdatedCard(_ card: V2ItemCard) {
    if let current = week {
      var items = current.items
      var backlog = current.backlog
      var changed = false
      if let index = items.firstIndex(where: { $0.id == card.id }) { items[index] = card; changed = true }
      if let index = backlog.firstIndex(where: { $0.id == card.id }) { backlog[index] = card; changed = true }
      if changed { week = current.with(items: items, backlog: backlog) }
    }
    if let index = discardedItems.firstIndex(where: { $0.id == card.id }) { discardedItems[index] = card }
    if let index = recommended.firstIndex(where: { $0.id == card.id }) {
      recommended[index] = recommended[index].with(card: card)
    }
    if let index = others.firstIndex(where: { $0.id == card.id }) {
      others[index] = others[index].with(card: card)
    }
    if let practice = currentPractice, let index = practice.items.firstIndex(where: { $0.id == card.id }) {
      var items = practice.items
      items[index] = items[index].with(card: card)
      currentPractice = practice.with(items: items)
    }
    persistCache()
  }

  // MARK: - 打印

  func requestPrint(practiceID: String) async {
    guard let client, !isBusyPrint else { return }
    isBusyPrint = true
    let requestGeneration = generation
    printTask?.cancel()
    printTask = nil
    do {
      let state = try await client.requestPrint(packetId: practiceID)
      guard requestGeneration == generation else { return }
      await applyPrintState(state, packetID: practiceID, client: client, generation: requestGeneration)
    } catch {
      guard requestGeneration == generation else { return }
      if !Task.isCancelled { lastError = Self.errorText(error) }
      isBusyPrint = false
    }
  }

  /// 单次状态检查；已到 ready 时补齐图片（已存在不重下），preparing 时确保轮询进行中。
  func pollPrint(practiceID: String) async {
    guard let client, !isBusyPrint else { return }
    let requestGeneration = generation
    do {
      let state = try await client.printStatus(packetId: practiceID)
      if Task.isCancelled { return }
      guard requestGeneration == generation else { return }
      await applyPrintState(state, packetID: practiceID, client: client, generation: requestGeneration)
    } catch {
      if !Task.isCancelled, requestGeneration == generation { lastError = Self.errorText(error) }
    }
  }

  func cancelPrint() {
    printTask?.cancel()
    printTask = nil
    printPhase = .none
    isBusyPrint = false
  }

  func printMediaURL(packetID: String, name: String) -> URL {
    cacheDirectory.appendingPathComponent("PrintMedia/\(packetID)/\(name)")
  }

  private func applyPrintState(_ state: V2PrintState, packetID: String, client: V2Client, generation requestGeneration: Int) async {
    switch state.status {
    case .ready:
      guard let snapshot = state.snapshot else {
        printPhase = .failed(Self.genericConnectionText)
        isBusyPrint = false
        return
      }
      await finishPrintReady(packetID: packetID, snapshot: snapshot, client: client, generation: requestGeneration)
    case .failed:
      printPhase = .failed(state.error ?? "打印准备失败，请稍后再试。")
      isBusyPrint = false
    default:
      printPhase = .preparing(state.progress)
      isBusyPrint = true
      startPrintPolling(packetID: packetID, client: client, generation: requestGeneration)
    }
  }

  /// ready 后下载快照登记的全部图片；全部到齐才把状态标为 ready（可生成 PDF）。
  /// 图片没下全统一进入 failed（不停在 preparing），重试路径只有再调 requestPrint（服务器幂等）。
  private func finishPrintReady(packetID: String, snapshot: V2PrintSnapshot, client: V2Client, generation requestGeneration: Int) async {
    do {
      try await downloadPrintMedia(packetID: packetID, snapshot: snapshot, client: client)
      if Task.isCancelled { return }
      guard requestGeneration == generation else { return }
      printPhase = .ready(snapshot)
    } catch {
      if !Task.isCancelled, requestGeneration == generation {
        printPhase = .failed("打印图片没有全部下载成功，请再试一次。")
      }
    }
    if requestGeneration == generation { isBusyPrint = false }
  }

  private func startPrintPolling(packetID: String, client: V2Client, generation requestGeneration: Int) {
    printTask?.cancel()
    let deadline = ContinuousClock.now + pollTimeout
    printTask = Task { [weak self] in
      guard let self else { return }
      while !Task.isCancelled {
        do { try await Task.sleep(for: pollInterval) } catch { break }
        if Task.isCancelled { break }
        if ContinuousClock.now >= deadline {
          // 轮询超时统一进入 failed（不停在 preparing），重试路径只有再调 requestPrint。
          self.printPhase = .failed("打印准备时间太久，请再试一次。")
          self.isBusyPrint = false
          return
        }
        do {
          let state = try await client.printStatus(packetId: packetID)
          if Task.isCancelled { break }
          guard requestGeneration == self.generation else { return }
          switch state.status {
          case .ready, .failed:
            await self.applyPrintState(state, packetID: packetID, client: client, generation: requestGeneration)
            return
          default:
            self.printPhase = .preparing(state.progress)
          }
        } catch {
          if Task.isCancelled { break }
          // 轮询时网络失败统一进入 failed（不停在 preparing）。
          self.printPhase = .failed(Self.errorText(error))
          self.isBusyPrint = false
          return
        }
      }
    }
  }

  private func downloadPrintMedia(packetID: String, snapshot: V2PrintSnapshot, client: V2Client) async throws {
    let names = snapshot.items.flatMap { item in
      (item.cropMedia.map { [$0] } ?? []) + item.diagramMedia
    }
    let directory = cacheDirectory.appendingPathComponent("PrintMedia/\(packetID)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    for name in names {
      let url = printMediaURL(packetID: packetID, name: name)
      if FileManager.default.fileExists(atPath: url.path) { continue }
      let data = try await client.printMedia(packetId: packetID, name: name)
      try data.write(to: url, options: .atomic)
      try StudyPersistence.excludeFromBackup(url)
    }
  }

  // MARK: - 回传与回报

  func submitReturn(practiceID: String, entries: [V2ReturnEntry]) async {
    guard let client else { return }
    for entry in entries {
      pendingReturns.removeAll { $0.itemId == entry.itemId }
      pendingReturns.append(entry)
      returnIssues.removeValue(forKey: entry.itemId)
    }
    guard !pendingReturns.isEmpty else { return }
    do {
      let response = try await client.returnResults(packetId: practiceID, results: pendingReturns)
      for result in response.results {
        if result.ok {
          pendingReturns.removeAll { $0.itemId == result.itemId }
          returnIssues.removeValue(forKey: result.itemId)
        } else {
          returnIssues[result.itemId] = result.error ?? "这一条没有提交成功，请检查后再试。"
        }
      }
      await loadSummary(practiceID: practiceID)
    } catch { lastError = Self.errorText(error) }
  }

  func loadSummary(practiceID: String) async {
    guard let client else { return }
    do {
      summary = try await client.practiceSummary(packetId: practiceID)
      persistCache()
    } catch { lastError = Self.errorText(error) }
  }

  // MARK: - 图片

  /// 整题裁图的本地文件：有缓存直接返回；没有则取字节写入缓存目录。并发同一张图只下载一次。
  func cropFileURL(itemID: String) async -> URL? {
    let url = cacheDirectory.appendingPathComponent("Crops/\(itemID).jpg")
    if FileManager.default.fileExists(atPath: url.path) { return url }
    if let inFlight = cropDownloads[itemID] {
      return try? await inFlight.value
    }
    guard let client else { return nil }
    let download = Task {
      let data = try await client.crop(itemId: itemID)
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: url, options: .atomic)
      try StudyPersistence.excludeFromBackup(url)
      return url
    }
    cropDownloads[itemID] = download
    defer { cropDownloads[itemID] = nil }
    // 取缩略图失败只返回 nil，不写 lastError：离线时每张缩略图都会顶掉真正的错误提示。
    return try? await download.value
  }

  // MARK: - 离线缓存

  private var cacheFileURL: URL { cacheDirectory.appendingPathComponent("loop-cache.json") }

  /// 启动时先读缓存显示；缓存损坏时忽略并删除，不阻塞启动。
  private func loadCache() {
    guard let data = try? Data(contentsOf: cacheFileURL) else { return }
    do {
      let cache = try RecognitionCodec.decoder().decode(LoopCacheSnapshot.self, from: data)
      week = cache.week
      currentPractice = cache.currentPractice
      settings = cache.settings
      summary = cache.summary
      cacheSavedAt = cache.savedAt
      isShowingCache = cache.week != nil || cache.currentPractice != nil
        || cache.settings != nil || cache.summary != nil
    } catch {
      try? FileManager.default.removeItem(at: cacheFileURL)
    }
  }

  /// 联网刷新成功后更新缓存（原子写入、排除备份）。
  private func persistCache() {
    let cache = LoopCacheSnapshot(week: week, currentPractice: currentPractice,
      settings: settings, summary: summary, savedAt: Date())
    do {
      try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
      try JSONEncoder().encode(cache).write(to: cacheFileURL, options: .atomic)
      try StudyPersistence.excludeFromBackup(cacheFileURL)
      cacheSavedAt = cache.savedAt
      isShowingCache = false
    } catch {
      // 缓存写失败不阻塞功能。
    }
  }

  /// 错误文案：服务器的中文 message 或通用连接提示。
  private static func errorText(_ error: Error) -> String {
    if let clientError = error as? RecognitionClientError {
      return clientError.errorDescription ?? genericConnectionText
    }
    if case V2ClientError.revisionConflict(let message, _) = error { return message }
    return genericConnectionText
  }
}

// MARK: - 卡片重建辅助（卡片字段均为 let，状态更新需重建）

private extension V2WeekView {
  func with(items: [V2ItemCard], backlog: [V2ItemCard]? = nil) -> V2WeekView {
    V2WeekView(week: week, photos: photos, items: items, backlog: backlog ?? self.backlog)
  }
}

private extension V2PracticeDetail {
  func with(items: [V2PracticeItem]) -> V2PracticeDetail {
    V2PracticeDetail(id: id, week: week, status: status, practiceSlot: practiceSlot,
      createdAt: createdAt, generatedAt: generatedAt, items: items)
  }
}

private extension V2ItemCard {
  func with(status: V2ItemStatus) -> V2ItemCard {
    V2ItemCard(id: id, shortId: shortId, subject: subject, knowledgeTags: knowledgeTags,
      questionExcerpt: questionExcerpt, badge: badge, status: status, cropUrl: cropUrl, jobId: jobId)
  }
}

private extension V2RecommendedItem {
  func with(status: V2ItemStatus, reflected: Bool) -> V2RecommendedItem {
    V2RecommendedItem(id: id, shortId: shortId, subject: subject, knowledgeTags: knowledgeTags,
      questionExcerpt: questionExcerpt, badge: badge, status: status, cropUrl: cropUrl, jobId: jobId,
      reason: reason, tier: tier, reflected: reflected)
  }
  func with(card: V2ItemCard) -> V2RecommendedItem {
    V2RecommendedItem(id: card.id, shortId: card.shortId, subject: card.subject,
      knowledgeTags: card.knowledgeTags, questionExcerpt: card.questionExcerpt, badge: card.badge,
      status: card.status, cropUrl: card.cropUrl, jobId: card.jobId,
      reason: reason, tier: tier, reflected: reflected)
  }
}

private extension V2PracticeItem {
  func with(status: V2ItemStatus, reflected: Bool) -> V2PracticeItem {
    V2PracticeItem(id: id, shortId: shortId, subject: subject, knowledgeTags: knowledgeTags,
      questionExcerpt: questionExcerpt, badge: badge, status: status, cropUrl: cropUrl, jobId: jobId,
      reason: reason, tier: tier, reflected: reflected, position: position)
  }
  func with(card: V2ItemCard) -> V2PracticeItem {
    V2PracticeItem(id: card.id, shortId: card.shortId, subject: card.subject,
      knowledgeTags: card.knowledgeTags, questionExcerpt: card.questionExcerpt, badge: card.badge,
      status: card.status, cropUrl: card.cropUrl, jobId: card.jobId,
      reason: reason, tier: tier, reflected: reflected, position: position)
  }
}
