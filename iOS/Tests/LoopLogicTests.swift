import XCTest
import Foundation
@testable import StudentCore

// T6c RED：主页与修改面板的纯逻辑（Domain/V2）。
// LoopText.itemStatus / observationKind、IntakePolicy、CorrectionHighlight、DiscardUndo、DirectCorrection。
final class LoopLogicTests: XCTestCase {

  // MARK: - LoopText.itemStatus：题目状态翻成学生看得懂的一句话

  func testItemStatusTexts() {
    XCTAssertEqual(LoopText.itemStatus(.readyForReflection), "还没说为什么错")
    XCTAssertEqual(LoopText.itemStatus(.eligibleForReview), "说过了")
    XCTAssertEqual(LoopText.itemStatus(.scheduled), "已排进本周练习")
    XCTAssertEqual(LoopText.itemStatus(.packetGenerated), "在练习纸上")
    XCTAssertEqual(LoopText.itemStatus(.needsRecheck), "上次没独立做对，要再练")
    XCTAssertEqual(LoopText.itemStatus(.temporarilyMastered), "真会了（还要再确认一次）")
    XCTAssertEqual(LoopText.itemStatus(.stablyMastered), "稳了")
    XCTAssertEqual(LoopText.itemStatus(.archivedNotWorthReview), "已移出")
  }

  /// 设计稿 §5：主页错题卡不显示「还没说为什么错」「说过了」这类流程状态（卡片上没有入口）。
  func testCardStatusHidesFlowStatesOnly() {
    XCTAssertNil(LoopText.cardStatus(.readyForReflection))
    XCTAssertNil(LoopText.cardStatus(.eligibleForReview))
    XCTAssertEqual(LoopText.cardStatus(.packetGenerated), "在练习纸上")
    XCTAssertEqual(LoopText.cardStatus(.needsRecheck), "上次没独立做对，要再练")
    XCTAssertEqual(LoopText.cardStatus(.unknown("future_status")), "状态更新中")
  }

  func testItemStatusUnknownAndPreBridgeShowUpdating() {
    XCTAssertEqual(LoopText.itemStatus(.unknown("future_status")), "状态更新中")
    XCTAssertEqual(LoopText.itemStatus(.captured), "状态更新中")
    XCTAssertEqual(LoopText.itemStatus(.needsReview), "状态更新中")
  }

  // MARK: - LoopText.observationKind：观察记录种类的展示名

  func testObservationKindLabels() {
    XCTAssertEqual(LoopText.observationKind("student_work"), "你的作答")
    XCTAssertEqual(LoopText.observationKind("correction"), "订正")
    XCTAssertEqual(LoopText.observationKind("teacher_note"), "老师批注")
    XCTAssertEqual(LoopText.observationKind("reference_answer"), "参考答案")
    XCTAssertEqual(LoopText.observationKind("something_new"), "识别记录")
  }

  // MARK: - IntakePolicy：已同意 / 连接就绪 / 未上传照片 / 上传中 → 下一步动作

  func testIntakeNoPendingIsIdle() {
    XCTAssertEqual(IntakePolicy.next(hasConsented: true, connectionReady: true, pendingPhotos: [], isUploading: false), .idle)
    XCTAssertEqual(IntakePolicy.next(hasConsented: false, connectionReady: false, pendingPhotos: [], isUploading: false), .idle)
  }

  func testIntakeAsksConsentOnceBeforeFirstUpload() {
    XCTAssertEqual(
      IntakePolicy.next(hasConsented: false, connectionReady: true, pendingPhotos: ["a.jpg"], isUploading: false),
      .askConsent(["a.jpg"]))
    // 未同意时即使连接没就绪，也先问同意（同意与连接检查无先后依赖）。
    XCTAssertEqual(
      IntakePolicy.next(hasConsented: false, connectionReady: false, pendingPhotos: ["a.jpg"], isUploading: false),
      .askConsent(["a.jpg"]))
  }

  func testIntakeWaitsForConnectionAfterConsent() {
    XCTAssertEqual(
      IntakePolicy.next(hasConsented: true, connectionReady: false, pendingPhotos: ["a.jpg"], isUploading: false),
      .waitForConnection)
  }

  func testIntakeAutoUploadsAtMostTenAfterConsent() {
    let names = (1...12).map { "photo\($0).jpg" }
    XCTAssertEqual(
      IntakePolicy.next(hasConsented: true, connectionReady: true, pendingPhotos: names, isUploading: false),
      .upload(Array(names.prefix(10))))
  }

