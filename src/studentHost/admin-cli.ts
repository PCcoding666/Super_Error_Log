/**
 * 学生空间管理 CLI（只能在本机/SSH 里跑；管理网页只能看统计）：
 *   tsx src/studentHost/admin-cli.ts create [role]                 新建学生空间（上限见 registry）并生成第一个邀请码；role 缺省 student
 *   tsx src/studentHost/admin-cli.ts invite <studentId>            给同一学生补一个邀请码（换手机/清浏览器后用）
 *   tsx src/studentHost/admin-cli.ts list                          列出学生（不含任何码/令牌）
 *   tsx src/studentHost/admin-cli.ts set-role <studentId> <role>   改账号身份标签（student/parent/teacher/admin；只是标签，不是权限）
 *   tsx src/studentHost/admin-cli.ts revoke-sessions <studentId>   撤销该学生的全部登录会话
 *   tsx src/studentHost/admin-cli.ts admin-password              生成/轮换独立管理后台密码
 * 邀请码明文只在生成时打印这一次；不写日志、不落盘。存储位置：SEL_STUDENT_HOST_DIR（缺省 <旧 dataDir>/student-host）。
 * 身份标签（role）只能在这里改；浏览器/网页任何入口都不能改身份。
 */
import { ACCOUNT_ROLE_LABELS, ACCOUNT_ROLES, isAccountRole, type AccountRole } from './accountRole.js';
import { formatInviteCode, normalizeInviteCode, RegistryError, StudentRegistry, resolveStudentHostDir } from './registry.js';
import { AdminAuth } from '../admin/auth.js';

const USAGE = `用法：admin-cli.ts create [${ACCOUNT_ROLES.join('|')}] | invite <studentId> | list | set-role <studentId> <role> | revoke-sessions <studentId> | admin-password`;

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
  const registry = StudentRegistry.open(resolveStudentHostDir());
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
        out(`邀请码（只显示这一次，7 天有效，到 ${expiresAt.toISOString()}）：${code}`);
        return 0;
      }
      case 'invite': {
        const studentId = rest[0] ?? '';
        const { code, expiresAt } = registry.issueInvitation(studentId);
        out(`学生 ${studentId} 的新邀请码（只显示这一次，7 天有效，到 ${expiresAt.toISOString()}）：${code}`);
        return 0;
      }
      case 'list': {
        const students = registry.listStudents();
        if (students.length === 0) { out('还没有学生空间。'); return 0; }
        for (const student of students) {
          out(`${student.studentId}  身份 ${ACCOUNT_ROLE_LABELS[student.accountRole]}  创建于 ${student.createdAt}  可用邀请码 ${student.pendingInvitations}  登录中设备 ${student.activeSessions}`);
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
        return 0;
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
