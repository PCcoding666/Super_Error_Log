import XCTest

final class StudentJourneyTests: XCTestCase {
  @MainActor
  func testStudentCanReflectMakePaperPackAndRecordAttempt() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch()
    XCTAssertTrue(
      app.staticTexts["想一想，\n下周更轻松。"].waitForExistence(timeout: 10))
    screenshot("01-this-week")
    app.buttons["home-start-reflection"].tap()
    app.buttons["reflect-5516-14"].tap()
    XCTAssertFalse(app.buttons["reflection-next"].isEnabled)
    // 点选即推进：选中后自动进入下一问，无需点「继续」
    app.buttons["当时有思路"].tap()
    XCTAssertTrue(app.staticTexts["下次怎样会更有帮助？"].waitForExistence(timeout: 5))
    app.buttons["检查每一步计算"].tap()
    XCTAssertTrue(app.staticTexts["再做一次时，你有多大把握？"].waitForExistence(timeout: 5))
    app.buttons["需要一点提示"].tap()
    XCTAssertTrue(app.staticTexts["这周还想再看一遍吗？"].waitForExistence(timeout: 5))
    app.buttons["想再做一次"].tap()
    screenshot("02-reflection")
    let saveReflection = app.buttons["Save reflection"]
    XCTAssertEqual(saveReflection.label, "保存复盘")
    saveReflection.tap()
    XCTAssertTrue(app.staticTexts["复盘已保存"].waitForExistence(timeout: 5))
    app.buttons["加入练习包"].tap()
    app.buttons["select-5516-14"].tap()
    app.buttons["生成练习包"].tap()
    XCTAssertTrue(app.buttons["分享或打印"].waitForExistence(timeout: 10))
    screenshot("03-paper-preview")
    app.buttons["完成"].tap()
    app.buttons["记录纸上练习结果"].firstMatch.tap()
    app.buttons["这次独立做出来了"].tap()
    app.buttons["保存结果"].tap()
    XCTAssertTrue(app.staticTexts["学生自述 · 非 AI 评分"].waitForExistence(timeout: 5))
    screenshot("04-review-pack")
    app.terminate()
    app.launch()
    app.tabBars.buttons["练习包"].tap()
    XCTAssertTrue(app.staticTexts["学生自述 · 非 AI 评分"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testDraftResumesWithoutSubmittingAndOriginalIsAvailable() {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch()
    app.buttons["home-start-reflection"].tap()
    app.buttons["reflect-5516-14"].tap()
    app.buttons["查看原图"].tap()
    XCTAssertTrue(app.images["original-photo"].waitForExistence(timeout: 5))
    screenshot("05-original-evidence")
    app.buttons["完成"].tap()
    tapVisibleChoice("一开始就没把握", in: app)
    XCTAssertTrue(
      app.buttons["一开始就没把握"].isSelected,
      "Confirm the answer was actually tapped before testing persistence")
    app.terminate()
    app.launch()
    app.buttons["home-start-reflection"].tap()
    app.buttons["reflect-5516-14"].tap()
    XCTAssertTrue(app.staticTexts["下次怎样会更有帮助？"].exists)
    XCTAssertFalse(app.buttons["reflection-next"].isEnabled)
    app.buttons["上一个问题"].tap()
    XCTAssertTrue(app.buttons["reflection-next"].isEnabled)
    XCTAssertFalse(app.staticTexts["复盘已保存"].exists)
  }

  @MainActor
  func testLargeTextStillAllowsChoosingAndContinuing() {
    let app = XCUIApplication()
    app.launchArguments = [
      "-test-session", UUID().uuidString, "-UIPreferredContentSizeCategoryName",
      "UICTContentSizeCategoryXXXL",
    ]
    app.launch()
    app.buttons["home-start-reflection"].tap()
    app.buttons["reflect-5516-14"].tap()
    tapVisibleChoice("一开始就没把握", in: app)
    // 点选即推进：选择后自动进入下一问（「继续」按钮仍保留，但不再是必经路径）
    XCTAssertTrue(app.staticTexts["下次怎样会更有帮助？"].waitForExistence(timeout: 5))
    screenshot("06-large-text")
  }

  @MainActor
  func testPhotoLibraryImportStaysLocalAndUnprocessed() {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", UUID().uuidString]
    app.launch()
    app.buttons["add-photos"].tap()
    let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10), app.debugDescription)
    // The system photo grid exposes image frames but reports no accessibility
    // hit point on this runtime. Tap the centre of the observed image frame.
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let add = app.buttons["Done"].firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(add.isEnabled)
    add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(app.staticTexts["照片 1 · 已保存在本机"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["仅保存在本机，尚未上传"].exists)
    screenshot("07-import-awaiting-service")
    app.terminate()
    app.launch()
    XCTAssertTrue(app.staticTexts["照片 1 · 已保存在本机"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["已保存 0 次真实题目复盘"].exists)
  }

  @MainActor
  private func tapVisibleChoice(_ title: String, in app: XCUIApplication) {
    let choice = app.buttons[title]
    let footer = app.buttons["reflection-next"]
    // Partial visibility is not enough: on iOS 18 XCTest may tap a clipped
    // button's geometric centre without scrolling it clear of the footer.
    for _ in 0..<4 {
      if choice.isHittable && choice.frame.maxY < footer.frame.minY - 8 { break }
      app.scrollViews.element(boundBy: app.scrollViews.count - 1).swipeUp()
    }
    choice.tap()
  }

  @MainActor
  private func screenshot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
