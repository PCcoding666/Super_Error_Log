import XCTest

final class LiveRecognitionJourneyTests: XCTestCase {
  @MainActor
  func testInitialRecognitionActionIsAboveFloatingTabBar() {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch(); importOnePhoto(app)
    let button = app.buttons["recognize-selected"]
    XCTAssertTrue(button.waitForExistence(timeout: 5))
    XCTAssertTrue(button.isHittable)
    XCTAssertLessThanOrEqual(button.frame.maxY, app.tabBars.firstMatch.frame.minY)
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = "initial-recognition-safe-area"; attachment.lifetime = .keepAlways; add(attachment)
  }

  @MainActor
  func testSyntheticCollectionSyncReadsSourcesWithoutUploadAndDeduplicates() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch(); configure(app, port: server.port)
    let sync = app.buttons["sync-existing-recognitions"]
    reveal(sync, in: app); sync.tap()
    XCTAssertTrue(app.staticTexts["照片 1 · 已保存在本机"].waitForExistence(timeout: 10))
    reveal(sync, in: app); sync.tap()
    XCTAssertFalse(app.staticTexts["照片 2 · 已保存在本机"].exists)
    XCTAssertEqual(server.uploadCount, 0)
    app.terminate(); app.launch()
    reveal(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recognition-job-")).firstMatch, in: app)
    XCTAssertTrue(app.staticTexts["照片 1 · 已保存在本机"].exists)
    XCTAssertFalse(app.staticTexts["照片 2 · 已保存在本机"].exists)
    XCTAssertEqual(server.uploadCount, 0)
  }