  func testIntakeUploadingIsIdle() {
    XCTAssertEqual(
      IntakePolicy.next(hasConsented: true, connectionReady: true, pendingPhotos: ["a.jpg"], isUploading: true),
      .idle)
  }

  // MARK: - CorrectionHighlight：改前 → 改后 的高亮分段

  func testHighlightSegmentsAroundFoundFragment() {
    XCTAssertEqual(
      CorrectionHighlight.segments(before: "已知 x+y=1，求 x 的值。", after: "已知 x+y=1，求 y 的值。",
        find: "x 的值", replace: "y 的值"),
      [.plain("已知 x+y=1，求 "), .removed("x 的值"), .added("y 的值"), .plain("。")])
  }

  func testHighlightFallsBackToWholeComparisonWhenFindMissing() {
    XCTAssertEqual(
      CorrectionHighlight.segments(before: "整段原文", after: "整段改后", find: "找不到的片段", replace: "替换"),
      [.removed("整段原文"), .added("整段改后")])
    XCTAssertEqual(
      CorrectionHighlight.segments(before: "整段原文", after: "整段改后", find: nil, replace: nil),
      [.removed("整段原文"), .added("整段改后")])
    XCTAssertEqual(
      CorrectionHighlight.segments(before: "整段原文", after: "整段改后", find: "", replace: ""),
      [.removed("整段原文"), .added("整段改后")])
  }

  func testHighlightMatchAtEdges() {
    XCTAssertEqual(
      CorrectionHighlight.segments(before: "x 的值是多少", after: "y 的值是多少", find: "x 的值", replace: "y 的值"),
      [.removed("x 的值"), .added("y 的值"), .plain("是多少")])
    XCTAssertEqual(
      CorrectionHighlight.segments(before: "求 x 的值", after: "求 y 的值", find: "x 的值", replace: "y 的值"),
      [.plain("求 "), .removed("x 的值"), .added("y 的值")])
  }

  // MARK: - DiscardUndo：「不是错题」的撤销计时状态

  func testDiscardUndoLifecycle() throws {
    var undo = DiscardUndo()
    XCTAssertFalse(undo.isVisible)
    let start = Date()
    undo.begin(itemID: "itm_0a1b2c3d4e5f6071", at: start)
    XCTAssertTrue(undo.isVisible)
    XCTAssertEqual(undo.expiresAt, start.addingTimeInterval(8), "8 秒撤销窗口")

    // 窗口内 tick 不消失。
    undo.tick(now: start.addingTimeInterval(7.9))
    XCTAssertTrue(undo.isVisible)

    // 撤销返回待恢复的题目并清空。
    XCTAssertEqual(undo.undo(), "itm_0a1b2c3d4e5f6071")
    XCTAssertFalse(undo.isVisible)
  }

  func testDiscardUndoExpiresAfterWindow() {
    var undo = DiscardUndo()
    let start = Date()
    undo.begin(itemID: "itm_0a1b2c3d4e5f6071", at: start)
    undo.tick(now: start.addingTimeInterval(8))
    XCTAssertFalse(undo.isVisible, "8 秒后撤销条消失")
    XCTAssertNil(undo.undo(), "过期后撤销不到题目")
  }

  func testDiscardUndoNewDiscardReplacesOld() {
    var undo = DiscardUndo()
    let start = Date()
    undo.begin(itemID: "itm_0a1b2c3d4e5f6071", at: start)
    undo.begin(itemID: "itm_1111111111111111", at: start.addingTimeInterval(2))
    XCTAssertEqual(undo.pendingItemID, "itm_1111111111111111", "同一时间只有一条撤销条，新的顶替旧的")
    XCTAssertEqual(undo.expiresAt, start.addingTimeInterval(10))
  }

  // MARK: - LoopText.canDiscard：只有「待复盘」「已复盘，等着进练习」能移出（服务器规则）

  func testCanDiscardOnlyBeforeScheduling() {
    XCTAssertTrue(LoopText.canDiscard(.readyForReflection))
    XCTAssertTrue(LoopText.canDiscard(.eligibleForReview))
    let rest: [V2ItemStatus] = [.captured, .needsReview, .scheduled, .packetGenerated, .attempted,
      .needsRecheck, .temporarilyMastered, .stablyMastered, .archivedNotWorthReview, .unknown("future")]
    for status in rest {
      XCTAssertFalse(LoopText.canDiscard(status), "\(status) 不显示「不是错题」")
    }
  }

  // MARK: - T6c-R1 SpeechText.merge：语音整句替换（相对基底替换，不追加）

  func testSpeechMergeEmptyBaseUsesTranscript() {
    XCTAssertEqual(SpeechText.merge(base: "", transcript: "题目求的是 y"), "题目求的是 y")
  }

