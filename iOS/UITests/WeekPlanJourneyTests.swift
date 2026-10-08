import XCTest

/// 学生端重做第 1 期：「今天」卡与底部下一步按钮的界面回归（合成服务器，不连真实服务、不调用 AI）。
/// J7：在合成服务器上只按下一步按钮走完周末 A。
/// TodayStages：首页在 WeekPlan 五个阶段与三种「打开的日子不对」时的样子（截图附件 keepAlways，供人工核对）。
/// 题目、照片、日期都是合成的；不用 LiveTourTests。
@MainActor
final class WeekPlanJourneyTests: XCTestCase {

  // MARK: - J7 只按下一步按钮走完周末 A

  /// 主页上的每一次推进都只点底部下一步按钮（主按钮或它下面的次要按钮）；不点清单行、练习卡、返回键。
  /// 下面几处不是下一步按钮、但没法替他点：系统相册（选一张、点完成）、第一次上传前的说明（必须他自己同意）、
  /// 选题页自己的「就练这些」、系统分享面板（关掉）。
  func testJ7WeekendAWithOnlyTheNextStepButton() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = launch(server)
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))

    // 第 1 步：拍第一页（模拟器没有相机 → 打开相册）。
    XCTAssertTrue(app.staticTexts["today-header"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["today-header"].label, "今天大约 13 分钟，一共 5 步")
    let primary = app.buttons["next-step-primary"]
    XCTAssertEqual(primary.label, "拍第一页")
    XCTAssertEqual(app.staticTexts["next-step-caption"].label, "第 1 步，共 5 步 · 大约 2 分钟")
    shot(app, "j7-01-weekend-a")
    primary.tap()
    pickOnePhotoInSystemPicker(app)
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 10), "第一次上传前先给他看说明")
    let consent = app.buttons["consent-upload"]
    reveal(consent, in: app)
    consent.tap()

    // 第 2 步：AI 找题（等待时主按钮不可点）→ 找完了按钮自己变成第 3 步。
    waitUntil("找完题后下一步变成「选这周要练的题」", timeout: 60) {
      primary.exists && primary.label == "选这周要练的题" && primary.isEnabled
    }
    XCTAssertEqual(app.staticTexts["next-step-caption"].label, "第 3 步，共 5 步 · 大约 1 分钟")
    shot(app, "j7-02-choose-next")
    primary.tap()

    // 选题页：推荐默认全选，「就练这些」是这一页自己的确认。
    let create = app.buttons["create-practice"]
    XCTAssertTrue(create.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["已选 3 道"].waitForExistence(timeout: 10))
    create.tap()

    // 第 4 步：说说为什么错（可跳过）→ 点下一步按钮下面的「跳过，直接打印」。
    waitUntil("建好练习后下一步变成「说说为什么错」") { primary.exists && primary.label == "说说为什么错" }
    let skipWhy = app.buttons["next-step-secondary-skipWhy"]
    XCTAssertTrue(skipWhy.exists)
    XCTAssertEqual(skipWhy.label, "跳过，直接打印")
    shot(app, "j7-03-why-next")
    skipWhy.tap()

    // 第 5 步：打印。就绪后下一步按钮是「打印」（系统分享）；打开过分享后变成「打印好了，回到今天」。
    XCTAssertTrue(app.descendants(matching: .any)["print-preview"].waitForExistence(timeout: 60), "准备好后出现预览")
    let share = app.buttons["print-share"]
    XCTAssertTrue(share.waitForExistence(timeout: 10))
    XCTAssertEqual(share.label, "打印")
    shot(app, "j7-04-print-ready")
    share.tap()
    dismissShareSheet(app)
    let backToToday = app.buttons["next-step-primary"]
    waitUntil("点过打印后下一步变成「打印好了，回到今天」") {
      backToToday.exists && backToToday.label == "打印好了，回到今天"
    }
    shot(app, "j7-05-printed")
    backToToday.tap()

    // 回到今天：「这周的事做完了」，没有主按钮，只留「没打出来？现在打印」。
    XCTAssertTrue(app.descendants(matching: .any)["today-done-title"].waitForExistence(timeout: 15), "回到今天显示这周的事做完了")
    XCTAssertTrue(app.staticTexts["这周的事做完了"].exists)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "下个周末打开 App")).firstMatch.exists)
    XCTAssertEqual(app.staticTexts["next-step-caption"].label, "下次打开：下个周末，录结果")
    XCTAssertTrue(app.buttons["next-step-secondary-print"].exists)
    XCTAssertFalse(app.buttons["next-step-primary"].exists, "做完了的时候不给主按钮")
    XCTAssertEqual(app.navigationBars.buttons.count, 0, "下一步按钮把他带回了今天（不是层层返回）")
    shot(app, "j7-06-done")
  }

  // MARK: - 首页的五个阶段

  /// 阶段 0：没连上（第一次打开）。不带合成服务器参数启动，不发任何网络请求。
  func testStageConnectFirstLaunch() {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["today-connect"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "先连上服务器")).firstMatch.exists)
    XCTAssertEqual(app.buttons["next-step-primary"].label, "扫码连接")
    XCTAssertEqual(app.staticTexts["next-step-caption"].label, "这一步要大人帮一下")
    shot(app, "stage-1-connect")
  }

  /// 阶段：周末 A（第一次用，什么都没有：步骤 1 高亮，没有空白页）。
  func testStageWeekendAFirstUse() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = launch(server)
    XCTAssertTrue(app.staticTexts["today-header"].waitForExistence(timeout: 15))
    XCTAssertEqual(app.staticTexts["today-header"].label, "今天大约 13 分钟，一共 5 步")
    XCTAssertEqual(app.buttons["next-step-primary"].label, "拍第一页")
    XCTAssertTrue(app.buttons["next-step-secondary-skipShoot"].exists)
    shot(app, "stage-2-weekend-a")
  }

  /// 阶段：做完了（练习纸今天刚生成、还没录）。J7 走到同一状态；这里用预置练习单独核对。
  func testStageDoneSameDay() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    server.seedPrintedPractice(daysAgo: 0, week: "2026-W40")
    let app = launch(server)
    XCTAssertTrue(app.descendants(matching: .any)["today-done-title"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "周三晚自习在纸上做")).firstMatch.exists)
    XCTAssertFalse(app.buttons["next-step-primary"].exists)
    XCTAssertEqual(app.buttons["next-step-secondary-print"].label, "没打出来？现在打印")
    shot(app, "stage-3-done")
  }

  /// 阶段：周中（练习纸生成后 3 天）。
  func testStageMidweek() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    server.seedPrintedPractice(daysAgo: 3, week: "2026-W40")
    let app = launch(server)
    XCTAssertTrue(app.staticTexts["today-midweek-title"].waitForExistence(timeout: 15))
    XCTAssertEqual(app.staticTexts["today-midweek-title"].label, "现在是在纸上做练习的时候")
    XCTAssertTrue(app.staticTexts["练习纸：3 道 · 周三晚自习"].exists)
    XCTAssertFalse(app.buttons["next-step-primary"].exists)
    XCTAssertEqual(app.buttons["next-step-secondary-record"].label, "已经做完了？现在录结果")
    XCTAssertEqual(app.buttons["next-step-secondary-capture"].label, "又发了卷子？现在拍")
    shot(app, "stage-4-midweek")
  }

  /// 阶段：下个周末（上周的练习纸生成后 7 天，新的一周）：先拍卷子，再录结果。
  func testStageWeekendB() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    server.seedPrintedPractice(daysAgo: 7, week: "2026-W40")
    server.setCurrentWeek("2026-W41")
    let app = launch(server)
    XCTAssertTrue(app.staticTexts["today-header"].waitForExistence(timeout: 15))
    XCTAssertEqual(app.staticTexts["today-header"].label, "今天大约 16 分钟，一共 6 步")
    XCTAssertTrue(app.buttons["today-step-record"].exists)
    XCTAssertEqual(app.buttons["next-step-primary"].label, "拍第一页")
    shot(app, "stage-5-weekend-b")
    // 这周没发卷子 → 跳过，按钮立刻变成「录练习纸的结果」。
    app.buttons["next-step-secondary-skipShoot"].tap()
    waitUntil("跳过拍照后下一步是录结果") { app.buttons["next-step-primary"].label == "录练习纸的结果" }
    XCTAssertEqual(app.buttons["next-step-secondary-skipRecord"].label, "先跳过，下次再录")
    shot(app, "stage-5b-weekend-b-skip-shoot")
  }

  // MARK: - 打开的日子不对（§3.4）

  /// 两周没打开，上一份一直没录：录结果那一行写明是哪天的那一份。
  func testWrongDayTwoWeeksWithoutOpening() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    server.seedPrintedPractice(daysAgo: 14, week: "2026-W40")
    server.setCurrentWeek("2026-W42")
    let app = launch(server)
    XCTAssertTrue(app.staticTexts["today-header"].waitForExistence(timeout: 15))
    let record = app.buttons["today-step-record"]
    XCTAssertTrue(record.exists)
    XCTAssertTrue(record.label.contains("上一份练习纸（"), record.label)
    XCTAssertTrue(record.label.contains("）还没录"), record.label)
    shot(app, "wrong-1-two-weeks")
  }

  /// 选了题、没生成练习纸就关了 App：再打开停在「说说为什么错」（跳过不保存，再问一次）。
  func testWrongDayChoseButClosedBeforePrinting() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let session = UUID().uuidString
    let app = launch(server, session: session)
    try importAndConsent(app)
    let primary = app.buttons["next-step-primary"]
    waitUntil("找完题后可以选题", timeout: 60) { primary.label == "选这周要练的题" && primary.isEnabled }
    primary.tap()
    let create = app.buttons["create-practice"]
    XCTAssertTrue(create.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["已选 3 道"].waitForExistence(timeout: 10))
    create.tap()
    waitUntil("建好练习") { primary.exists && primary.label == "说说为什么错" }
    // 本次打开里跳过「说说为什么错」只记在内存里。
    XCTAssertTrue(app.buttons["next-step-secondary-skipWhy"].exists)

    // 还没打印就关掉 App，再打开。
    app.terminate()
    app.launchArguments = ["-test-session", session, "-cloud-loopback", "http://127.0.0.1:\(server.port)"]
    app.launch()
    XCTAssertTrue(app.staticTexts["today-header"].waitForExistence(timeout: 15))
    waitUntil("重开后停在说说为什么错") { app.buttons["next-step-primary"].label == "说说为什么错" }
    XCTAssertTrue(app.buttons["next-step-secondary-skipWhy"].exists)
    shot(app, "wrong-2-chose-not-printed")
  }

  /// 连不上服务器（合成服务器停掉后重开）：清单照常显示，注明是保存的内容；要服务器的下一步变灰并说明。
  func testWrongDayServerUnreachableShowsSavedContent() throws {
    let server = try SyntheticRecognitionServer()
    let session = UUID().uuidString
    let app = launch(server, session: session)
    try importAndConsent(app)
    let primary = app.buttons["next-step-primary"]
    waitUntil("找完题后可以选题", timeout: 60) { primary.label == "选这周要练的题" && primary.isEnabled }

    server.stop()
    app.terminate()
    app.launchArguments = ["-test-session", session, "-cloud-loopback", "http://127.0.0.1:\(server.port)"]
    app.launch()
    XCTAssertTrue(app.staticTexts["today-offline"].waitForExistence(timeout: 20), "注明显示的是保存的内容")
    XCTAssertTrue(app.staticTexts["today-offline"].label.contains("显示的是"))
    XCTAssertTrue(app.staticTexts["today-header"].exists, "清单照常显示")
    waitUntil("要服务器的下一步变灰") { primary.exists && !primary.isEnabled }
    XCTAssertEqual(primary.label, "选这周要练的题", "按钮原文字，变灰")
    XCTAssertEqual(app.staticTexts["next-step-caption"].label, "连不上服务器，连上后再继续")
    shot(app, "wrong-3-server-unreachable")
  }

  /// 连接失效（要重新扫码）：今天卡说清楚要大人帮，下一步按钮是「重新扫码」。
  func testWrongDayConnectionExpired() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .unauthorized)
    defer { server.stop() }
    let app = launch(server)
    XCTAssertTrue(app.descendants(matching: .any)["today-connect"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "需要重新扫码")).firstMatch.exists)
    XCTAssertEqual(app.buttons["next-step-primary"].label, "重新扫码")
    shot(app, "wrong-4-connection-expired")
  }

  // MARK: - 公共步骤

  private func launch(_ server: SyntheticRecognitionServer, session: String = UUID().uuidString) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", session, "-cloud-loopback", "http://127.0.0.1:\(server.port)"]
    app.launch()
    return app
  }

  private func importAndConsent(_ app: XCUIApplication) throws {
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))
    let add = app.buttons["add-photos"]
    reveal(add, in: app)
    add.tap()
    pickOnePhotoInSystemPicker(app)
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 10))
    let consent = app.buttons["consent-upload"]
    reveal(consent, in: app)
    consent.tap()
  }

  /// 系统相册：选第一张（模拟器自带的样例照片），点完成。
  private func pickOnePhotoInSystemPicker(_ app: XCUIApplication) {
    let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10), "系统相册应打开")
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let done = app.buttons["Done"].firstMatch
    XCTAssertTrue(done.waitForExistence(timeout: 5))
    done.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
  }

  /// 关掉系统分享面板（不真的打印）。
  private func dismissShareSheet(_ app: XCUIApplication) {
    let sheet = app.otherElements["ActivityListView"]
    _ = sheet.waitForExistence(timeout: 10)
    for label in ["Close", "关闭", "Cancel", "取消"] where app.buttons[label].exists {
      app.buttons[label].firstMatch.tap()
      return
    }
    if sheet.exists {
      sheet.swipeDown(velocity: .fast)
    } else {
      app.swipeDown(velocity: .fast)
    }
  }

  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    for _ in 0..<8 {
      if element.exists && element.isHittable && !coveredByNextStepBar(element, in: app) { break }
      app.swipeUp()
    }
  }

  private func coveredByNextStepBar(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
    let bar = app.otherElements["next-step-bar"]
    guard bar.exists else { return false }
    if bar.frame.contains(element.frame) { return false }
    return element.frame.maxY > bar.frame.minY
  }

  private func shot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func waitUntil(_ description: String, timeout: TimeInterval = 20, _ predicate: () -> Bool) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if predicate() { return }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    XCTFail(description)
  }
}
