import XCTest

/// 原生端对齐网页版的走查：连本机开发网关（真实网关 + 合成识别，不碰线上数据），逐屏截图。默认跳过。
///
/// 运行前提：本机起网关（见 docs/ios-native-invitation-login.md「/s/native/web」），传入环境变量
/// `TEST_RUNNER_SEL_WEB_BASE=http://127.0.0.1:<端口>`、`TEST_RUNNER_SEL_WEB_CODE=<邀请码>`、
/// `TEST_RUNNER_SEL_WEB_PHOTO=<一张 JPEG 的路径>`、`TEST_RUNNER_SEL_TOUR_SHOTS=<截图目录>`。
final class WebParityTourTests: XCTestCase {
  private var environment: [String: String] { ProcessInfo.processInfo.environment }
  private var shots: String { environment["SEL_TOUR_SHOTS"] ?? NSTemporaryDirectory() }
  private var index = 0

  @MainActor private func shot(_ name: String) {
    index += 1
    let data = XCUIScreen.main.screenshot().pngRepresentation
    try? data.write(to: URL(fileURLWithPath: shots).appendingPathComponent(String(format: "%02d-%@.png", index, name)))
  }

  @MainActor private func launch(session: String, photo: String? = nil) throws -> XCUIApplication {
    guard let base = environment["SEL_WEB_BASE"] else { throw XCTSkip("no live gateway") }
    let app = XCUIApplication()
    app.launchArguments = ["-cloud-loopback", base, "-test-session", session]
    if let photo { app.launchArguments += ["-inject-photo", photo] }
    app.launch()
    return app
  }

  @MainActor func testTourLoginStageNotebookIntakeItemSettings() throws {
    let session = UUID().uuidString
    var app = try launch(session: session)
    let code = try XCTUnwrap(environment["SEL_WEB_CODE"])
    let photo = try XCTUnwrap(environment["SEL_WEB_PHOTO"])

    // 登录
    let field = app.textFields["invite-code"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
    shot("login")
    field.tap(); field.typeText(code + "\n") // 回车键就是「前往」：直接提交，不用去够被键盘盖住的按钮

    // 新账号先选学段
    XCTAssertTrue(app.buttons["stage-初中"].waitForExistence(timeout: 20), app.debugDescription)
    shot("stage-gate")
    app.buttons["stage-初中"].tap()

    // 空错题本
    XCTAssertTrue(app.buttons["capture-album"].waitForExistence(timeout: 20) || app.staticTexts["拍一张批改过的卷子"].waitForExistence(timeout: 20), app.debugDescription)
    shot("empty-notebook")

    // 重新打开：登录态保存在钥匙串里；带一张照片，相当于从相册选了它
    app.terminate()
    app = try launch(session: session, photo: photo)
    XCTAssertTrue(app.staticTexts["intake-status"].waitForExistence(timeout: 20), app.debugDescription)
    shot("intake-uploading")
    // 没有批改痕迹的页：先勾出做错的题，再「加入」
    let candidate = app.buttons["pick-candidate"].firstMatch
    XCTAssertTrue(candidate.waitForExistence(timeout: 60), app.debugDescription)
    shot("intake-candidates")
    candidate.tap()
    shot("intake-picked")
    app.buttons["pick-submit"].tap()
    let question = app.buttons["intake-question"].firstMatch
    XCTAssertTrue(question.waitForExistence(timeout: 60), app.debugDescription)
    shot("intake-found")
    app.buttons["intake-done"].tap()

    // 错题本里出现这道题；网格视图
    let card = app.buttons["item-card"].firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 20), app.debugDescription)
    shot("notebook-list")
    app.buttons["notebook-filters"].tap()
    app.buttons["网格"].tap()
    XCTAssertTrue(app.buttons["item-card"].firstMatch.waitForExistence(timeout: 10))
    shot("notebook-grid")

    // 详情
    app.buttons["item-card"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["item-category"].waitForExistence(timeout: 20), app.debugDescription)
    sleep(2)
    shot("item-detail")
    app.navigationBars.buttons.firstMatch.tap()

    // 设置
    app.buttons["settings-link"].tap()
    XCTAssertTrue(app.buttons["logout"].waitForExistence(timeout: 15), app.debugDescription)
    shot("settings")
    app.buttons["logout"].tap()
    app.buttons["退出登录"].firstMatch.tap()
    XCTAssertTrue(app.textFields["invite-code"].waitForExistence(timeout: 15), app.debugDescription)
    shot("logged-out")
  }
}
