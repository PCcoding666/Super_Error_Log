import XCTest

/// Task 5 RED：云端连接状态 UI 旅程。合成服务器（回环传输 + 云端语义）驱动
/// 状态机各分支：服务繁忙（acceptingJobs=false）、授权失效（401）、限流（429）、可以上传。
/// 通过 DEBUG 专用 `-cloud-loopback` 启动参数 + 首次启动自动兑换，注入云模式配对；
/// 绝不连接真实云域名或模型。状态行直接显示在「本周」主屏（无需先打开设置页）。
final class CloudConnectionJourneyTests: XCTestCase {

  @MainActor
  func testBusyStateShowsChineseAction() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .busy)
    defer { server.stop() }
    let app = launchCloudApp(server)
    // 合成服务器返回不接收新任务后，UI 必须显示「服务繁忙」并提供「稍后再试」，
    // 而不是灰色不可用按钮。
    XCTAssertTrue(app.staticTexts["connection-state-busy"].waitForExistence(timeout: 10))
    let retry = app.buttons["retry-connection"]
    XCTAssertTrue(retry.waitForExistence(timeout: 5), "busy 状态必须提供重试入口")
    XCTAssertTrue(retry.isEnabled)
    XCTAssertEqual(app.buttons["repair-connection"].exists, false, "busy 不需要重新配对")
  }

  @MainActor
  func testUnauthorizedShowsRePairAction() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .unauthorized)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-unauthorized"].waitForExistence(timeout: 10))
    let repair = app.buttons["repair-connection"]
    XCTAssertTrue(repair.waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["retry-connection"].exists, false, "授权失效必须引导重新配对，而不是原地重试")
  }

  @MainActor
  func testRateLimitedHealthCheckIsFailedNotUnauthorized() throws {
    // 健康检查被限流（429）：属于连接失败（可重试），不是授权失效。
    let server = try SyntheticRecognitionServer(cloudHealth: .rateLimited)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-failed"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["retry-connection"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["repair-connection"].exists, false)
  }

  @MainActor
  func testReadyStateEnablesUploadAndCopyNamesTheGuangzhouCloud() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .accepting)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))
    importOnePhoto(app)
    let submission = app.buttons["recognize-selected"]
    reveal(submission, in: app)
    submission.tap()
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 5))
    // 云端确认页必须点名目的地（广州云服务器）而不是本机服务文案。
    let guangzhouCopy = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "照片将上传到你的广州云服务器，再由阿里云百炼处理")).firstMatch
    XCTAssertTrue(guangzhouCopy.waitForExistence(timeout: 5))
    let loopbackCopy = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "照片将先发送到这台 Mac 的本机识别服务")).firstMatch
    XCTAssertFalse(loopbackCopy.exists, "云端模式不得再显示本机服务文案")
    reveal(app.buttons["consent-upload"], in: app)
    XCTAssertTrue(app.buttons["consent-upload"].isEnabled, "ready 状态必须允许上传")
    app.buttons["consent-upload"].tap()
    let job = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recognition-job-")).firstMatch
    XCTAssertTrue(job.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertEqual(server.uploadCount, 1, "同意后恰好一次上传")
  }

  @MainActor
  func testBusyHealthCheckBlocksUploadButPhotosStayLocal() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .busy)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-busy"].waitForExistence(timeout: 10))
    importOnePhoto(app)
    let submission = app.buttons["recognize-selected"]
    reveal(submission, in: app)
    submission.tap()
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 5))
    reveal(app.buttons["consent-upload"], in: app)
    app.buttons["consent-upload"].tap()
    // 每批提交前强制重查 health（即使显示缓存仍为 busy）→ 拒绝上传，照片留在本机。
    XCTAssertTrue(app.staticTexts["识别服务当前繁忙，请稍后再试。照片仍保存在本机。"].waitForExistence(timeout: 10))
    XCTAssertEqual(server.uploadCount, 0, "busy 状态不得发送任何照片")
    XCTAssertTrue(app.staticTexts["照片 1 · 已保存在本机"].exists)
  }

  @MainActor
  func testCloudPairingSurvivesRelaunchWithPersistedOwnership() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .accepting)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))
    importOnePhoto(app)
    app.terminate()
    app.launch()
    // 重启后：已保存的云配对直接进入待检查 → 检查 → 可以上传（状态机恢复，无需重新扫码）。
    XCTAssertTrue(
      app.staticTexts["connection-state-ready"].waitForExistence(timeout: 15),
      "重启后自动重新检查连接")
    XCTAssertTrue(app.staticTexts["照片 1 · 已保存在本机"].waitForExistence(timeout: 10))
  }

  // MARK: - Helpers

  @MainActor
  private func launchCloudApp(_ server: SyntheticRecognitionServer) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = [
      "-test-session", UUID().uuidString,
      "-cloud-loopback", "http://127.0.0.1:\(server.port)",
    ]
    app.launch()
    return app
  }

  @MainActor
  private func importOnePhoto(_ app: XCUIApplication) {
    app.buttons["add-photos"].tap()
    let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10))
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let add = app.buttons["Done"].firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5))
    add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(app.staticTexts["照片 1 · 已保存在本机"].waitForExistence(timeout: 10))
  }

  @MainActor
  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    for _ in 0..<8 {
      if element.exists && element.isHittable && element.frame.maxY < 780 { break }
      app.swipeUp()
    }
  }
}
