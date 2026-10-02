import XCTest

/// 探索性走查：连本机真实服务（回环模式 + 真实模型 + 合成试卷），逐屏截图。默认跳过。
///
/// 运行前提（详见 iOS/README.md）：
/// 1. 本机以回环模式启动服务（`SEL_MOBILE_MODE=loopback`，独立数据目录与端口，自备配对口令）。
/// 2. 模拟器里用 `-test-session <UUID>` 启动过一次 App，并在该集合目录放过 `pairing-bootstrap.json`。
/// 3. 传入环境变量：`TEST_RUNNER_SEL_TOUR_SESSION=<UUID>`、`TEST_RUNNER_SEL_TOUR_SHOTS=<截图目录>`。
/// 这些用例会调用真实模型并在该服务的数据里留下合成题目，不要对着线上服务跑。
final class LiveTourTests: XCTestCase {
  private var shots: String { ProcessInfo.processInfo.environment["SEL_TOUR_SHOTS"] ?? NSTemporaryDirectory() }
  private var index = 0

  @MainActor private func shot(_ name: String) {
    index += 1
    let data = XCUIScreen.main.screenshot().pngRepresentation
    let url = URL(fileURLWithPath: shots).appendingPathComponent(String(format: "%02d-%@.png", index, name))
    try? data.write(to: url)
  }

  @MainActor private func launch() throws -> XCUIApplication {
    guard let session = ProcessInfo.processInfo.environment["SEL_TOUR_SESSION"] else { throw XCTSkip("no live session") }
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", session]
    app.launch()
    return app
  }

