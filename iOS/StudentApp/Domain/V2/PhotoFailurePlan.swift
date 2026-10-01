import Foundation

// T6k：照片没识别成功时学生看到什么、能点什么（纯逻辑）。
// 网络/超时这类临时问题服务器已在后台自动重试，不进这里；这里只处理需要学生决定的失败：
// 找题目失败（整张重试只在此时且可恢复才被服务器接受）、题目全部/部分失败（逐题重试）、
// 识别中断。「可恢复」一律用 RecognitionFailure.canRecover（recoverable ?? retryable）。

struct PhotoFailurePlan: Equatable, Sendable {
  let title: String
  let detail: String
  /// 重试按钮文案；nil = 这张/这些识别不了，不能重试。
  let retryTitle: String?
  /// 收尾按钮文案：「移除这张」/「不管了」/「知道了」，都走 dismissPhoto（仅不再显示）。
  let dismissTitle: String
  /// 逐题重试的题目 id；nil = 整张重试（仅找题目阶段失败且可恢复时服务器才接受）。
  let retryQuestionIDs: [String]?
  var retryWholePhoto: Bool { retryTitle != nil && retryQuestionIDs == nil }

  static func plan(for task: LocalRecognitionTask) -> PhotoFailurePlan? {
    guard let job = task.job else { return nil }
    let questions = job.questions
    let failed = questions.filter { $0.status == "failed" }
    let recoverableIDs = failed.filter { $0.error?.canRecover == true }.map(\.id)
    let inventoryFailure = job.error.flatMap { $0.stage == "inventory" ? $0 : nil }

    // 识别中断：回前台会自动继续；一直不动可再试一次（找题目阶段中断=整张，否则逐题）。
    if job.status == "interrupted" {
      return PhotoFailurePlan(title: "识别中断了",
        detail: "回到前台会自动继续；一直不动可以再试一次",
        retryTitle: "再试一次", dismissTitle: "移除这张",
        retryQuestionIDs: inventoryFailure?.canRecover == true ? nil : recoverableIDs)
    }

    // 找题目（inventory）那一步就失败：没有题目可逐题重试。
    if job.status == "failed", let inventoryFailure {
      if inventoryFailure.canRecover {
        return PhotoFailurePlan(title: "这张没识别成功",
          detail: "可以再试一次（会重新请求 AI）",
          retryTitle: "再试一次", dismissTitle: "移除这张", retryQuestionIDs: nil)
      }
      return PhotoFailurePlan(title: "这张识别不了",
        detail: unreadableDetail(reason: inventoryFailure.message),
        retryTitle: nil, dismissTitle: "移除这张", retryQuestionIDs: nil)
    }

    guard !failed.isEmpty else { return nil }

    if failed.count == questions.count {
      // 题目全部失败。
      if !recoverableIDs.isEmpty {
        return PhotoFailurePlan(title: "\(failed.count) 道都没认出来",
          detail: "可以再试一次（只重试失败的题）",
          retryTitle: "再试一次", dismissTitle: "移除这张", retryQuestionIDs: recoverableIDs)
      }
      return PhotoFailurePlan(title: "这张识别不了",
        detail: unreadableDetail(reason: failureReason(job: job, failed: failed)),
        retryTitle: nil, dismissTitle: "移除这张", retryQuestionIDs: nil)
    }

    // 部分失败：成功的题已进错题本，失败的这几道不能悄悄没了。
    let succeeded = questions.count - failed.count
    if !recoverableIDs.isEmpty {
      return PhotoFailurePlan(title: "这张有 \(failed.count) 道没认出来",
        detail: "其余 \(succeeded) 道已进错题本",
        retryTitle: "重试这 \(failed.count) 道", dismissTitle: "不管了",
        retryQuestionIDs: recoverableIDs)
    }
    return PhotoFailurePlan(title: "这张有 \(failed.count) 道没认出来",
      detail: "其余 \(succeeded) 道已进错题本；这几道识别不了，需要的话把它们单独重拍",
      retryTitle: nil, dismissTitle: "知道了", retryQuestionIDs: nil)
  }

  /// 服务器原因优先取任务级错误，其次第一道失败题的错误。
  private static func failureReason(job: RecognitionJob, failed: [RecognitionQuestion]) -> String? {
    job.error?.message ?? failed.compactMap(\.error?.message).first
  }

  /// 识别不了的说明：服务器给的原因（为空用通用句）+ 重拍建议。
  private static func unreadableDetail(reason: String?) -> String {
    let trimmed = (reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let base = trimmed.isEmpty ? "AI 没能读出这张照片" : trimmed
    let sentence = base.hasSuffix("。") || base.hasSuffix("！") || base.hasSuffix("？") ? base : base + "。"
    return sentence + "请重拍一张更清楚的"
  }
}
