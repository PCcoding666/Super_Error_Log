import XCTest

/// T6f：v2 学生闭环的界面回归（合成服务器，不连真实服务、不调用 AI）。
/// 每条用例独立的 `-test-session`，用 `-cloud-loopback` 把云模式指向进程内合成服务器。
/// 服务器的合成内容（题号、文案、状态流转）见 SyntheticRecognitionServer。
@MainActor
final class LoopJourneyTests: XCTestCase {

  /// 第 1 张照片登记后桥接出的 3 道题（与服务器合成内容一致）。
  static let item1 = "itm_0000000000010000"
  static let item2 = "itm_0000000000010001"
  static let item3 = "itm_0000000000010002"

  // MARK: - J1 拍照进错题本

  func testJ1PhotoIntoWeeklyItems() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = launch(server)
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))

    importPhoto(app)
    // 首次上传出现一次同意说明。
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 5))
    let consent = app.buttons["consent-upload"]
    reveal(consent, in: app)
    XCTAssertTrue(consent.isEnabled)
    consent.tap()

    // 照片进度出现（正在上传/正在识别），随后消失（识别完成）。
    XCTAssertTrue(progressRow(app).waitForExistence(timeout: 10), "上传后照片进度应出现")
    let firstCard = app.buttons["item-card-\(Self.item1)"]
    XCTAssertTrue(firstCard.waitForExistence(timeout: 40), "本周错题应出现题目卡片")
    waitUntil("识别完成后照片进度行消失") { !progressRow(app).exists }

    // 再加一张：同意已记住，不再弹确认、自动上传。
    importPhoto(app)
    waitUntil("第二张照片自动上传（若再次询问同意则不会发出）") { server.uploadCount == 2 }
    XCTAssertFalse(app.buttons["consent-upload"].exists, "第二次加照片不再出现上传确认")

    // S2-R1：主页向上滚动后截图（XCTAttachment），人工核对状态栏区域是纯底色、没有内容叠上去。
    app.swipeUp()
    app.swipeUp()
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "home-scrolled-statusbar"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  // MARK: - J2 改与移出

  func testJ2DiscardUndoAndCorrection() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = launch(server)
    try importAndConsent(app)

    // 不是错题 → 卡片消失、撤销条出现 → 撤销后卡片回来。
    let card = app.buttons["item-card-\(Self.item1)"]
    reveal(app.buttons["item-discard-\(Self.item1)"], in: app)
    app.buttons["item-discard-\(Self.item1)"].tap()
    waitUntil("移出后卡片消失") { !card.exists }
    let undoBar = app.descendants(matching: .any)["undo-bar"]
    XCTAssertTrue(undoBar.waitForExistence(timeout: 5), "移出后出现撤销条")
    app.buttons["undo-discard"].tap()
    XCTAssertTrue(card.waitForExistence(timeout: 10), "撤销后卡片回来")

    // 不对，改一下 → 写一句 → 生成修改 → 看到改前改后 → 接受 → 面板自动关闭、卡片文字更新。
    app.buttons["item-correct-\(Self.item1)"].tap()
    let instruction = app.textFields["correction-instruction"]
    XCTAssertTrue(instruction.waitForExistence(timeout: 10))
    instruction.tap()
    instruction.typeText("题目求的是 y 不是 x")
    let generate = app.buttons["correction-generate"]
    XCTAssertTrue(generate.waitForExistence(timeout: 5))
    generate.tap()
    let accept = app.buttons["correction-accept"]
    XCTAssertTrue(accept.waitForExistence(timeout: 10), "生成修改后应出现改前改后与「接受修改」")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "求 y 的值")).firstMatch.exists,
      "建议里应看到改后的文字")
    accept.tap()
    waitUntil("接受后修改面板自动关闭") { !accept.exists }
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "已知 x+y=1，求 y 的值。")).firstMatch.waitForExistence(timeout: 10),
      "主页卡片文字应更新为改后内容")

    // 自己动手改 → 改学科 → 保存 → 卡片更新。
    app.buttons["item-correct-\(Self.item1)"].tap()
    let direct = app.buttons["correction-direct"]
    XCTAssertTrue(direct.waitForExistence(timeout: 10))
    reveal(direct, in: app)
    direct.tap()
    let physics = app.buttons["物理"]
    XCTAssertTrue(physics.waitForExistence(timeout: 5))
    physics.tap()
    let save = app.buttons["correction-save-direct"]
    reveal(save, in: app)
    XCTAssertTrue(save.isEnabled, "改了学科后应可保存")
    save.tap()
    waitUntil("保存后修改面板自动关闭") { !save.exists }
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "物理")).firstMatch.waitForExistence(timeout: 10),
      "主页卡片应显示改后的学科")
  }

  // MARK: - J3 选题与复盘

  func testJ3PickPracticeAndReflect() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = launch(server)
    try importAndConsent(app)
    try createPracticeFromHome(app)

    // 主页出现练习卡：3 道题、还没打印、可以说说为什么错。
    let practiceCard = app.descendants(matching: .any)["practice-card"]
    XCTAssertTrue(practiceCard.waitForExistence(timeout: 10), "建练习后主页出现练习卡")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "还有 3 道没说为什么错")).firstMatch.exists)
    let reflect = app.buttons["practice-reflect"]
    reveal(reflect, in: app)
    reflect.tap()

    // 练习详情 → 说说这道为什么错 → AI 问你一句。
    let reflectItem = app.buttons["reflect-\(Self.item1)"]
    XCTAssertTrue(reflectItem.waitForExistence(timeout: 10))
    reflectItem.tap()
    let question = app.staticTexts["followup-question"]
    XCTAssertTrue(question.waitForExistence(timeout: 10), "追问问题应出现")

    // 回答 → 确认页。
    let answer = app.textViews["followup-answer"]
    answer.tap()
    answer.typeText("我当时直接把数搬过去了，没想到要变号")
    dismissKeyboard(app)
    let send = app.buttons["followup-send"]
    reveal(send, in: app)
    send.tap()

    // 确认页：AI 建议已预选（标「AI 猜的」）、把握没有预选、没选把握时提交不可用。
    let submit = app.buttons["reflection-submit"]
    XCTAssertTrue(submit.waitForExistence(timeout: 10), "回答后进入确认页")
    XCTAssertTrue(app.staticTexts["AI 猜的"].waitForExistence(timeout: 5), "AI 建议预选并标注")
    XCTAssertTrue(app.staticTexts["还差：有没有把握"].exists, "把握不预选，如实提示")
    XCTAssertFalse(submit.isEnabled, "没选把握时提交按钮不可用")
    let mastery = app.descendants(matching: .any)["reflect-mastery-2"]
    reveal(mastery, in: app)
    // 选择是幂等的（selectMasteryFeeling 直接赋值）；偶发点击落在布局过渡中未生效时重点。
    for _ in 0..<3 {
      mastery.tap()
      if submit.isEnabled { break }
      RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }
    XCTAssertTrue(submit.isEnabled, "选了把握后可以提交")
    reveal(submit, in: app)
    submit.tap()
    // 「记下了」只显示约 1 秒即自动关闭；以回到练习详情且该题变为「再看一下」作为提交成功判据。
    let reflectAgain = app.buttons["reflect-\(Self.item1)"]
    XCTAssertTrue(reflectAgain.waitForExistence(timeout: 15), "提交后自动回到练习详情")
    XCTAssertTrue(app.buttons["再看一下"].waitForExistence(timeout: 5), "说完后该题显示「再看一下」")
    back(app)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "还有 2 道没说为什么错")).firstMatch.waitForExistence(timeout: 10),
      "说完一道后练习卡未说数减少")
  }

  // MARK: - J4 打印、录结果、看结果、下一份

  func testJ4PrintReturnSummaryAndNext() throws {
    let server = try SyntheticRecognitionServer()
    defer { server.stop() }
    let app = launch(server)
    try importAndConsent(app)
    try createPracticeFromHome(app)

    // 打印练习纸 → 准备中 → PDF 预览与「打印 / 分享」。
    let printButton = app.buttons["practice-print"]
    reveal(printButton, in: app)
    printButton.tap()
    XCTAssertTrue(app.descendants(matching: .any)["print-preparing"].waitForExistence(timeout: 10),
      "进入打印页先显示准备中")
    XCTAssertTrue(app.descendants(matching: .any)["print-preview"].waitForExistence(timeout: 60),
      "轮询就绪后出现 PDF 预览")
    XCTAssertTrue(app.buttons["print-share"].exists, "就绪后出现「打印 / 分享」")
    back(app)

    // 返回后练习卡变为已打印并出现「录结果」。
    let record = app.buttons["practice-record"]
    XCTAssertTrue(record.waitForExistence(timeout: 10), "打印后练习卡出现「录结果」")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "练习纸已生成 · 做完回来录结果")).firstMatch.exists)
    record.tap()

    // 录结果：一道「独立做出 + 对了」、一道「没做出来」→ 提交。
    let firstCompletion = app.descendants(matching: .any)["return-completion-\(Self.item1)-independent"]
    XCTAssertTrue(firstCompletion.waitForExistence(timeout: 10))
    firstCompletion.tap()
    let correctYes = app.descendants(matching: .any)["return-correct-\(Self.item1)-yes"]
    XCTAssertTrue(correctYes.waitForExistence(timeout: 5))
    correctYes.tap()
    let secondCompletion = app.descendants(matching: .any)["return-completion-\(Self.item2)-not_solved"]
    reveal(secondCompletion, in: app)
    secondCompletion.tap()
    let submit = app.buttons["return-submit"]
    reveal(submit, in: app)
    XCTAssertTrue(submit.isEnabled)
    submit.tap()

    // 已记录区显示服务器给的那句话。
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "记下：当天独立做对")).firstMatch.waitForExistence(timeout: 10),
      "已记录区显示服务器给的那句话")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "记下：没做出来")).firstMatch.exists)
    let viewSummary = app.buttons["return-view-summary"]
    reveal(viewSummary, in: app)
    viewSummary.tap()

    // 看结果：有「做对了，过几天再验证」与「还要再练的」两组；页面上不出现「掌握了」的说法。
    XCTAssertTrue(app.staticTexts["做对了，过几天再验证"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["还要再练的"].exists)
    XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "掌握了")).count, 0,
      "回报页不出现「掌握了」的说法")
    back(app)
    back(app)

    // 回主页出现「选下一份要练的题」。
    let pickNext = app.buttons["pick-next-practice"]
    reveal(pickNext, in: app)
    XCTAssertTrue(pickNext.waitForExistence(timeout: 10), "录完后主页出现「选下一份要练的题」")
  }

  // MARK: - J5 离线与重启

  func testJ5OfflineRestartShowsCacheAndDiscardFailsGracefully() throws {
    let server = try SyntheticRecognitionServer()
    let session = UUID().uuidString
    let app = launch(server, session: session)
    try importAndConsent(app)
    XCTAssertTrue(app.buttons["item-card-\(Self.item1)"].waitForExistence(timeout: 10))

    // 有数据后停掉合成服务器并重启 App。
    server.stop()
    app.terminate()
    app.launchArguments = ["-test-session", session, "-cloud-loopback", "http://127.0.0.1:\(server.port)"]
    app.launch()

    // 主页显示上次保存的内容并标注是缓存。
    XCTAssertTrue(app.staticTexts["cache-note"].waitForExistence(timeout: 15), "离线重启后标注是缓存")
    XCTAssertTrue(app.buttons["item-card-\(Self.item1)"].waitForExistence(timeout: 10),
      "离线重启后仍显示上次保存的题目卡片")

    // 此时点「不是错题」给出连接提示而不是崩溃。
    reveal(app.buttons["item-discard-\(Self.item1)"], in: app)
    app.buttons["item-discard-\(Self.item1)"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "暂时连不上")).firstMatch.waitForExistence(timeout: 10),
      "离线操作给出连接提示")
    XCTAssertEqual(app.state, .runningForeground, "离线操作不得崩溃")
    XCTAssertTrue(app.buttons["item-card-\(Self.item1)"].exists, "操作失败后卡片仍在")
  }

  // MARK: - J6 自己勾错题（无批改痕迹的页）

  /// S2：无痕迹情形由服务器开关控制（unmarkedPages），不影响 J1–J5 的默认情形。
  /// 无痕迹页的 3 道候选题（与服务器合成内容一致）。
  static let pickItem2 = "itm_0000000000010001"  // 第 2 题勾入后桥接出的错题
  static let pickItem3 = "itm_0000000000010002"  // 第 3 题
  /// 无痕迹页的照片行标题（设计稿 §5：只留这一行，主页错题区不再同时说「正在识别」）。
  static let noMarksRow = "这页没有批改痕迹，点「勾出错题」自己勾"

  func testJ6PickWrongQuestionsFromUnmarkedPage() throws {
    let server = try SyntheticRecognitionServer(unmarkedPages: true)
    defer { server.stop() }
    let app = launch(server)
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))

    importPhoto(app)
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 5))
    let consent = app.buttons["consent-upload"]
    reveal(consent, in: app)
    consent.tap()

    // 找题完成：这页一道自动题都没有 → 照片进度出现「这页没有批改痕迹…」。
    XCTAssertTrue(app.staticTexts[Self.noMarksRow].waitForExistence(timeout: 30),
      "无痕迹页到终态后应提示勾出错题")

    // 勾出错题 → 输入「1」再续输入「5」：第 1 题先勾上、合成「15」后自动取消，
    // 并提示「这页没找到第 15 题」（合成页只有 3 道题）。清空后输入「2」勾上第 2 题；再手点第 3 题。
    let pick = app.buttons.matching(NSPredicate(
      format: "identifier BEGINSWITH %@ AND label == %@", "photo-pick-", "勾出错题")).firstMatch
    XCTAssertTrue(pick.waitForExistence(timeout: 5))
    pick.tap()
    let input = app.textFields["pick-input"]
    XCTAssertTrue(input.waitForExistence(timeout: 5), "勾选面板应出现")
    input.tap()
    input.typeText("1")
    XCTAssertTrue(app.buttons.matching(NSPredicate(
      format: "identifier BEGINSWITH %@ AND label == %@", "pick-row-", "第 1 题，已选")).firstMatch
        .waitForExistence(timeout: 5), "输入 1 后第 1 题被勾上")
    input.typeText("5")
    XCTAssertTrue(app.buttons.matching(NSPredicate(
      format: "identifier BEGINSWITH %@ AND label == %@", "pick-row-", "第 1 题，未选")).firstMatch
        .waitForExistence(timeout: 5), "「1」变成「15」后第 1 题自动取消")
    XCTAssertTrue(app.staticTexts["这页没找到第 15 题"].waitForExistence(timeout: 5),
      "第 15 题不在这页，应提示没找到")
    // 清空输入框（退格删掉已输入的字符）。
    let typed = input.value as? String ?? ""
    if !typed.isEmpty {
      input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count))
    }
    input.typeText("2")
    XCTAssertTrue(app.buttons.matching(NSPredicate(
      format: "identifier BEGINSWITH %@ AND label == %@", "pick-row-", "第 2 题，已选")).firstMatch
        .waitForExistence(timeout: 5), "输入 2 后第 2 题被勾上")
    let row3 = app.buttons.matching(NSPredicate(
      format: "identifier BEGINSWITH %@ AND label == %@", "pick-row-", "第 3 题，未选")).firstMatch
    reveal(row3, in: app)
    row3.tap()

    // 按钮显示「把这 2 道加入错题本」→ 提交 → 面板关闭。
    let confirm = app.buttons["pick-confirm"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    XCTAssertEqual(confirm.label, "把这 2 道加入错题本")
    confirm.tap()
    waitUntil("提交成功后面板关闭") { !confirm.exists }

    // 勾入的 2 道读完后进本周错题；照片进度里这张消失；还剩 1 道 → 出现补选入口。
    XCTAssertTrue(app.buttons["item-card-\(Self.pickItem2)"].waitForExistence(timeout: 40),
      "勾入的第 2 题应出现在本周错题")
    XCTAssertTrue(app.buttons["item-card-\(Self.pickItem3)"].waitForExistence(timeout: 10),
      "勾入的第 3 题应出现在本周错题")
    XCTAssertFalse(app.staticTexts[Self.noMarksRow].exists, "勾过后提示行消失")
    XCTAssertTrue(app.buttons["pick-missed"].waitForExistence(timeout: 10),
      "还剩 1 道没选，应出现「漏了题？从照片里补选」")

    // 另一张无痕迹照片：点「这页没有错题」→ 该行消失，错题数不变。
    importPhoto(app)
    waitUntil("第二张照片自动上传（同意已记住）") { server.uploadCount == 2 }
    XCTAssertTrue(app.staticTexts[Self.noMarksRow].waitForExistence(timeout: 30),
      "第二张无痕迹页同样提示勾出错题")
    let pickDone = app.buttons.matching(NSPredicate(
      format: "identifier BEGINSWITH %@", "photo-pickdone-")).firstMatch
    reveal(pickDone, in: app)
    pickDone.tap()
    waitUntil("「这页没有错题」后该行消失") { !app.staticTexts[Self.noMarksRow].exists }
    XCTAssertEqual(app.buttons.matching(NSPredicate(
      format: "identifier BEGINSWITH %@", "item-card-")).count, 2, "错题数不变")
  }

  // MARK: - 公共步骤

  private func launch(_ server: SyntheticRecognitionServer, session: String = UUID().uuidString) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-test-session", session, "-cloud-loopback", "http://127.0.0.1:\(server.port)"]
    app.launch()
    return app
  }

  /// 从相册加一张照片，并在首次上传确认上点「同意上传并识别」，等到本周错题出现卡片。
  private func importAndConsent(_ app: XCUIApplication) throws {
    XCTAssertTrue(app.staticTexts["connection-state-ready"].waitForExistence(timeout: 10))
    importPhoto(app)
    XCTAssertTrue(app.staticTexts["这次将发送 1 张照片。"].waitForExistence(timeout: 5))
    let consent = app.buttons["consent-upload"]
    reveal(consent, in: app)
    consent.tap()
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "item-card-")).firstMatch.waitForExistence(timeout: 40),
      "识别完成后本周错题应出现题目卡片")
  }

  /// 主页 → 选题页：推荐默认全选、显示推荐理由 → 就练这些 → 回主页。
  private func createPracticeFromHome(_ app: XCUIApplication) throws {
    let pick = app.buttons["pick-practice"]
    reveal(pick, in: app)
    pick.tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "为什么选它：本周新错题")).firstMatch.waitForExistence(timeout: 10),
      "推荐页显示为什么选它")
    XCTAssertTrue(app.staticTexts["已选 3 道"].exists, "推荐默认全选")
    let create = app.buttons["create-practice"]
    XCTAssertTrue(create.isEnabled)
    create.tap()
    XCTAssertTrue(app.descendants(matching: .any)["practice-card"].waitForExistence(timeout: 10),
      "就练这些后回主页出现练习卡")
  }

  private func importPhoto(_ app: XCUIApplication) {
    app.buttons["add-photos"].tap()
    let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10))
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let add = app.buttons["Done"].firstMatch
    XCTAssertTrue(add.waitForExistence(timeout: 5))
    add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
  }

  private func progressRow(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", "photo-progress-")).firstMatch
  }

  private func dismissKeyboard(_ app: XCUIApplication) {
    if app.keyboards.count > 0 { app.swipeDown() }
  }

  private func back(_ app: XCUIApplication) {
    let button = app.navigationBars.buttons.firstMatch
    XCTAssertTrue(button.waitForExistence(timeout: 5), "应能返回上一页")
    button.tap()
  }

  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    for _ in 0..<8 {
      if element.exists && element.isHittable { break }
      app.swipeUp()
    }
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
