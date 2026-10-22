/**
 * 学生空间管理 CLI（只能在本机/SSH 里跑；管理网页只能看统计）。必须用服务用户、并显式给出 SEL_STUDENT_HOST_DIR：
 *   sudo -u supererrorlog env SEL_STUDENT_HOST_DIR=/var/lib/super-error-log/student-host node dist/studentHost/admin-cli.js <命令>
 * 没有设置 SEL_STUDENT_HOST_DIR、或者目录不存在时**拒绝运行**（以前会悄悄在当前目录新建一个空库，发出生产里用不了的码）。
 *
 *   create [role]                         新建学生空间（上限见 registry）并生成第一个邀请码；role 缺省 student
 *   invite <studentId>                    给同一学生补一个邀请码（旧码继续有效）
 *   reset-invitation <studentId>          核验后找回：换码并撤销旧码及会话，不删除学习数据；停用的账号也用它恢复
 *   lookup <name> <phone>                 按完整姓名 + 手机号定位账号（不返回码）
 *   lookup <姓名片段 | 手机尾号4位>        模糊查找，列出候选（姓名打码、只显示尾号）
 *   list                                  列出学生（姓名、手机尾号、状态；不含任何码/令牌）
 *   set-role <studentId> <role>           改账号身份标签（student/parent/teacher/admin；只是标签，不是权限）
 *   revoke-sessions <studentId>           撤销该学生的全部登录会话。注意：**不作废邀请码**，持码人可以马上再登录；
 *                                         要封禁用 disable，要换码用 reset-invitation
 *   disable <studentId>                   停用：作废全部邀请码和会话，不能再登录；学习数据保留（reset-invitation 恢复）
 *   delete <studentId> --confirm          删除账号和全部学习数据（不可恢复）；要求先 disable，且该学生没有正在运行的进程
 *   export <studentId> <outDir>           导出该学生的登记资料和学习数据副本到 outDir 下的新目录（0700）
 *   registration-code create [--uses N] [--days D] [备注]   生成注册码（班级码），学生注册时必须填；明文只显示一次
 *   registration-code list                列出注册码（编号、备注、已用/上限、状态；不含码本身）
 *   registration-code revoke <编号>       作废注册码（已注册的账号不受影响）
 *   admin-password                        生成/轮换独立管理后台密码
 * 邀请码、注册码明文只在生成时打印这一次；不写日志、不落盘。
 * 身份标签（role）只能在这里改；浏览器/网页任何入口都不能改身份。
 */
import { ACCOUNT_ROLE_LABELS, ACCOUNT_ROLES, isAccountRole, type AccountRole } from './accountRole.js';
import fs from 'node:fs';
import path from 'node:path';
import { formatInviteCode, normalizeInviteCode, RegistryError, StudentRegistry } from './registry.js';
import { AdminAuth } from '../admin/auth.js';

const USAGE = `用法：admin-cli.ts create [${ACCOUNT_ROLES.join('|')}] | invite <studentId> | reset-invitation <studentId> | list | lookup <name> <phone> | lookup <姓名片段|手机尾号4位> | set-role <studentId> <role> | revoke-sessions <studentId> | disable <studentId> | delete <studentId> --confirm | export <studentId> <outDir> | registration-code create [--uses N] [--days D] [备注] | registration-code list | registration-code revoke <编号> | admin-password
（必须设置 SEL_STUDENT_HOST_DIR，且与运行中的服务相同）`;

/** 姓名打码：只留第一个字（模糊查找时给候选，避免整屏都是全名）。 */
function maskName(name: string): string {
  const chars = [...name];
  return chars.length <= 1 ? '*' : chars[0] + '*'.repeat(Math.min(chars.length - 1, 4));
}

/**
 * 找到注册库目录：必须显式设置 SEL_STUDENT_HOST_DIR，且目录已经存在。
 * 返回 null 时已经打印了原因（不创建任何东西）。
 */
function resolveHostDirStrict(): string | null {
  const explicit = process.env.SEL_STUDENT_HOST_DIR;
  if (!explicit || !explicit.trim()) {
    console.error('拒绝运行：没有设置 SEL_STUDENT_HOST_DIR。请用和服务相同的值，例如：');
    console.error('  sudo -u supererrorlog env SEL_STUDENT_HOST_DIR=/var/lib/super-error-log/student-host node dist/studentHost/admin-cli.js list');
    return null;
  }
  const dir = path.resolve(explicit);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`拒绝运行：SEL_STUDENT_HOST_DIR 指向的目录不存在：${dir}。请检查有没有写错（这个命令不会新建注册库）。`);
    return null;
  }
  return dir;
}

