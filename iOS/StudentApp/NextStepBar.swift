import SwiftUI

// 学生端重做第 1 期（设计稿 §3.1、§4.0、§7.3）：每屏底部固定的「下一步」按钮，以及练习流程的路由。
// 第 1 期只做实色版；iOS 26 的 Liquid Glass 分支留到第 4 期（下面 #available 里两边现在是同一套实色）。

/// 从主页推入的练习流程页（第 1 期从 LoopPracticeSection 提到主页：下一步按钮、清单行、练习卡都推同一套页面）。
enum PracticeRoute: Hashable {
  case pick
  /// 说说为什么错（练习详情）。
  case detail(String)
  /// 说说这道为什么错。
  case followup(practiceID: String, itemID: String)
  case print(String)
  case record(String)
  case summary(String)
}

/// 主页导航与「本次打开」的内存状态：路由栈、两处「跳过」、要主页自己做的动作（拍照、勾选面板、上传、扫码）。
/// 什么都不落盘；关掉 App 再开就全回到初始状态（设计稿 §11.2）。
@MainActor @Observable
final class HomeFlow {
  var path: [PracticeRoute] = []
  private(set) var skipped: Set<WeekPlan.StepKind> = []
  /// 子页面要主页做的事：先回到今天，主页看到后执行一次。
  private(set) var homeRequest: HomeRequest?

  struct HomeRequest: Equatable {
    let id = UUID()
    let action: NextStepAction
  }

  func push(_ route: PracticeRoute) { path.append(route) }

  /// 流程页做完后直接换成下一步：返回键始终回到今天，不层层回退（§3.1）。
  func replace(with route: PracticeRoute) { path = [route] }

  func goHome() { path = [] }

  func skip(_ kind: WeekPlan.StepKind) { skipped.insert(kind) }

  func consumeHomeRequest() -> NextStepAction? {
    defer { homeRequest = nil }
    return homeRequest?.action
  }

  /// 下一步按钮 / 清单行的统一出口。导航类动作在这里完成；拍照、勾选、上传、扫码交给主页。
  func perform(_ action: NextStepAction) {
    switch action {
    case .choose: replace(with: .pick)
    case .why(let id): replace(with: .detail(id))
    case .skipWhy(let id):
      skip(.why)
      replace(with: .print(id))
    case .print(let id): replace(with: .print(id))
    case .record(let id): replace(with: .record(id))
    case .summary(let id): replace(with: .summary(id))
    case .skipShoot: skip(.shoot)
    case .skipRecord: skip(.record)
    case .goHome: goHome()
    case .scan, .rescan, .capture, .uploadPending, .openPick:
      goHome()
      homeRequest = HomeRequest(action: action)
    }
  }
}

/// 底部下一步按钮：上面一行小字（第几步、大约几分钟 / 为什么不能点），下面一个主按钮，需要时下面有次要按钮。
struct NextStepBar: View {
  let model: NextStepModel
  let perform: (NextStepAction) -> Void

  var body: some View {
    NextStepBarContainer(caption: model.caption, secondary: model.secondary, perform: perform) {
      if let primary = model.primary {
        Button { perform(primary.action) } label: {
          HStack(spacing: 8) {
            if model.isWaiting {
              ProgressView().tint(Palette.onTeal)
            } else if let image = primary.systemImage {
              Image(systemName: image)
            }
            Text(primary.title)
          }
        }
        .buttonStyle(PrimaryButton())
        .disabled(!model.isEnabled)
        .accessibilityHint(model.caption)
        .accessibilityIdentifier("next-step-primary")
      }
    }
  }
}

/// 下一步按钮的外框：主按钮由调用方给（打印页的主按钮是系统分享）。
struct NextStepBarContainer<Primary: View>: View {
  let caption: String
  let secondary: [NextStepModel.Choice]
  let perform: (NextStepAction) -> Void
  @ViewBuilder let primary: Primary

  var body: some View {
    VStack(spacing: 6) {
      if !caption.isEmpty {
        Text(caption).font(.footnote).foregroundStyle(Palette.muted)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("next-step-caption")
      }
      buttons
    }
    .padding(.horizontal, 24).padding(.vertical, 10)
    .frame(maxWidth: .infinity)
    .background(Palette.card)
    .overlay(Rectangle().fill(Palette.line.opacity(0.5)).frame(height: 1), alignment: .top)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("next-step-bar")
  }

  @ViewBuilder private var buttons: some View {
    if #available(iOS 26.0, *) {
      // 第 4 期：Liquid Glass（GlassEffectContainer + .glassProminent，「降低透明度」时退实色）放这里。
      // 第 1 期 iOS 26 与 iOS 18 用同一套实色按钮。
      solidButtons
    } else {
      solidButtons
    }
  }

  private var solidButtons: some View {
    VStack(spacing: 2) {
      primary
      ForEach(secondary, id: \.action) { choice in
        Button { perform(choice.action) } label: {
          Text(choice.title).frame(maxWidth: .infinity, minHeight: 44)
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Palette.teal)
        .accessibilityIdentifier("next-step-secondary-\(choice.action.key)")
      }
    }
  }
}
