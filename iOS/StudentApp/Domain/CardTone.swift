import Foundation

/// 状态语义色（Theme.swift 里给出对应的 Color）：灰 = 次要信息，蓝 = 系统在工作，橙 = 待你留意，绿 = 已完成 / 正常，红 = 失败。
enum CardTone: String, Equatable, Sendable { case gray, blue, orange, green, red }