  func testSpeechMergeNonEmptyBaseConcatenatesWithoutSpace() {
    // 基底非空时直接接上，中文之间不加空格。
    XCTAssertEqual(SpeechText.merge(base: "这一题", transcript: "题目求的是 y 不是 x"), "这一题题目求的是 y 不是 x")
  }

  func testSpeechMergeEmptyTranscriptKeepsBase() {
    XCTAssertEqual(SpeechText.merge(base: "这一题", transcript: ""), "这一题")
  }

  func testSpeechMergePartialResultsKeepOnlyLatest() {
    // 连续三个中间结果：每次都相对同一基底替换，只保留最后一个，不叠加成「题目 题目求的 …」。
    let base = "前面："
    let partials = ["题目", "题目求的", "题目求的是 y"]
    var text = base
    for partial in partials { text = SpeechText.merge(base: base, transcript: partial) }
    XCTAssertEqual(text, "前面：题目求的是 y")
  }

  // MARK: - T6c-R1 SpeechGate：权限状态 → 界面呈现（按住可录 / 按下先请求 / 只留键盘）

  func testSpeechGateKeyboardOnlyWithoutRecognizer() {
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: false, speech: .notAsked, mic: .notAsked), .keyboardOnly)
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: false, speech: .allowed, mic: .allowed), .keyboardOnly)
  }

  func testSpeechGateDeniedIsKeyboardOnly() {
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: true, speech: .denied, mic: .notAsked), .keyboardOnly)
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: true, speech: .notAsked, mic: .denied), .keyboardOnly)
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: true, speech: .allowed, mic: .denied), .keyboardOnly)
  }

  func testSpeechGateNotAskedShowsButtonAndAsksOnPress() {
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: true, speech: .notAsked, mic: .notAsked), .askOnPress)
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: true, speech: .allowed, mic: .notAsked), .askOnPress)
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: true, speech: .notAsked, mic: .allowed), .askOnPress)
  }

  func testSpeechGateBothAllowedRecordsOnPress() {
    XCTAssertEqual(SpeechGate.presentation(recognizerExists: true, speech: .allowed, mic: .allowed), .holdToTalk)
  }

  // MARK: - DirectCorrection：键盘直改的 changes 构造（before 与当前值一致；无改动为空）

  private func evidence() -> V2Evidence {
    V2Evidence(questionText: "已知 x+y=1，求 x 的值。", subject: "数学",
      knowledgeTags: ["一元一次方程"],
      observations: [V2Evidence.Observation(id: "o1", kind: "student_work", text: "x=1")],
      badge: .ok, revision: 1)
  }

  func testDirectChangesOnlyEditedFields() throws {
    let changes = DirectCorrection.changes(evidence: evidence(),
      questionText: "已知 x+y=1，求 y 的值。", subject: "数学",
      knowledgeTagsText: "一元一次方程", observationTexts: ["o1": "x=1"])
    XCTAssertEqual(changes, [V2CorrectionChange(field: .questionText, observationId: nil,
      before: "已知 x+y=1，求 x 的值。", after: "已知 x+y=1，求 y 的值。", find: nil, replace: nil)])
  }

  func testDirectChangesNoEditsIsEmpty() {
    XCTAssertTrue(DirectCorrection.changes(evidence: evidence(),
      questionText: "已知 x+y=1，求 x 的值。", subject: "数学",
      knowledgeTagsText: "一元一次方程", observationTexts: ["o1": "x=1"]).isEmpty)
  }

  func testDirectChangesSubjectTagsAndObservation() throws {
    let changes = DirectCorrection.changes(evidence: evidence(),
      questionText: "已知 x+y=1，求 x 的值。", subject: "物理",
      knowledgeTagsText: "方程， 计算", observationTexts: ["o1": "x=2"])
    XCTAssertEqual(changes.count, 3)
    let subject = try XCTUnwrap(changes.first { $0.field == .subject })
    XCTAssertEqual(subject.before, "数学")
    XCTAssertEqual(subject.after, "物理")
    let tags = try XCTUnwrap(changes.first { $0.field == .knowledgeTags })
    // 接口约定：knowledgeTags 的 before/after 是 JSON 数组字符串；逗号支持中英文。
    XCTAssertEqual(tags.after, #"["方程","计算"]"#)
    XCTAssertEqual(tags.before, #"["一元一次方程"]"#)
    let observation = try XCTUnwrap(changes.first { $0.field == .observation })
    XCTAssertEqual(observation.observationId, "o1")
    XCTAssertEqual(observation.before, "x=1")
    XCTAssertEqual(observation.after, "x=2")
  }
}
