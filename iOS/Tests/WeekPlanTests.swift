import XCTest
import Foundation
@testable import StudentCore

// 学生端重做第 1 期：WeekPlan（设计稿 §3.2 规则、§3.4「打开的日子不对」、§4.0、§4.9）。
// 全部是合成数据；日期用固定时区的日历，避免跑测试的机器时区影响「距生成几天」。
final class WeekPlanTests: XCTestCase {

  // MARK: - 合成数据

  private static let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
    return calendar
  }()

  /// 周六 2026-10-10 10:00（上海）。
  private static let saturday = date(2026, 10, 10, 10)
  private static let thisWeek = "2026-W41"
  private static let lastWeek = "2026-W40"

  private static func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
    calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
  }

  private func input(today: Date = WeekPlanTests.saturday, connection: WeekPlan.Connection = .ok,
    weekKey: String? = WeekPlanTests.thisWeek, photos: [String] = [], items: Int = 0,
    local: [WeekPlan.LocalPhoto] = [], practices: [WeekPlan.Practice] = [], preparing: String? = nil,
    skipped: Set<WeekPlan.StepKind> = []) -> WeekPlan.Input {
    WeekPlan.Input(connection: connection, weekKey: weekKey, weekPhotoJobIDs: photos, weekItemCount: items,
      localPhotos: local, practices: practices, preparingPrintID: preparing, skipped: skipped,
      today: today, calendar: Self.calendar)
  }

  /// 本周已建、还没生成练习纸的一份练习。
  private func thisWeekPractice(items: Int = 3, reflected: Int? = 0, generatedAt: Date? = nil,
    answered: Int? = nil) -> WeekPlan.Practice {
    WeekPlan.Practice(id: "pkt_this", week: Self.thisWeek, generatedAt: generatedAt, itemCount: items,
      practiceSlot: "周三晚自习", reflectedCount: reflected, answered: answered)
  }

  /// 上周的练习纸，生成于 daysAgo 天前（相对周六）。
  private func lastWeekPractice(daysAgo: Int, items: Int = 6, answered: Int? = 0, correct: Int? = nil,
    status: String? = "generated") -> WeekPlan.Practice {
    let generated = Self.calendar.date(byAdding: .day, value: -daysAgo, to: Self.saturday)!
    return WeekPlan.Practice(id: "pkt_last", week: Self.lastWeek, generatedAt: generated, itemCount: items,
      practiceSlot: "周三晚自习", reflectedCount: items, answered: answered, independentCorrect: correct,
      status: status)
  }

  private func photo(_ number: Int, _ state: WeekPlan.LocalPhoto.State, job: String? = nil) -> WeekPlan.LocalPhoto {
    WeekPlan.LocalPhoto(number: number, taskID: UUID(), jobID: job, state: state)
  }

  private func kinds(_ result: WeekPlan.Result) -> [WeekPlan.StepKind] { result.steps.map(\.kind) }

  // MARK: - 规则 0：先连上

  func testUnpairedShowsConnectWithScanAndNoSteps() {
    let result = WeekPlan.make(input(connection: .unpaired, practices: [thisWeekPractice()]))
    XCTAssertEqual(result.stage, .connect(.unpaired))
    XCTAssertTrue(result.steps.isEmpty, "没连上时不显示步骤")
    XCTAssertEqual(result.next?.primary?.title, "扫码连接")
    XCTAssertEqual(result.next?.primary?.action, .scan)
  }

  func testUnauthorizedAndIncompatibleAskForANewQRCode() {
    let unauthorized = WeekPlan.make(input(connection: .unauthorized))
    XCTAssertEqual(unauthorized.stage, .connect(.unauthorized))
    XCTAssertEqual(unauthorized.next?.primary?.title, "重新扫码")
    XCTAssertEqual(unauthorized.next?.primary?.action, .rescan)
    let incompatible = WeekPlan.make(input(connection: .incompatible))
    XCTAssertEqual(incompatible.stage, .connect(.incompatible))
    XCTAssertEqual(incompatible.next?.primary?.title, "扫新的二维码", "原「查看帮助」名不副实")
    XCTAssertEqual(incompatible.next?.primary?.action, .rescan)
  }

  func testWithoutWeekViewOnlyShowsLoading() {
    let result = WeekPlan.make(input(weekKey: nil, practices: [thisWeekPractice()]))
    XCTAssertEqual(result.stage, .loading)
    XCTAssertTrue(result.steps.isEmpty)
    XCTAssertNil(result.next)
  }

  // MARK: - 规则 4：周末 A

  func testFirstUseWeekendAHighlightsShootingWithFiveSteps() {
    let result = WeekPlan.make(input())
    XCTAssertEqual(result.stage, .weekendA)
    XCTAssertEqual(kinds(result), [.shoot, .pick, .choose, .why, .print])
    XCTAssertEqual(result.header, "今天大约 13 分钟，一共 5 步")
    XCTAssertEqual(result.currentIndex, 0, "第一次用：步骤 1 高亮，没有空白页")
    XCTAssertEqual(result.steps[0].detail, "整页拍，一页一张")
    XCTAssertEqual(result.next?.primary?.title, "拍第一页")
    XCTAssertEqual(result.next?.primary?.action, .capture)
    XCTAssertEqual(result.next?.caption, "第 1 步，共 5 步 · 大约 2 分钟")
    XCTAssertEqual(result.next?.secondary.map(\.title), ["这周没发卷子，跳过"])
    XCTAssertTrue(result.steps[3].isOptional, "说说为什么错可跳过")
  }

  func testSkippingShootMovesToChooseAndSaysNoNewPapers() {
    let result = WeekPlan.make(input(skipped: [.shoot]))
    XCTAssertTrue(result.steps[0].isDone)
    XCTAssertEqual(result.steps[0].detail, "这周没拍卷子")
    XCTAssertEqual(result.steps[1].detail, "这周没有新卷子")
    XCTAssertTrue(result.steps[1].isDone)
    XCTAssertEqual(result.currentIndex, 2)
    XCTAssertEqual(result.next?.primary?.title, "选这周要练的题")
    XCTAssertEqual(result.next?.caption, "第 3 步，共 5 步 · 大约 1 分钟")
  }

  func testPhotosBeingFoundMakeTheButtonWaitWithoutSecondaryInWeekendA() {
    let result = WeekPlan.make(input(local: [photo(1, .uploading), photo(2, .finding, job: "job-2")]))
    XCTAssertEqual(result.steps[0].detail, "已拍 2 张")
    XCTAssertEqual(result.steps[1].detail, "AI 正在找题（2 张）")
    XCTAssertEqual(result.steps[1].tone, .blue)
    XCTAssertEqual(result.currentIndex, 1)
    XCTAssertEqual(result.next?.primary?.title, "AI 正在找题…")
    XCTAssertEqual(result.next?.isEnabled, false)
    XCTAssertEqual(result.next?.isWaiting, true)
    XCTAssertTrue(result.next?.secondary.isEmpty ?? false, "周末 A 等待时没有别的事可先做")
  }

  func testPageWithoutMarksAsksToTickThatPhoto() throws {
    let needsPick = photo(3, .needsPick, job: "job-3")
    let result = WeekPlan.make(input(photos: ["job-1", "job-3"], items: 3, local: [needsPick]))
    XCTAssertEqual(result.steps[0].detail, "已拍 2 张", "已登记的照片与本机照片不重复计数")
    XCTAssertEqual(result.steps[1].detail, "第 3 张要你勾")
    XCTAssertEqual(result.steps[1].tone, .orange)
    XCTAssertEqual(result.next?.primary?.title, "勾第 3 张")
    XCTAssertEqual(result.next?.primary?.action, .openPick(taskID: try XCTUnwrap(needsPick.taskID)))
  }

  func testPhotosStillOnThePhoneAskToUpload() {
    let result = WeekPlan.make(input(local: [photo(1, .notUploaded)]))
    XCTAssertEqual(result.steps[1].detail, "1 张还没上传")
    XCTAssertEqual(result.next?.primary?.title, "上传照片")
    XCTAssertEqual(result.next?.primary?.action, .uploadPending)
    XCTAssertEqual(result.next?.caption, "照片还在手机上，传上去 AI 才能找题")
  }

  func testUnrecognisedPhotoDoesNotBlockButIsShownInOrange() {
    let result = WeekPlan.make(input(photos: ["job-1", "job-2"], items: 9, local: [photo(2, .failed, job: "job-2")]))
    XCTAssertTrue(result.steps[1].isDone, "没认出来的照片不挡路")
    XCTAssertEqual(result.steps[1].detail, "找到 9 道错题")
    XCTAssertEqual(result.steps[1].warning, "1 张没认出来")
    XCTAssertEqual(result.next?.primary?.title, "选这周要练的题")
  }

  func testAfterChoosingTheWhyStepIsNextAndSkippable() {
    let result = WeekPlan.make(input(photos: ["job-1"], items: 3, practices: [thisWeekPractice()]))
    XCTAssertEqual(result.steps[2].detail, "选了 3 道")
    XCTAssertEqual(result.currentIndex, 3)
    XCTAssertEqual(result.next?.primary?.title, "说说为什么错")
    XCTAssertEqual(result.next?.primary?.action, .why(practiceID: "pkt_this"))
    XCTAssertEqual(result.next?.secondary.map(\.title), ["跳过，直接打印"])
    XCTAssertEqual(result.next?.secondary.first?.action, .skipWhy(practiceID: "pkt_this"))
    XCTAssertEqual(result.next?.caption, "第 4 步，共 5 步 · 大约 5 分钟")
  }

  func testPartlyReflectedShowsProgress() {
    let result = WeekPlan.make(input(photos: ["job-1"], practices: [thisWeekPractice(items: 6, reflected: 2)]))
    XCTAssertEqual(result.steps[3].detail, "说了 2/6 道")
    XCTAssertFalse(result.steps[3].isDone)
  }

  func testSkippingWhyOrReflectingAllLeadsToPrint() {
    let skipped = WeekPlan.make(input(photos: ["job-1"], practices: [thisWeekPractice()], skipped: [.why]))
    XCTAssertTrue(skipped.steps[3].isDone)
    XCTAssertEqual(skipped.steps[3].detail, "跳过了")
    XCTAssertEqual(skipped.next?.primary?.title, "打印练习纸")
    XCTAssertEqual(skipped.next?.primary?.action, .print(practiceID: "pkt_this"))
    let reflected = WeekPlan.make(input(photos: ["job-1"], practices: [thisWeekPractice(reflected: 3)]))
    XCTAssertEqual(reflected.steps[3].detail, "说了 3/3 道")
    XCTAssertEqual(reflected.next?.primary?.title, "打印练习纸")
  }

  func testPreparingPrintSaysSo() {
    let result = WeekPlan.make(input(photos: ["job-1"], practices: [thisWeekPractice(reflected: 3)], preparing: "pkt_this"))
    XCTAssertEqual(result.steps[4].detail, "正在准备练习纸…")
    XCTAssertEqual(result.steps[4].tone, .blue)
  }

  // MARK: - 规则 1：做完了（≤ 1 天）

  func testPrintedTodayShowsDoneWithoutPrimaryButton() {
    let printed = thisWeekPractice(reflected: 3, generatedAt: Self.date(2026, 10, 10, 9))
    let result = WeekPlan.make(input(photos: ["job-1"], practices: [printed]))
    XCTAssertEqual(result.stage, .done)
    XCTAssertTrue(result.steps.isEmpty)
    XCTAssertNil(result.next?.primary, "这时候他不该在手机上做事")
    XCTAssertEqual(result.next?.caption, "下次打开：下个周末，录结果")
    XCTAssertEqual(result.next?.secondary.map(\.title), ["没打出来？现在打印"],
      "手机不知道他是否真的打印了，这个入口一直留着")
    XCTAssertEqual(result.practice?.id, "pkt_this")
  }

  func testPrintedLateYesterdayIsStillDoneAcrossMidnight() {
    let printed = thisWeekPractice(generatedAt: Self.date(2026, 10, 9, 23, 50))
    let result = WeekPlan.make(input(today: Self.date(2026, 10, 10, 0, 10), practices: [printed]))
    XCTAssertEqual(WeekPlan.daysSince(Self.date(2026, 10, 9, 23, 50), today: Self.date(2026, 10, 10, 0, 10),
      calendar: Self.calendar), 1, "按本地日历日算，不按 24 小时")
    XCTAssertEqual(result.stage, .done)
  }

  // MARK: - 规则 2：周中（2–4 天）

  func testTwoToFourDaysAfterPrintingIsMidweek() {
    for daysAgo in 2...4 {
      let result = WeekPlan.make(input(practices: [lastWeekPractice(daysAgo: daysAgo)]))
      XCTAssertEqual(result.stage, .midweek, "距生成 \(daysAgo) 天")
      XCTAssertNil(result.next?.primary)
      XCTAssertEqual(result.next?.secondary.map(\.title), ["已经做完了？现在录结果", "又发了卷子？现在拍"])
      XCTAssertEqual(result.next?.secondary.first?.action, .record(practiceID: "pkt_last"))
    }
  }

  func testRecordedMidweekFallsBackToWeekendAOfTheNewWeek() {
    let result = WeekPlan.make(input(practices: [lastWeekPractice(daysAgo: 3, items: 6, answered: 6, correct: 4)]))
    XCTAssertEqual(result.stage, .weekendA, "周中录完了就不再是「周中」，也还不到录结果的周末")
    XCTAssertFalse(kinds(result).contains(.record))
  }

  // MARK: - 规则 3：下个周末（≥ 5 天）

  func testNextWeekendShootsFirstThenRecordsWithSixSteps() {
    let result = WeekPlan.make(input(practices: [lastWeekPractice(daysAgo: 7)]))
    XCTAssertEqual(result.stage, .weekendB)
    XCTAssertEqual(kinds(result), [.shoot, .record, .pick, .choose, .why, .print])
    XCTAssertEqual(result.header, "今天大约 16 分钟，一共 6 步")
    XCTAssertEqual(result.steps[1].detail, "AI 找题要几分钟，正好先录这个")
    XCTAssertEqual(result.next?.primary?.title, "拍第一页")
    XCTAssertEqual(result.next?.caption, "第 1 步，共 6 步 · 大约 2 分钟")
  }

  func testNoNewPapersOnWeekendBGoesStraightToRecording() {
    let result = WeekPlan.make(input(practices: [lastWeekPractice(daysAgo: 5)], skipped: [.shoot]))
    XCTAssertEqual(result.stage, .weekendB, "≥ 5 天就是下个周末")
    XCTAssertEqual(result.next?.primary?.title, "录练习纸的结果")
    XCTAssertEqual(result.next?.primary?.action, .record(practiceID: "pkt_last"))
    XCTAssertEqual(result.next?.secondary.map(\.title), ["先跳过，下次再录"])
    XCTAssertEqual(result.next?.caption, "第 2 步，共 6 步 · 大约 3 分钟")
  }

  func testWeekendBRecordsWhileAIFindsQuestionsThenWaits() {
    let result = WeekPlan.make(input(local: [photo(1, .finding, job: "job-9")], practices: [lastWeekPractice(daysAgo: 7)],
      skipped: []))
    // 拍了照片 → 第 1 步完成；录结果是第 2 步（没做），所以当前是录结果。
    XCTAssertEqual(result.next?.primary?.title, "录练习纸的结果")
    // 先跳过录结果 → 当前是「勾出做错的题」在等 AI：次要按钮先去录结果不再出现（已跳过），只等。
    let skipped = WeekPlan.make(input(local: [photo(1, .finding, job: "job-9")], practices: [lastWeekPractice(daysAgo: 7)],
      skipped: [.record]))
    XCTAssertEqual(skipped.steps[1].detail, "先跳过了，下次再录")
    XCTAssertEqual(skipped.next?.isWaiting, true)
    XCTAssertTrue(skipped.next?.secondary.isEmpty ?? false)
  }

  func testPartlyRecordedShowsProgressWhileAIFindsQuestions() {
    // 周末 B 先拍后录：拍完、AI 在找题时当前是录结果（录了一部分显示进度）。
    let partly = WeekPlan.make(input(local: [photo(1, .finding, job: "job-9")],
      practices: [lastWeekPractice(daysAgo: 7, items: 6, answered: 2)]))
    XCTAssertEqual(partly.steps[1].detail, "录了 2/6 道")
    XCTAssertEqual(partly.steps[1].tone, .orange)
    XCTAssertEqual(partly.currentIndex, 1)
  }

  func testRecordedLastWeekShowsResultAndMovesOn() {
    let result = WeekPlan.make(input(local: [photo(1, .finding, job: "job-9")],
      practices: [lastWeekPractice(daysAgo: 7, items: 6, answered: 6, correct: 4)]))
    XCTAssertEqual(result.stage, .weekendB)
    XCTAssertEqual(result.steps[1].detail, "录完了，6 道里独立做对 4 道")
    XCTAssertTrue(result.steps[1].isDone)
    XCTAssertEqual(result.steps[1].action, .summary(practiceID: "pkt_last"))
    XCTAssertEqual(result.next?.primary?.title, "AI 正在找题…")
  }

  func testSkippingRecordIsRememberedOnlyThroughInput() {
    let result = WeekPlan.make(input(practices: [lastWeekPractice(daysAgo: 6)], skipped: [.shoot, .record]))
    XCTAssertTrue(result.steps[1].isDone)
    XCTAssertEqual(result.next?.primary?.title, "选这周要练的题")
    // 不带「跳过」再算一次（等于关掉 App 再开）：又会问。
    let reopened = WeekPlan.make(input(practices: [lastWeekPractice(daysAgo: 6)], skipped: [.shoot]))
    XCTAssertEqual(reopened.next?.primary?.title, "录练习纸的结果")
  }

  func testListStatusReturnedCountsAsRecordedWhenNoSummary() {
    let practice = lastWeekPractice(daysAgo: 7, answered: nil, status: "returned")
    XCTAssertEqual(practice.allRecorded, true)
    let result = WeekPlan.make(input(practices: [practice], skipped: [.shoot]))
    XCTAssertEqual(result.steps[1].detail, "录完了")
    XCTAssertEqual(result.next?.primary?.title, "选这周要练的题")
    XCTAssertNil(lastWeekPractice(daysAgo: 7, answered: nil, status: "generated").allRecorded, "不知道就不说录完")
  }

  // MARK: - §3.4 打开的日子不对

  func testTwoWeeksWithoutOpeningNamesTheOldPaper() {
    let result = WeekPlan.make(input(practices: [lastWeekPractice(daysAgo: 14)]))
    XCTAssertEqual(result.stage, .weekendB)
    XCTAssertEqual(result.steps[1].detail, "上一份练习纸（9/26）还没录")
  }

  func testChoseButNeverPrintedStopsAtWhyThenPrint() {
    let chosen = thisWeekPractice(items: 3, reflected: 1)
    let result = WeekPlan.make(input(photos: ["job-1"], practices: [chosen]))
    XCTAssertEqual(result.stage, .weekendA)
    XCTAssertEqual(result.next?.primary?.title, "说说为什么错", "关掉 App 后「跳过」不保存，再问一次")
  }

  func testUnprintedPracticeFromAnEarlierWeekIsStillTheOneToPrint() {
    let stale = WeekPlan.Practice(id: "pkt_old", week: Self.lastWeek, generatedAt: nil, itemCount: 4,
      reflectedCount: 4)
    let result = WeekPlan.make(input(practices: [stale]))
    XCTAssertTrue(result.steps[2].isDone, "选过还没打印的那份题还在，不另选一份")
    XCTAssertEqual(result.next?.primary?.action, .print(practiceID: "pkt_old"))
  }

  func testRecordedOnTheSameDayShowsAllStepsDoneAndNoButton() {
    let printed = thisWeekPractice(reflected: 3, generatedAt: Self.date(2026, 10, 10, 9), answered: 3)
    let result = WeekPlan.make(input(photos: ["job-1"], practices: [printed]))
    XCTAssertEqual(result.stage, .weekendA)
    XCTAssertNil(result.currentIndex)
    XCTAssertNil(result.next)
    XCTAssertEqual(result.steps[4].detail, "练习纸已生成", "只说已生成，不说已打印")
  }

  // MARK: - 没联网 / 服务器忙 / 连不上

  func testOfflineGreysOutServerStepsButNotShooting() {
    let shooting = WeekPlan.make(input(connection: .offline))
    XCTAssertEqual(shooting.next?.isEnabled, true, "拍照不需要服务器")
    XCTAssertEqual(shooting.next?.secondary.map(\.title), ["这周没发卷子，跳过"])
    let choosing = WeekPlan.make(input(connection: .offline, skipped: [.shoot]))
    XCTAssertEqual(choosing.stage, .weekendA, "清单照常显示")
    XCTAssertEqual(choosing.next?.primary?.title, "选这周要练的题", "按钮原文字，变灰")
    XCTAssertEqual(choosing.next?.isEnabled, false)
    XCTAssertEqual(choosing.next?.caption, "没联网，连上后再继续")
  }

  func testBusyAndFailedConnectionsExplainWhy() {
    let busy = WeekPlan.make(input(connection: .busy, skipped: [.shoot]))
    XCTAssertEqual(busy.next?.caption, "服务器有点忙，过一会儿再试")
    XCTAssertEqual(busy.next?.isEnabled, false)
    let failed = WeekPlan.make(input(connection: .failed, skipped: [.shoot]))
    XCTAssertEqual(failed.next?.caption, "连不上服务器，连上后再继续")
  }

  func testOfflineWhileWaitingForAIStopsTheSpinner() {
    let result = WeekPlan.make(input(connection: .offline, local: [photo(1, .finding, job: "job-1")]))
    XCTAssertEqual(result.next?.isWaiting, false)
    XCTAssertEqual(result.next?.isEnabled, false)
    XCTAssertEqual(result.next?.caption, "没联网，连上后再继续")
  }

  func testOfflineMidweekKeepsOnlyThePhoneOnlyShortcut() {
    let result = WeekPlan.make(input(connection: .offline, practices: [lastWeekPractice(daysAgo: 3)]))
    XCTAssertEqual(result.stage, .midweek)
    XCTAssertEqual(result.next?.secondary.map(\.title), ["又发了卷子？现在拍"])
    XCTAssertEqual(result.next?.caption, "没联网，连上后再继续")
  }

  func testOfflineDoneKeepsTheNextTimeLine() {
    let printed = thisWeekPractice(generatedAt: Self.date(2026, 10, 10, 9))
    let result = WeekPlan.make(input(connection: .offline, practices: [printed]))
    XCTAssertEqual(result.stage, .done)
    XCTAssertTrue(result.next?.secondary.isEmpty ?? false)
    XCTAssertEqual(result.next?.caption, "下次打开：下个周末，录结果")
  }

  // MARK: - 本机照片归类（与主页照片进度一致）

  private static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  private static let photoName = "00000000-0000-4000-8000-00000000000d.jpg"

  private func task(status: String, questionStatus: String? = nil, dismissed: Bool? = nil,
    pickDone: Bool? = nil) throws -> LocalRecognitionTask {
    let questions = questionStatus.map {
      [#"{"id":"a42b4eb2-12ff-499f-92de-e49d7cb36ef7","number":"1","revision":1,"status":"\#($0)","selectionEvidence":"unmarked","evidence":null,"verification":null,"questionMediaId":null,"diagramMediaIds":[],"error":null,"confirmedAt":null}"#]
    } ?? []
    let json = #"{"version":1,"id":"\#(Self.jobID)","revision":2,"photoName":"\#(Self.photoName)","sourceHash":"abc","sourceMediaId":"6ddc034b-b0f8-4288-b9c1-4f496cfb90df","status":"\#(status)","phase":"complete","inventoryWarnings":[],"questions":[\#(questions.joined(separator: ","))],"error":null,"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}"#
    let job = try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(json.utf8))
    return LocalRecognitionTask(id: UUID(), photoName: Self.photoName, uploadName: Self.photoName,
      job: job, dismissedFromProgress: dismissed, pickDone: pickDone)
  }

  func testLocalPhotoStatesFollowThePhotoProgressRules() throws {
    XCTAssertEqual(WeekPlan.localState(task: nil, uploading: false), .notUploaded)
    let pending = LocalRecognitionTask(id: UUID(), photoName: Self.photoName, uploadName: Self.photoName)
    XCTAssertEqual(WeekPlan.localState(task: pending, uploading: false), .notUploaded)
    XCTAssertEqual(WeekPlan.localState(task: pending, uploading: true), .uploading)
    XCTAssertEqual(WeekPlan.localState(task: try task(status: "processing", questionStatus: "processing"), uploading: false), .finding)
    XCTAssertEqual(WeekPlan.localState(task: try task(status: "completed", questionStatus: "unselected"), uploading: false), .needsPick)
    XCTAssertNil(WeekPlan.localState(task: try task(status: "completed", questionStatus: "unselected", pickDone: true), uploading: false),
      "点过「这页没有错题」就走完了")
    XCTAssertNil(WeekPlan.localState(task: try task(status: "completed", questionStatus: "confirmed"), uploading: false))
    XCTAssertEqual(WeekPlan.localState(task: try task(status: "failed"), uploading: false), .failed)
    XCTAssertNil(WeekPlan.localState(task: try task(status: "failed", dismissed: true), uploading: false), "移除的失败照片不再算")
  }

  func testNextStepActionsThatNeedTheServer() {
    XCTAssertFalse(NextStepAction.capture.needsServer)
    XCTAssertFalse(NextStepAction.skipShoot.needsServer)
    XCTAssertFalse(NextStepAction.skipRecord.needsServer)
    XCTAssertTrue(NextStepAction.choose.needsServer)
    XCTAssertTrue(NextStepAction.print(practiceID: "p").needsServer)
    XCTAssertTrue(NextStepAction.uploadPending.needsServer)
  }
}