  @MainActor private func card(_ app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "item-card-")).firstMatch
  }

  @MainActor func testTourHomeDetailCorrectionSettings() throws {
    let app = try launch()
    XCTAssertTrue(card(app).waitForExistence(timeout: 15), app.debugDescription)
    shot("home")
    app.swipeUp(); shot("home-scrolled")
    app.swipeDown(); app.swipeDown()

    // 详情
    card(app).tap()
    sleep(3); shot("detail")
    let correctInDetail = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "item-correct-")).firstMatch
    if correctInDetail.waitForExistence(timeout: 5) {
      if !correctInDetail.isHittable { app.swipeUp() }
      correctInDetail.tap()
      sleep(3); shot("correction-sheet-from-detail")
      let field = app.textFields["correction-instruction"]
      if field.waitForExistence(timeout: 5) {
        field.tap(); field.typeText("题干最后加上：写出检验过程")
        shot("correction-typed")
        app.buttons["correction-generate"].tap()
        let accept = app.buttons["correction-accept"]
        if accept.waitForExistence(timeout: 40) {
          shot("correction-proposal")
          accept.tap()
          sleep(4); shot("after-accept")
        } else { shot("correction-no-proposal") }
      }
      // 若面板没自动关，手动关
      if app.buttons["关闭"].exists { app.buttons["关闭"].tap(); sleep(1) }
      shot("detail-after-correction")
    }
    // 回主页
    if app.navigationBars.buttons.firstMatch.exists { app.navigationBars.buttons.firstMatch.tap() }
    sleep(1); shot("home-after-correction")

    // 直接改字
    let correct = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "item-correct-")).element(boundBy: 1)
    if correct.waitForExistence(timeout: 5) {
      correct.tap(); sleep(3); shot("correction-sheet-from-home")
      if app.buttons["correction-direct"].waitForExistence(timeout: 5) {
        app.buttons["correction-direct"].tap(); sleep(1); shot("correction-direct")
      }
      if app.buttons["关闭"].exists { app.buttons["关闭"].tap(); sleep(1) }
    }

    // 设置
    app.swipeDown(); app.swipeDown()
    app.buttons["open-settings"].tap()
    sleep(2); shot("settings")
  }

  @MainActor func testTourImportUploadRecognize() throws {
    let app = try launch()
    XCTAssertTrue(app.buttons["add-photos"].waitForExistence(timeout: 15))
    app.buttons["add-photos"].tap()
    let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 15), app.debugDescription)
    shot("picker")
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let add = app.buttons["Done"].firstMatch.exists ? app.buttons["Done"].firstMatch : app.buttons["Add"].firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5), app.debugDescription)
    add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    sleep(3); shot("after-import")
    if app.buttons["consent-upload"].waitForExistence(timeout: 8) {
      shot("consent")
      for _ in 0..<5 where !app.buttons["consent-upload"].isHittable { app.swipeUp() }
      app.buttons["consent-upload"].tap()
    }
    sleep(4); shot("uploading")
    sleep(20); shot("recognizing")
    // 等识别完成（真实模型，按题数几分钟）
    let deadline = Date().addingTimeInterval(540)
    var lastCount = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "item-card-")).count
    let startCount = lastCount
    while Date() < deadline {
      sleep(15)
      lastCount = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "item-card-")).count
      if lastCount > startCount { break }
    }
    shot("after-recognition")
    app.swipeUp(); shot("after-recognition-scrolled")
    XCTAssertGreaterThan(lastCount, startCount, "新照片识别完成后，本周错题应自动增加")
  }

  @MainActor private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, max: Int = 10) {
    for _ in 0..<max where !(element.exists && element.isHittable) { app.swipeUp() }
  }

  @MainActor private func back(_ app: XCUIApplication) {
    let button = app.navigationBars.buttons.firstMatch
    if button.exists { button.tap(); sleep(1) }
  }

  /// 语音权限：第一次按下只请求权限，不能闪退。
  @MainActor func testTourVoicePermission() throws {
    let app = try launch()
    XCTAssertTrue(card(app).waitForExistence(timeout: 15))
    let correct = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "item-correct-")).firstMatch
    XCTAssertTrue(correct.waitForExistence(timeout: 5))
    correct.tap(); sleep(3); shot("voice-sheet")
    let talk = app.descendants(matching: .any)["correction-hold-to-talk"]
    if talk.waitForExistence(timeout: 5) {
      talk.press(forDuration: 0.6); sleep(2); shot("voice-after-first-press")
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      for _ in 0..<2 {
        let allow = springboard.buttons["Allow"].exists ? springboard.buttons["Allow"] : springboard.buttons["OK"]
        if allow.waitForExistence(timeout: 4) { allow.tap(); sleep(2) }
      }
      shot("voice-after-permission")
      XCTAssertEqual(app.state, .runningForeground, "请求权限后 App 不能闪退")
      let again = app.descendants(matching: .any)["correction-hold-to-talk"]
      if again.exists { again.press(forDuration: 2.0); sleep(2); shot("voice-after-second-press") }
      XCTAssertEqual(app.state, .runningForeground, "按住说话后 App 不能闪退")
    } else {
      shot("voice-button-missing")
    }
  }

  /// 已有练习：看结果、再打印一份（PDF 预览）。
  @MainActor func testTourExistingPractice() throws {
    let app = try launch()
    XCTAssertTrue(card(app).waitForExistence(timeout: 15))
    let practiceCard = app.descendants(matching: .any)["practice-card"]
    scrollTo(practiceCard, in: app)
    sleep(2); shot("practice-card")
    let summaryButton = app.buttons["practice-summary"].exists ? app.buttons["practice-summary"] : app.buttons["看结果"]
    if summaryButton.exists {
      scrollTo(summaryButton, in: app, max: 3)
      summaryButton.tap(); sleep(3); shot("summary")
      app.swipeUp(); shot("summary-scrolled")
      back(app)
    }
    let reprint = app.buttons["practice-reprint"].exists ? app.buttons["practice-reprint"] : (app.buttons["再打印一份"].exists ? app.buttons["再打印一份"] : app.buttons["打印练习纸"])
    if reprint.exists {
      scrollTo(reprint, in: app, max: 3)
      reprint.tap(); sleep(3); shot("print-start")
      let preview = app.descendants(matching: .any)["print-preview"]
      _ = preview.waitForExistence(timeout: 90)
      sleep(2); shot("print-preview")
      app.swipeUp(); sleep(1); shot("print-preview-scrolled")
      back(app)
    }
    shot("home-end")
  }

  @MainActor private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
  @MainActor private func first(_ app: XCUIApplication, prefix: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
  }
  @MainActor private func tapFirst(_ app: XCUIApplication, ids: [String], labels: [String] = []) -> Bool {
    for id in ids { let e = any(app, id); if e.exists { scrollTo(e, in: app, max: 4); if e.isHittable { e.tap(); return true } } }
    for label in labels { let e = app.buttons[label]; if e.exists { scrollTo(e, in: app, max: 4); if e.isHittable { e.tap(); return true } } }
    return false
  }

  /// 新的一份练习：选题 → 建练习 → 追问复盘（真实 AI）→ 打印 → 录结果 → 看结果。
  @MainActor func testTourNewPracticeLoop() throws {
    let app = try launch()
    XCTAssertTrue(card(app).waitForExistence(timeout: 15))
    scrollTo(any(app, "practice-card"), in: app)
    sleep(2); shot("loop-practice-section")
    if tapFirst(app, ids: ["pick-next-practice", "pick-practice"], labels: ["选下一份要练的题", "选这周要练的题"]) {
      sleep(4); shot("loop-pick")
      app.swipeUp(); shot("loop-pick-scrolled")
      XCTAssertTrue(any(app, "create-practice").waitForExistence(timeout: 5))
      any(app, "create-practice").tap()
      sleep(4); shot("loop-after-create")
    }

    // 去复盘
    scrollTo(any(app, "practice-card"), in: app)
    XCTAssertTrue(tapFirst(app, ids: ["practice-reflect"], labels: ["去复盘"]), "新练习应可去复盘")
    sleep(3); shot("loop-detail")
    let reflect = app.buttons.matching(NSPredicate(format: "label == %@", "复盘这道")).firstMatch
    XCTAssertTrue(reflect.waitForExistence(timeout: 5), app.debugDescription)
    scrollTo(reflect, in: app, max: 5)
    reflect.tap()
    let question = any(app, "followup-question")
    XCTAssertTrue(question.waitForExistence(timeout: 40), "追问问题应出现")
    sleep(1); shot("loop-followup-question")
    let answer = any(app, "followup-answer")
    answer.tap(); answer.typeText("我当时直接把数搬过去了，没想到要变号")
    shot("loop-followup-typed")
    if app.keyboards.count > 0 { app.swipeDown() }
    _ = tapFirst(app, ids: ["followup-send"], labels: ["说完了"])
    // 可能有第二轮
    let submit = any(app, "reflection-submit")
    for _ in 0..<2 {
      if submit.waitForExistence(timeout: 30) { break }
      if any(app, "followup-answer").exists && any(app, "followup-send").exists {
        shot("loop-followup-second-question")
        let again = any(app, "followup-answer"); again.tap(); again.typeText("就是没注意符号")
        _ = tapFirst(app, ids: ["followup-send"], labels: ["说完了"])
      }
    }
    sleep(1); shot("loop-confirm")
    app.swipeUp(); shot("loop-confirm-scrolled")
    _ = tapFirst(app, ids: ["reflect-mastery-2"])
    shot("loop-confirm-chosen")
    _ = tapFirst(app, ids: ["reflection-submit"], labels: ["提交复盘"])
    sleep(4); shot("loop-after-submit")
    // 回到主页
    for _ in 0..<3 where !any(app, "open-settings").exists { back(app) }
    scrollTo(any(app, "practice-card"), in: app)
    shot("loop-card-after-reflect")

    // 打印
    XCTAssertTrue(tapFirst(app, ids: ["practice-print"], labels: ["打印练习纸"]), "应可打印")
    sleep(2); shot("loop-print-preparing")
    _ = any(app, "print-preview").waitForExistence(timeout: 180)
    sleep(2); shot("loop-print-ready")
    back(app)
    scrollTo(any(app, "practice-card"), in: app)
    sleep(2); shot("loop-card-after-print")

    // 录结果（第一题：独立做出 + 对了）
    XCTAssertTrue(tapFirst(app, ids: ["practice-record"], labels: ["录结果"]), "打印后应可录结果")
    sleep(3); shot("loop-return")
    let independent = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "return-completion-", "-independent")).firstMatch
    if independent.waitForExistence(timeout: 5) {
      scrollTo(independent, in: app, max: 3); independent.tap(); sleep(1)
      let yes = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "return-correct-", "-yes")).firstMatch
      if yes.waitForExistence(timeout: 3) { scrollTo(yes, in: app, max: 2); yes.tap() }
      shot("loop-return-filled")
      _ = tapFirst(app, ids: ["return-submit"])
      sleep(4); shot("loop-return-submitted")
      app.swipeUp(); shot("loop-return-submitted-scrolled")
      if tapFirst(app, ids: ["return-view-summary"], labels: ["看结果"]) { sleep(3); shot("loop-summary") }
    }
  }

  /// v2.1a：无批改痕迹的一页 → 勾出错题 → 只读勾出的题 → 进本周错题。
  /// 前提同上，另需模拟器相册里最新的一张（选择器左上角第一张）是无批改痕迹的试卷照片。
  @MainActor func testTourPickFromUnmarkedPage() throws {
    let app = try launch()
    XCTAssertTrue(app.buttons["add-photos"].waitForExistence(timeout: 15))
    let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "item-card-"))
    let startCount = cards.count
    app.buttons["add-photos"].tap()
    let photos = app.images.matching(identifier: "PXGGridLayout-Info")
    XCTAssertTrue(photos.firstMatch.waitForExistence(timeout: 15), app.debugDescription)
    let photo = photos.firstMatch
    shot("pick-picker")
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let add = app.buttons["Done"].firstMatch.exists ? app.buttons["Done"].firstMatch : app.buttons["Add"].firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5), app.debugDescription)
    add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    sleep(3)
    if app.buttons["consent-upload"].waitForExistence(timeout: 8) {
      for _ in 0..<5 where !app.buttons["consent-upload"].isHittable { app.swipeUp() }
      app.buttons["consent-upload"].tap()
    }
    // 等找题完成：出现「勾出错题」
    let pick = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "photo-pick-")).firstMatch
    XCTAssertTrue(pick.waitForExistence(timeout: 240), app.debugDescription)
    shot("pick-row-on-home")
    scrollTo(pick, in: app, max: 4)
    shot("pick-row-visible")
    pick.tap()
    let input = app.textFields["pick-input"]
    XCTAssertTrue(input.waitForExistence(timeout: 10), app.debugDescription)
    sleep(6); shot("pick-sheet")
    input.tap(); input.typeText("第2题，8，还有15")
    sleep(2); shot("pick-sheet-typed")
    app.swipeUp(); sleep(1); shot("pick-sheet-list")
    let confirm = app.buttons["pick-confirm"]
    scrollTo(confirm, in: app, max: 8)
    shot("pick-sheet-confirm")
    XCTAssertTrue(confirm.isEnabled, "输入题号后应有题被勾上")
    confirm.tap()
    sleep(5); shot("pick-after-submit")
    let deadline = Date().addingTimeInterval(420)
    while Date() < deadline, cards.count < startCount + 2 { sleep(10) }
    shot("pick-after-reading")
    app.swipeUp(); shot("pick-after-reading-scrolled")
    XCTAssertGreaterThanOrEqual(cards.count, startCount + 2, "勾出的两道题读完后应进本周错题")
    let missed = app.buttons["pick-missed"]
    if missed.exists {
      scrollTo(missed, in: app, max: 4)
      missed.tap(); sleep(2); shot("pick-missed-list")
    }
  }
}
