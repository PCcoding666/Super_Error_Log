import XCTest

/// 云端连接状态 UI 旅程。合成服务器（回环传输 + 云端语义）驱动
/// 状态机各分支：服务繁忙（acceptingJobs=false）、授权失效（401）、限流（429）、可以上传。
/// 通过 DEBUG 专用 `-cloud-loopback` 启动参数 + 首次启动自动兑换，注入云模式配对；
/// 绝不连接真实云域名或模型。状态行直接显示在「本周」主页（无需先打开设置页）。
/// T6f：适配 v2 主页——首次上传由进门策略自动弹出一次同意说明，不再有「识别所选照片」按钮；
/// 照片行改用 `photo-progress-` 前缀。
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
    XCTAssertEqual(app.buttons["rescan-connection"].exists, false, "busy 只重试，不提供重新扫码")
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
    XCTAssertEqual(app.buttons["rescan-connection"].exists, false, "授权失效已有「重新扫码」主按钮（repair-connection），不重复")
    // 重新配对先清凭据回到未配对，未配对态必须提供真实的扫码入口（不得是死按钮）。
    repair.tap()
    XCTAssertTrue(app.staticTexts["connection-state-unpaired"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["scan-to-pair"].waitForExistence(timeout: 5),
                  "未配对状态必须提供「扫码配对」入口")
  }

  @MainActor
  func testNextStepRescanFromExpiredConnectionClearsPairingAndOpensScanner() throws {
    // 主页底部「下一步」的「重新扫码」（NextStepAction.rescan）与连接行走同一条清配对路径：
    // 授权失效时点它，要回到未配对并打开扫码页。
    let server = try SyntheticRecognitionServer(cloudHealth: .unauthorized)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-unauthorized"].waitForExistence(timeout: 10))
    let primary = app.buttons["next-step-primary"]
    XCTAssertTrue(primary.waitForExistence(timeout: 5))
    XCTAssertEqual(primary.label, "重新扫码")
    primary.tap()
    XCTAssertTrue(app.otherElements["pairing-scanner"].waitForExistence(timeout: 10), "下一步的重新扫码必须打开扫码页")
    XCTAssertTrue(app.staticTexts["connection-state-unpaired"].waitForExistence(timeout: 5))
    XCTAssertEqual(server.redeemCount, 1)
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
  func testUnreachableOffersRetryAndRescanAndRescanOpensScannerAfterClearingPairing() throws {
    // 换了网络、旧入口连不上（传输错误，不是 401）：重试永远不会好，所以除了「重试连接」还要有「重新扫码」。
    let server = try SyntheticRecognitionServer(cloudHealth: .unreachable)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-failed"].waitForExistence(timeout: 10))
    // 本周数据（合成服务器的 /v2 正常）到了之后「今天」卡才长成 5 步清单，页面高度才定型；
    // 之前去量按钮位置、去点，页面还会再变高。
    XCTAssertTrue(app.staticTexts["today-header"].waitForExistence(timeout: 10), "本周数据加载完，页面高度定型")
    let retry = app.buttons["retry-connection"]
    let rescan = app.buttons["rescan-connection"]
    XCTAssertTrue(retry.waitForExistence(timeout: 5), "连接失败仍保留重试入口")
    XCTAssertTrue(rescan.waitForExistence(timeout: 5), "连接失败必须另给「重新扫码」")
    XCTAssertTrue(retry.isEnabled)
    XCTAssertTrue(rescan.isEnabled)
    XCTAssertEqual(rescan.label, "重新扫码")
    XCTAssertTrue(app.staticTexts["换了网络连不上？让大人再给一个二维码，重新扫一下。"].exists,
                  "次要按钮下面有一行说明")
    XCTAssertEqual(app.buttons["repair-connection"].exists, false, "连不上不是授权失效")
    XCTAssertEqual(server.redeemCount, 1)

    // 「重试连接」还是重试：再发一次检查，仍是连接失败，配对和按钮都在，不弹扫码页。
    let requestsBeforeRetry = server.requestCount
    scrollToSettledHittable(retry, in: app)
    retry.tap()
    waitUntil("重试会再发一次健康检查") { server.requestCount > requestsBeforeRetry }
    XCTAssertTrue(app.staticTexts["connection-state-failed"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["rescan-connection"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["connection-state-unpaired"].exists, "重试不得清掉配对")
    XCTAssertFalse(app.otherElements["pairing-scanner"].exists, "重试不得打开扫码页")

    // 「重新扫码」：清掉配对回到未配对，并打开扫码页。
    // 重试期间（.checking）行里只剩重试按钮，页面会变矮；恢复 .failed 后按钮位置可能已经变了，
    // 所以每次点之前都重新滚到可点并等停稳，不靠 XCUITest 点击时的临时滚动。
    scrollToSettledHittable(app.buttons["rescan-connection"], in: app)
    app.buttons["rescan-connection"].tap()
    // 模拟器没有相机，扫码页是一块黑屏（带稳定标识 pairing-scanner）。
    let scanner = app.otherElements["pairing-scanner"]
    XCTAssertTrue(scanner.waitForExistence(timeout: 10), "重新扫码必须打开扫码页")
    XCTAssertTrue(app.staticTexts["connection-state-unpaired"].waitForExistence(timeout: 5),
                  "重新扫码先清掉旧配对")
    XCTAssertEqual(app.buttons["rescan-connection"].exists, false)
    XCTAssertEqual(app.buttons["retry-connection"].exists, false)
    XCTAssertEqual(server.redeemCount, 1, "扫码页没有给出新二维码前不会重新兑换")
    // 未配对态必须有真实的扫码入口（与授权失效用例相同的断言），而不是死胡同。
    XCTAssertTrue(app.buttons["scan-to-pair"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testReadyStateEnablesUploadAndCopyNamesTheGuangzhouCloud() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .accepting)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))
    importOnePhoto(app)
    // v2：首次上传由进门策略自动弹出一次同意说明。
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
    waitUntil("同意后恰好一次上传") { server.uploadCount == 1 }
    XCTAssertEqual(server.uploadCount, 1)
  }

  @MainActor
  func testBusyHealthCheckBlocksUploadButPhotosStayLocal() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .busy)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-busy"].waitForExistence(timeout: 10))
    importOnePhoto(app)
    // 同意说明照弹（同意与连接状态无关）；点同意时强制重查 health（busy）→ 拒绝上传。
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 5))
    reveal(app.buttons["consent-upload"], in: app)
    app.buttons["consent-upload"].tap()
    XCTAssertTrue(app.staticTexts["识别服务当前繁忙，请稍后再试。照片仍保存在本机。"].waitForExistence(timeout: 10))
    XCTAssertEqual(server.uploadCount, 0, "busy 状态不得发送任何照片")
    app.buttons["知道了"].tap()
    XCTAssertTrue(progressRow(app).waitForExistence(timeout: 5), "照片仍保存在本机")
  }

  @MainActor
  func testCloudPairingSurvivesRelaunchWithPersistedOwnership() throws {
    let server = try SyntheticRecognitionServer(cloudHealth: .accepting)
    defer { server.stop() }
    let app = launchCloudApp(server)
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))
    importOnePhoto(app)
    // 这次不上传：关掉同意说明（同意只记「同意」，不记「暂不上传」）。
    let later = app.buttons["暂不上传"]
    XCTAssertTrue(later.waitForExistence(timeout: 5))
    later.tap()
    app.terminate()
    app.launch()
    // 重启后：已保存的云配对直接进入待检查 → 检查 → 可以上传（状态机恢复，无需重新扫码）。
    XCTAssertTrue(
      app.staticTexts["connection-state-ready"].waitForExistence(timeout: 15),
      "重启后自动重新检查连接")
    // 未同意的照片重启后会再次询问；关掉后核对照片仍在本机。
    if app.buttons["暂不上传"].waitForExistence(timeout: 5) { app.buttons["暂不上传"].tap() }
    XCTAssertTrue(progressRow(app).waitForExistence(timeout: 10), "重启后本机照片仍在")
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
    XCTAssertTrue(progressRow(app).waitForExistence(timeout: 10), "导入后本机照片行出现")
  }

  /// 照片进度行（正在上传/正在识别/还没上传/失败重试）。
  @MainActor
  private func progressRow(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", "photo-progress-")).firstMatch
  }

  @MainActor
  private func waitUntil(_ description: String, timeout: TimeInterval = 20, _ predicate: () -> Bool) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if predicate() { return }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    XCTFail(description)
  }

  /// 把元素滚到可点的位置，并等它停下来（可点且 frame 连续 3 次采样不变，每次间隔 0.1 秒）才返回。
  /// iPhone 13 上连接行默认落在底部「下一步」条的下面（不可点）：交给 XCUITest 在点击时临时滚动再点，
  /// 在整类顺序跑时出现过一次点击没触发按钮（行仍是连接失败）。这里改成先自己滚、等位置停稳再点；
  /// 是按条件等待，不是固定睡眠，停不稳就让用例失败。
  @MainActor
  private func scrollToSettledHittable(_ element: XCUIElement, in app: XCUIApplication,
                                       file: StaticString = #filePath, line: UInt = #line) {
    var swipes = 0
    while !element.isHittable && swipes < 4 {
      app.swipeUp()
      swipes += 1
    }
    var last = CGRect.null
    var stable = 0
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
      let frame = element.frame
      stable = (element.isHittable && frame == last) ? stable + 1 : 0
      if stable >= 3 { return }
      last = frame
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    XCTFail("\(element.identifier) 没有停稳在可点的位置", file: file, line: line)
  }

  @MainActor
  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    for _ in 0..<8 {
      if element.exists && element.isHittable && element.frame.maxY < 780 { break }
      app.swipeUp()
    }
  }
}