  @MainActor
  func testSyntheticHTTPConfirmedQuestionReflectsPrintsAndSurvivesOfflineRelaunch() throws {
    let server = try SyntheticRecognitionServer(longStem: true)
    defer { server.stop() }
    let app = XCUIApplication()
    let sessionID = UUID().uuidString
    print("SYNTHETIC_PDF_TEST_COLLECTION \(sessionID)")
    app.launchArguments = ["-test-session", sessionID]
    app.launch()
    configure(app, port: server.port)
    importOnePhoto(app)
    XCTAssertEqual(server.requestCount, 0, "Import and pairing must not upload")
    reveal(app.buttons["recognize-selected"], in: app)
    app.buttons["recognize-selected"].tap()
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 5))
    reveal(app.buttons["consent-upload"], in: app)
    app.buttons["consent-upload"].tap()
    let job = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recognition-job-")).firstMatch
    XCTAssertTrue(job.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertFalse(app.buttons["recognize-selected"].exists, "No pending photo action may cover the returned task")
    job.tap()
    app.buttons["candidate-\(SyntheticRecognitionServer.questionID)"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", server.printedStem)).firstMatch.waitForExistence(timeout: 5))
    reveal(app.buttons["confirm-question"], in: app)
    XCTAssertFalse(app.buttons["confirm-question"].isEnabled)
    for _ in 0..<8 where !app.buttons["compare-original"].isHittable { app.swipeDown() }
    app.buttons["compare-original"].tap()
    XCTAssertTrue(app.images["original-photo"].waitForExistence(timeout: 5))
    app.buttons["完成"].tap()
    reveal(app.switches["source-compared"], in: app)
    app.switches["source-compared"].tap()
    app.buttons["confirm-question"].tap()
    XCTAssertTrue(app.staticTexts["已确认，可去“复盘”回想这道题"].waitForExistence(timeout: 10))
    app.tabBars.buttons["复盘"].tap()
    app.buttons["reflect-\(SyntheticRecognitionServer.jobID)/\(SyntheticRecognitionServer.questionID)"].tap()
    inspectReflectionContext(app, stem: server.printedStem)
    server.stop(); app.terminate(); app.launch()
    app.tabBars.buttons["复盘"].tap()
    app.buttons["reflect-\(SyntheticRecognitionServer.jobID)/\(SyntheticRecognitionServer.questionID)"].tap()
    inspectReflectionContext(app, stem: server.printedStem)
    chooseAndAdvance("当时有思路", in: app, expectNext: "下次怎样会更有帮助？")
    chooseAndAdvance("检查每一步计算", in: app, expectNext: "再做一次时，你有多大把握？")
    chooseAndAdvance("需要一点提示", in: app, expectNext: "这周还想再看一遍吗？")
    chooseAndSave("想再做一次", in: app)
    app.buttons["加入练习包"].tap()
    app.buttons["select-\(SyntheticRecognitionServer.jobID)/\(SyntheticRecognitionServer.questionID)"].tap()
    app.buttons["生成练习包"].tap()
    XCTAssertTrue(app.buttons["分享或打印"].waitForExistence(timeout: 10), app.debugDescription)
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = "synthetic-confirmed-real-shaped-pdf"; attachment.lifetime = .keepAlways; add(attachment)
    app.buttons["完成"].tap()
    server.stop()
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["已保存 1 次真实题目复盘"].waitForExistence(timeout: 5))
    app.tabBars.buttons["复盘"].tap()
    app.buttons["reflect-\(SyntheticRecognitionServer.jobID)/\(SyntheticRecognitionServer.questionID)"].tap()
    XCTAssertTrue(app.staticTexts["复盘已保存"].waitForExistence(timeout: 5))
    inspectReflectionContext(app, stem: server.printedStem)
  }

  @MainActor private func inspectReflectionContext(_ app: XCUIApplication, stem: String) {
    let context = app.buttons["查看题目"]
    reveal(context, in: app); context.tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", stem)).firstMatch.exists)
    reveal(app.images["reflection-diagram-0"], in: app)
    XCTAssertTrue(app.images["reflection-diagram-0"].exists)
    reveal(app.staticTexts["合成订正内容，不进入 PDF"], in: app)
    XCTAssertTrue(app.staticTexts["订正痕迹"].exists)
    XCTAssertTrue(app.staticTexts["合成订正内容，不进入 PDF"].exists)
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = "accepted-reflection-context"; attachment.lifetime = .keepAlways; add(attachment)
    let navigationBottom = app.navigationBars.firstMatch.frame.maxY
    for _ in 0..<15 {
      if context.isHittable && context.frame.minY > navigationBottom + 8 { break }
      app.swipeDown()
    }
    XCTAssertGreaterThan(context.frame.minY, navigationBottom + 8, "Disclosure header must be below the sheet navigation bar before tapping")
    context.tap()
    XCTAssertTrue(app.staticTexts["合成订正内容，不进入 PDF"].waitForNonExistence(timeout: 5))
  }

  /// 点选即推进：第 1–3 问选中后自动进入下一问，无需点「继续」。
  @MainActor private func chooseAndAdvance(_ title: String, in app: XCUIApplication, expectNext prompt: String) {
    let choice = app.buttons[title]
    XCTAssertTrue(choice.waitForExistence(timeout: 5))
    reveal(choice, in: app)
    XCTAssertTrue(choice.wait(for: \.isHittable, toEqual: true, timeout: 5))
    choice.tap()
    XCTAssertTrue(app.staticTexts[prompt].waitForExistence(timeout: 5))
  }

  /// 最后一问：选择后手动「保存复盘」。
  @MainActor private func chooseAndSave(_ title: String, in app: XCUIApplication) {
    let choice = app.buttons[title]
    XCTAssertTrue(choice.waitForExistence(timeout: 5))
    reveal(choice, in: app)
    XCTAssertTrue(choice.wait(for: \.isHittable, toEqual: true, timeout: 5))
    choice.tap()
    let save = app.buttons["Save reflection"]
    XCTAssertTrue(save.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    save.tap()
  }

  @MainActor func testCropViewerNeverClaimsFullOriginal() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = XCUIApplication(); app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch(); configure(app, port: server.port)
    reveal(app.buttons["sync-existing-recognitions"], in: app); app.buttons["sync-existing-recognitions"].tap()
    let job = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recognition-job-")).firstMatch
    XCTAssertTrue(job.waitForExistence(timeout: 10)); reveal(job, in: app); job.tap()
    app.buttons["candidate-\(SyntheticRecognitionServer.questionID)"].tap()
    XCTAssertTrue(app.staticTexts["请对照原图确认是这一题；同一页可能出现相同题号。"].exists)
    XCTAssertFalse(app.staticTexts["candidate-position"].exists)
    app.buttons["查看识别位置"].tap()
    XCTAssertTrue(app.staticTexts["candidate-position"].exists)
    XCTAssertTrue(app.staticTexts["candidate-position"].label.hasPrefix("初步定位，尚未核实"))
    let crop = app.buttons["查看来源区域（含原作痕迹）"]
    reveal(crop, in: app); crop.tap()
    XCTAssertTrue(app.images["crop-photo"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["裁剪区域（可能不完整） · 双指缩放"].exists)
    XCTAssertFalse(app.staticTexts["完整原图 · 双指缩放"].exists)
    // 诊断取证（M1 审查）：断言失败前导出屏幕与完整辅助层级，证明 original-photo 命中的是
    // 下层页内联原图还是 sheet 内元素。附件保留，不作为断言依据。
    let diagShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    diagShot.name = "crop-viewer-original-photo-diagnostic"; diagShot.lifetime = .keepAlways; add(diagShot)
    let diagTree = XCTAttachment(string: app.debugDescription)
    diagTree.name = "crop-viewer-accessibility-hierarchy"; diagTree.lifetime = .keepAlways; add(diagTree)
    // 取证证实（crop-diagnostic-attachments）：「original-photo」属于下层题目页（y=-202）的
    // M1 内联原图；裁图查看器是并列分支，含 ScrollView「crop-photo」→ Image「crop-photo」
    // （label 为「裁剪区域（可能不完整）」），无 Sheet 节点。因此否定断言改为作用于裁图查看器
    // 作用域：其中不得出现 original-photo；且裁图查看器恰好一个、图片名称如实标注。
    let cropViewer = app.scrollViews["crop-photo"]
    XCTAssertTrue(cropViewer.exists)
    XCTAssertEqual(app.scrollViews.matching(identifier: "crop-photo").count, 1, "裁图查看器恰好一个")
    XCTAssertFalse(cropViewer.images["original-photo"].exists, "裁图查看器内不得出现完整原图")
    let cropImage = cropViewer.images["crop-photo"]
    XCTAssertTrue(cropImage.exists)
    XCTAssertEqual(cropImage.label, "裁剪区域（可能不完整）", "裁图查看器图片名称不得冒称完整原图")
  }

  @MainActor func testFailedStageRecoveryRequiresDeliberateConfirmation() throws {
    let server = try SyntheticRecognitionServer(recoveryFailure: true)
    defer { server.stop() }
    let app = XCUIApplication(); app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch(); configure(app, port: server.port)
    reveal(app.buttons["sync-existing-recognitions"], in: app); app.buttons["sync-existing-recognitions"].tap()
    let job = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recognition-job-")).firstMatch
    XCTAssertTrue(job.waitForExistence(timeout: 10)); reveal(job, in: app); job.tap()
    app.buttons["candidate-\(SyntheticRecognitionServer.questionID)"].tap()
    let recover = app.buttons["request-stage-recovery"]
    reveal(recover, in: app); XCTAssertTrue(recover.waitForExistence(timeout: 5))
    XCTAssertEqual(recover.label, "重新识别这道题")
    XCTAssertEqual(server.recoveryCount, 0)
    recover.tap()
    XCTAssertTrue(app.staticTexts["重新尝试识别？"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["只继续处理这道题，已完成的内容和历史记录都会保留。此操作会再次请求 AI 服务。"].exists)
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = "explicit-stage-recovery-consent"; attachment.lifetime = .keepAlways; add(attachment)
    app.buttons["暂不重试"].tap(); XCTAssertEqual(server.recoveryCount, 0)
    recover.tap()
    let affirmative = app.alerts.buttons.matching(identifier: "confirm-stage-recovery").firstMatch
    XCTAssertTrue(affirmative.waitForExistence(timeout: 5))
    XCTAssertEqual(affirmative.label, "重新识别")
    affirmative.tap()
    XCTAssertTrue(app.buttons["confirm-question"].waitForExistence(timeout: 10))
    XCTAssertEqual(server.recoveryCount, 1); XCTAssertEqual(server.uploadCount, 0)
  }

  @MainActor
  func testSyntheticNeedsCheckCannotBeBlanketConfirmed() throws {
    let server = try SyntheticRecognitionServer(needsCheck: true)
    defer { server.stop() }
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch(); configure(app, port: server.port); importOnePhoto(app)
    reveal(app.buttons["recognize-selected"], in: app); app.buttons["recognize-selected"].tap()
    reveal(app.buttons["consent-upload"], in: app); app.buttons["consent-upload"].tap()
    let job = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recognition-job-")).firstMatch
    XCTAssertTrue(job.waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["recognize-selected"].exists)
    job.tap()
    app.buttons["candidate-\(SyntheticRecognitionServer.questionID)"].tap()
    // M1：原图页内可读即解锁人工放行；needs_check 永远没有普通确认按钮。
    XCTAssertTrue(app.images["original-photo"].waitForExistence(timeout: 5), "页内原图应真实解码显示")
    reveal(app.buttons["skip-question"], in: app)
    XCTAssertTrue(app.staticTexts["合成测试：此处看不清"].exists)
    XCTAssertFalse(app.buttons["confirm-question"].exists)
    XCTAssertTrue(app.buttons["manual-release"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testSyntheticNeedsCheckManualReleaseUnlocksWithReadableInlineOriginal() throws {
    let server = try SyntheticRecognitionServer(needsCheck: true)
    defer { server.stop() }
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch(); configure(app, port: server.port); importOnePhoto(app)
    reveal(app.buttons["recognize-selected"], in: app); app.buttons["recognize-selected"].tap()
    reveal(app.buttons["consent-upload"], in: app); app.buttons["consent-upload"].tap()
    let job = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recognition-job-")).firstMatch
    XCTAssertTrue(job.waitForExistence(timeout: 15))
    job.tap()
    app.buttons["candidate-\(SyntheticRecognitionServer.questionID)"].tap()
    // M1：页内原图真实解码显示后，人工放行按钮出现（不再要求打开全屏模态框）。
    XCTAssertTrue(app.images["original-photo"].waitForExistence(timeout: 5))
    reveal(app.buttons["manual-release"], in: app)
    XCTAssertTrue(app.buttons["manual-release"].waitForExistence(timeout: 5))
    app.buttons["manual-release"].tap()
    // SwiftUI alert 按钮在辅助树里出现两次（含 DisclosureTriangle 幻影），用 firstMatch（与 confirm-stage-recovery 测试同款规避）。
    let affirm = app.alerts.buttons.matching(identifier: "confirm-manual-release").firstMatch
    XCTAssertTrue(affirm.waitForExistence(timeout: 5))
    affirm.tap()
    // 确认后题目页显示已确认状态；合成服务器收到了 manualRelease 请求
    XCTAssertTrue(app.staticTexts["已确认，可去“复盘”回想这道题"].waitForExistence(timeout: 10))
    XCTAssertEqual(server.manualReleaseCount, 1)
  }

  /// M1：整卡进入任务；页内原图可读即可勾选确认（不强制全屏模态框）；确认后出现双出口，
  /// 「去复盘本题」在同题身份下打开复盘页，返回路径保留。
  @MainActor
  func testWholeCardNavigationInlineOriginalAndConfirmedExits() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch(); configure(app, port: server.port)
    reveal(app.buttons["sync-existing-recognitions"], in: app); app.buttons["sync-existing-recognitions"].tap()
    let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recognition-job-")).firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 10))
    XCTAssertTrue(card.label.contains("待你核对") || card.staticTexts["待你核对 1 道题"].exists,
      "整卡显示真实计数与状态：\(card.label)")
    card.tap()
    app.buttons["candidate-\(SyntheticRecognitionServer.questionID)"].tap()
    // 页内原图：不打开模态框即可满足「来源可读」
    XCTAssertTrue(app.images["original-photo"].waitForExistence(timeout: 5))
    let toggle = app.switches["source-compared"]
    reveal(toggle, in: app)
    XCTAssertTrue(toggle.wait(for: \.isEnabled, toEqual: true, timeout: 5), "原图页内解码成功后勾选可用")
    toggle.tap()
    app.buttons["confirm-question"].tap()
    XCTAssertTrue(app.staticTexts["已确认，可去“复盘”回想这道题"].waitForExistence(timeout: 10))
    // 双出口：本题可复盘；单题任务没有「继续下一道」。
    XCTAssertFalse(app.buttons["continue-next-question"].exists)
    let reflect = app.buttons["reflect-this-question"]
    XCTAssertTrue(reflect.waitForExistence(timeout: 5))
    reveal(reflect, in: app); reflect.tap()
    XCTAssertTrue(app.staticTexts["这次做题时是什么状态？"].waitForExistence(timeout: 5))
    app.buttons["关闭"].tap()
    // 返回路径：回到题目页 → 返回候选列表。
    XCTAssertTrue(app.staticTexts["已确认，可去“复盘”回想这道题"].waitForExistence(timeout: 5))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.buttons["candidate-\(SyntheticRecognitionServer.questionID)"].waitForExistence(timeout: 5))
  }

  @MainActor private func configure(_ app: XCUIApplication, port: UInt16) {
    app.buttons["recognition-settings"].tap()
    let address = app.textFields["pairing-address"]
    address.tap(); address.press(forDuration: 1.2)
    if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
    address.typeText("http://127.0.0.1:\(port)")
    app.secureTextFields["pairing-token"].tap()
    app.secureTextFields["pairing-token"].typeText(SyntheticRecognitionServer.token)
    app.buttons["save-pairing"].tap()
  }

  @MainActor private func importOnePhoto(_ app: XCUIApplication) {
    app.buttons["add-photos"].tap()
    let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10))
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let add = app.buttons["Done"].firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5))
    add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(app.staticTexts["照片 1 · 已保存在本机"].waitForExistence(timeout: 10))
  }

  @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    for _ in 0..<8 {
      if element.exists && element.isHittable && element.frame.maxY < 780 { break }
      app.swipeUp()
    }
  }

  @MainActor
  func testSyntheticPairingKeychainSavesAndSurvivesRelaunch() {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch()
    XCTAssertTrue(app.buttons["recognition-settings"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.alerts["请再试一次"].exists, "Missing keychain entitlement is a real runtime failure")
    app.buttons["recognition-settings"].tap()
    app.secureTextFields["pairing-token"].tap()
    app.secureTextFields["pairing-token"].typeText("synthetic-pairing-only")
    app.buttons["save-pairing"].tap()
    XCTAssertTrue(app.buttons["recognition-settings"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.alerts["请再试一次"].exists)
    app.terminate(); app.launch()
    XCTAssertTrue(app.buttons["recognition-settings"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.alerts["请再试一次"].exists)
    app.buttons["recognition-settings"].tap()
    XCTAssertTrue(app.staticTexts["pairing-saved"].waitForExistence(timeout: 5))
  }
  @MainActor
  func testImportRequiresExplicitConsentAndDeclineStaysLocal() {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch()
    app.buttons["add-photos"].tap()
    let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10))
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let add = app.buttons["Done"].firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5))
    add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let submission = app.buttons["recognize-selected"]
    for _ in 0..<3 where !submission.isHittable { app.swipeUp() }
    XCTAssertTrue(submission.waitForExistence(timeout: 10))
    let localThumbnail = app.images.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-photo-")).firstMatch.identifier
    submission.tap()
    XCTAssertTrue(app.staticTexts["上传前，请确认"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].exists, "Consent must describe the exact selected batch")
    XCTAssertEqual(app.images.matching(NSPredicate(format: "identifier BEGINSWITH %@", "consent-photo-")).count, 1)
    XCTAssertTrue(app.images[localThumbnail.replacingOccurrences(of: "local-photo-", with: "consent-photo-")].exists)
    XCTAssertTrue(app.staticTexts["尚未连接识别服务，请返回连接设置或扫码配对后再上传。"].exists)
    XCTAssertFalse(app.buttons["consent-upload"].isEnabled)
    app.buttons["暂不上传"].tap()
    XCTAssertTrue(app.staticTexts["仅保存在本机，尚未上传"].exists)
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["已保存 0 次真实题目复盘"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testSettingsRejectsRemoteAddressWithoutRequest() {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch()
    app.buttons["recognition-settings"].tap()
    XCTAssertTrue(app.staticTexts["连接本机服务"].waitForExistence(timeout: 5))
    let address = app.textFields["pairing-address"]
    address.tap()
    address.press(forDuration: 1.2)
    if app.menuItems["Select All"].exists { app.menuItems["Select All"].tap() }
    address.typeText("http://example.com:3101")
    XCTAssertFalse(app.buttons["save-pairing"].isEnabled)
  }
}
