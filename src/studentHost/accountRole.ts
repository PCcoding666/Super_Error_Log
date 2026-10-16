/**
 * 账号身份标签（2026-10-15）：student/parent/teacher/admin。
 * 只是元数据：用来在设置页告诉学生/管理员这个账号登记的身份，绝不参与任何鉴权或功能开关。
 * 家长/老师/管理员的专属权限与账号关系尚未实现，不要用这个字段做访问控制。
 */
export const ACCOUNT_ROLES = ['student', 'parent', 'teacher', 'admin'] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  student: '学生',
  parent: '家长',
  teacher: '老师',
  admin: '管理员',
};

/** 运行时任一输入 → 是否合法身份。所有外部输入（CLI 参数、内部头）都必须先过这一关。 */
export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(value);
}

export function accountRoleLabel(role: AccountRole): string {
  return ACCOUNT_ROLE_LABELS[role];
}
