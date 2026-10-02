import Foundation

// S2：主页「勾出错题」入口的纯逻辑。
// 无批改痕迹的页（答题卡 + 网上阅卷）找题后所有题都是 unselected，等学生勾；
// 这里的规则决定主页什么时候催、什么时候只留一个安静入口。
enum PhotoPickReminder {
  /// 找题后仍等学生勾的题。
  static func unselectedQuestions(of task: LocalRecognitionTask) -> [RecognitionQuestion] {
    task.job?.questions.filter { $0.status == "unselected" } ?? []
  }

  /// 「这页没看到批改痕迹」行：任务已过找题（终态）、一道自动题都没有、
  /// 学生还没处理过（未 pickDone）、没有失败方案（失败方案优先）。
  static func showsNoMarksRow(_ task: LocalRecognitionTask) -> Bool {
    guard let job = task.job, ["completed", "partial"].contains(job.status),
      task.pickDone != true, !job.questions.isEmpty,
      job.questions.allSatisfy({ $0.status == "unselected" }),
      PhotoFailurePlan.plan(for: task) == nil
    else { return false }
    return true
  }

  /// 识别中、有自动题、且还有未选题：行内次要按钮「还有 N 道没批改痕迹 · 补选」的 N；
  /// nil 不显示（一道自动题都没有时不单独催，识别完成后行照常消失）。
  static func pickMoreCount(_ task: LocalRecognitionTask) -> Int? {
    guard let job = task.job, job.active else { return nil }
    let unselected = unselectedQuestions(of: task).count
    let automatic = job.questions.count - unselected
    guard automatic > 0, unselected > 0 else { return nil }
    return unselected
  }

  /// 「漏了题？从照片里补选」列出的任务：还有未选题、且行内没有别的勾选入口
  /// （整页无痕迹行或识别中的补选按钮已经在催的不重复列）。
  static func missedTasks(_ tasks: [LocalRecognitionTask]) -> [LocalRecognitionTask] {
    tasks.filter { task in
      guard !unselectedQuestions(of: task).isEmpty else { return false }
      if showsNoMarksRow(task) { return false }
      if pickMoreCount(task) != nil { return false }
      return true
    }
  }
}