function parseFlag(args: string[], flag: string): { value: number | undefined; rest: string[] } | null {
  const index = args.indexOf(flag);
  if (index < 0) return { value: undefined, rest: args };
  const raw = args[index + 1];
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  return { value: Number(raw), rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

/** 参数个数/身份取值不对：打印原因与用法，返回 2，不做任何变更。 */
function argError(message: string): number {
  console.error(`参数不对：${message}`);
  console.error(USAGE);
  return 2;
}

/** 可选身份参数：缺省 student；给了但不合法返回 null（调用方报错退出，不创建任何东西）。 */
function parseRoleArg(raw: string | undefined): AccountRole | null {
  if (raw === undefined) return 'student';
  return isAccountRole(raw) ? raw : null;
}

export function runAdminCli(argv: string[], out: (line: string) => void = console.log): number {
  const [command, ...rest] = argv;
  const hostDir = resolveHostDirStrict();
  if (hostDir === null) return 2;
  if (!fs.existsSync(path.join(hostDir, 'registry.db'))) {
    out(`注意：${hostDir} 里还没有注册库，这次会新建一个空的。如果这不是新装的服务器，请先确认 SEL_STUDENT_HOST_DIR 是否写对。`);
  }
  const registry = StudentRegistry.open(hostDir);
  try {
    switch (command) {
      case 'admin-password': {
        const auth = AdminAuth.open(registry.hostDir);
        try {
          out('管理员密码已生成，旧管理会话已失效。请妥善保存，下方密码只显示这一次。');
          out(`管理员密码：${auth.rotatePassword()}`);
          out('登录地址：/admin/');
          return 0;
        } finally { auth.close(); }
      }
      case 'create': {
        if (rest.length > 1) return argError('create 最多带一个身份参数。');
        const role = parseRoleArg(rest[0]);
        if (role === null) return argError(`身份只能是 ${ACCOUNT_ROLES.join(' / ')}（${Object.values(ACCOUNT_ROLE_LABELS).join('/')}），收到「${rest[0]}」。`);
        const { studentId } = registry.createStudent(role);
        const { code, expiresAt } = registry.issueInvitation(studentId);
        out(`学生已创建：${studentId}（身份：${ACCOUNT_ROLE_LABELS[role]}）`);
        out(`邀请码（只显示这一次，60 天有效，可重复登录，到 ${expiresAt.toISOString()}）：${code}`);
        return 0;
      }
      case 'invite': {
        const studentId = rest[0] ?? '';
        const { code, expiresAt } = registry.issueInvitation(studentId);
        out(`学生 ${studentId} 的新邀请码（只显示这一次，60 天有效，可重复登录，到 ${expiresAt.toISOString()}）：${code}`);
        return 0;
      }
      case 'reset-invitation': {
        if (rest.length !== 1) return argError('reset-invitation 需要学生 ID；请先核验申请者本人。');
        const { code, expiresAt } = registry.resetInvitation(rest[0]!);
        out('原邀请码和登录会话已失效；学习记录保留。');
        out('新邀请码（只显示这一次，60 天有效，可重复登录，到 ' + expiresAt.toISOString() + '）：' + code);
        return 0;
      }
      case 'lookup': {
        if (rest.length === 1) {
          const matches = registry.searchRegistrations(rest[0]!);
          if (matches.length === 0) { out('没有匹配的注册资料。'); return 1; }
          out(`找到 ${matches.length} 个候选（姓名已打码；请和申请人核对完整姓名、手机号后再操作）：`);
          for (const match of matches) {
            out(`${match.studentId}  ${maskName(match.name)}  尾号 ${match.phoneLast4}  注册于 ${match.createdAt}${match.disabledAt ? '  已停用' : ''}`);
          }
          return 0;
        }
        if (rest.length !== 2) return argError('lookup 需要「姓名 手机号」，或者一个姓名片段 / 手机尾号 4 位；仅供管理员核验本人后定位账号。');
        const studentId = registry.findRegisteredStudent(rest[0]!, rest[1]!);
        if (!studentId) { out('没有匹配的注册资料。'); return 1; }
        out('账号：' + studentId);
        out('确认本人后使用 reset-invitation <studentId> 换新码并作废旧凭证；此查询不返回邀请码。');
        return 0;
      }
      case 'list': {
        const students = registry.listStudents();
        if (students.length === 0) { out('还没有学生空间。'); return 0; }
        for (const student of students) {
          const who = student.registeredName ? `${student.registeredName}  尾号 ${student.phoneLast4 ?? '—'}` : '（管理员建号，无登记姓名）';
          out(`${student.studentId}  ${who}  身份 ${ACCOUNT_ROLE_LABELS[student.accountRole]}  创建于 ${student.createdAt}  最近活跃 ${student.lastActiveAt ?? '—'}  可用邀请码 ${student.pendingInvitations}  登录中设备 ${student.activeSessions}${student.disabledAt ? '  已停用' : ''}`);
        }
        return 0;
      }
      case 'set-role': {
        if (rest.length !== 2) return argError('set-role 需要正好两个参数：<studentId> <role>。');
        const [studentId, rawRole] = rest as [string, string];
        if (!isAccountRole(rawRole)) return argError(`身份只能是 ${ACCOUNT_ROLES.join(' / ')}（${Object.values(ACCOUNT_ROLE_LABELS).join('/')}），收到「${rawRole}」。`);
        registry.setAccountRole(studentId, rawRole);
        out(`学生 ${studentId} 的身份已改为：${ACCOUNT_ROLE_LABELS[rawRole]}（${rawRole}）。只是标签，权限没有变化。`);
        return 0;
      }
      case 'revoke-sessions': {
        const studentId = rest[0] ?? '';
        const count = registry.revokeSessions(studentId);
        out(`已撤销学生 ${studentId} 的 ${count} 个会话。`);
        out('注意：邀请码没有作废，持码人可以马上重新登录。要封禁请用 disable；要换码请用 reset-invitation。');
        return 0;
      }
      case 'disable': {
        if (rest.length !== 1) return argError('disable 需要学生 ID。');
        const result = registry.disableStudent(rest[0]!);
        out(`学生 ${rest[0]} 已停用：作废 ${result.expiredInvitations} 个邀请码、撤销 ${result.revokedSessions} 个会话。学习数据保留。`);
        out('要恢复：reset-invitation <studentId>（会发一个新码）。要彻底删除：等该学生的进程空闲退出（缺省约 12 分钟）后 delete <studentId> --confirm；还在运行时 delete 会拒绝并说明。');
        return 0;
      }
      case 'delete': {
        if (rest.length !== 2 || rest[1] !== '--confirm') return argError('delete 需要 <studentId> --confirm；删除后学习数据不可恢复。');
        const result = registry.deleteStudent(rest[0]!);
        out(`学生 ${rest[0]} 已删除（注册资料、邀请码、会话${result.removedDirectory ? '、学习数据目录' : ''}）。`);
        out('提醒：服务器备份里的副本会在备份过期后自然删除；删除记录写在注册库目录的 deletions.log（只有日期和账号 ID）。');
        return 0;
      }
      case 'export': {
        if (rest.length !== 2) return argError('export 需要 <studentId> <outDir>。');
        const target = registry.exportStudent(rest[0]!, rest[1]!);
        out(`已导出到：${target}`);
        out('里面有姓名、手机号和学习数据，请核验本人后再交出，用完删除。');
        return 0;
      }
      case 'registration-code': {
        const [sub, ...args] = rest;
        if (sub === 'create') {
          const uses = parseFlag(args, '--uses');
          if (!uses) return argError('--uses 后面要跟一个正整数。');
          const days = parseFlag(uses.rest, '--days');
          if (!days) return argError('--days 后面要跟一个正整数。');
          const created = registry.createRegistrationCode({ label: days.rest.join(' '), maxUses: uses.value, days: days.value });
          out(`注册码已生成（编号 ${created.id}，备注「${created.label}」，最多 ${created.maxUses} 人，到 ${created.expiresAt.toISOString()}）。`);
          out(`注册码（只显示这一次）：${created.code}`);
          out('把它和注册链接 /s/register 一起发给老师；用完或泄露了用 registration-code revoke <编号> 作废。');
          return 0;
        }
        if (sub === 'list') {
          const codes = registry.listRegistrationCodes();
          if (codes.length === 0) { out('还没有注册码。用 registration-code create 生成。'); return 0; }
          const label = { active: '可用', used_up: '名额已满', expired: '已过期', revoked: '已作废' } as const;
          for (const code of codes) out(`${code.id}  「${code.label}」  已用 ${code.usedCount}/${code.maxUses}  ${label[code.status]}  到 ${code.expiresAt}`);
          return 0;
        }
        if (sub === 'revoke' && args.length === 1) {
          registry.revokeRegistrationCode(args[0]!);
          out(`注册码 ${args[0]} 已作废；已经用它注册的账号不受影响。`);
          return 0;
        }
        return argError('registration-code 后面要跟 create / list / revoke <编号>。');
      }
      default:
        usage();
    }
  } catch (error) {
    if (error instanceof RegistryError) {
      console.error(`失败：${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    registry.close();
  }
}

// 直接执行时进入 CLI；被 import（测试）时不动作。normalizeInviteCode/formatInviteCode 再导出便于脚本校验输出形态。
const invokedAs = process.argv[1] ?? '';
if (invokedAs.endsWith('admin-cli.ts') || invokedAs.endsWith('admin-cli.js')) {
  process.exit(runAdminCli(process.argv.slice(2)));
}

export { formatInviteCode, normalizeInviteCode };
