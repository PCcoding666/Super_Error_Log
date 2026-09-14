import type { ReactNode } from 'react';
import type { Role } from '../domain/types.js';
import { Layout } from './layout.js';

export function SettingsPage(props: {
  role: Role;
  nickname: string;
  subjects: string[];
  aiMode: string;
  aiDegraded: boolean;
  flash?: { ok?: string; err?: string };
}): ReactNode {
  return (
    <Layout title="设置" role={props.role} flash={props.flash}>
      <h1>设置</h1>

      <section className="card">
        <h2>学生档案</h2>
        <p>
          昵称：<strong>{props.nickname}</strong>（匿名，可随时在数据库中删除）
        </p>
        <p>学科：{props.subjects.join('、')}</p>
      </section>

      <section className="card">
        <h2>AI 服务</h2>
        <p>
          当前模式：<strong>{props.aiMode === 'mock' ? '演示模式（本地模拟，无需联网）' : '真实 AI 服务'}</strong>
          {props.aiMode !== 'mock' ? '（缺配置会报错，不会切换到演示数据）' : ''}
        </p>
        <p className="muted">
          要使用真实识别：设置环境变量 SEL_AI_MODE=openai、SEL_AI_BASE_URL、SEL_AI_API_KEY、SEL_AI_MODEL 后重启。
          Key 只从环境读取，不会显示或保存在这里。
        </p>
      </section>

      <section className="card">
        <h2>数据管理</h2>
        <p className="muted">所有数据保存在本机 data/ 目录。清空数据将删除全部错题、反思与复习记录。</p>
        <form method="post" action="/settings/reset" data-confirm="确定清空全部数据？此操作不可恢复。">
          <button className="btn danger" type="submit">
            清空全部数据
          </button>
        </form>
      </section>
    </Layout>
  );
}
