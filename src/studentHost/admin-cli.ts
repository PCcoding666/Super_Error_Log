/**
 * 学生空间管理 CLI（没有公网管理页；只能在本机/SSH 里跑）：
 *   tsx src/studentHost/admin-cli.ts create                     新建学生空间（上限见 registry）并生成第一个邀请码
 *   tsx src/studentHost/admin-cli.ts invite <studentId>         给同一学生补一个邀请码（换手机/清浏览器后用）
 *   tsx src/studentHost/admin-cli.ts list                       列出学生（不含任何码/令牌）
 *   tsx src/studentHost/admin-cli.ts revoke-sessions <studentId> 撤销该学生的全部登录会话
 * 邀请码明文只在生成时打印这一次；不写日志、不落盘。存储位置：SEL_STUDENT_HOST_DIR（缺省 <旧 dataDir>/student-host）。
 */
import { formatInviteCode, normalizeInviteCode, RegistryError, StudentRegistry, resolveStudentHostDir } from './registry.js';

function usage(): never {
  console.error('用法：admin-cli.ts create | invite <studentId> | list | revoke-sessions <studentId>');
  process.exit(2);
}

export function runAdminCli(argv: string[], out: (line: string) => void = console.log): number {
  const [command, ...rest] = argv;
  const registry = StudentRegistry.open(resolveStudentHostDir());
  try {
    switch (command) {
      case 'create': {
        const { studentId } = registry.createStudent();
        const { code, expiresAt } = registry.issueInvitation(studentId);
        out(`学生已创建：${studentId}`);
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
          out(`${student.studentId}  创建于 ${student.createdAt}  可用邀请码 ${student.pendingInvitations}  登录中设备 ${student.activeSessions}`);
        }
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
