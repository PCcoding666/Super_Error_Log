import type { ReactNode } from 'react';
import type { Role } from '../domain/types.js';
import { Layout } from './layout.js';

export interface HomeData {
  nickname: string;
  aiMode: string;
  aiDegraded: boolean;
  pendingCorrection: number;
  pendingReflection: number;
  eligibleCount: number;
  activePacket: { id: string; status: string; plannedDate: string | null; total: number; attempted: number } | null;
  recentBatch: { id: string; status: string; total: number; done: number; failed: number } | null;
}

export function HomePage(props: { role: Role; data: HomeData; flash?: { ok?: string; err?: string } }): ReactNode {
  const d = props.data;
  return (
    <Layout title="首页" role={props.role} flash={props.flash} refreshSeconds={d.recentBatch?.status === 'processing' ? 3 : undefined}>
      <h1>周末好，{d.nickname}</h1>
      <p className="muted">
        当前为{d.aiMode === 'mock' ? '演示模式（未连接真实 AI 服务，所有识别为本地模拟）' : '真实 AI 模式'}
        {d.aiMode !== 'mock' ? '（真实调用需有效本机配置）' : ''}。
      </p>

      <section className="card">
        <h2>本周待办</h2>
        <ul className="todo">
          <li>
            <a href="/batches">① 上传本周错题</a>
            {d.recentBatch ? (
              <span className="muted">
                （最近批次：{d.recentBatch.done}/{d.recentBatch.total} 完成
                {d.recentBatch.failed > 0 ? `，${d.recentBatch.failed} 个失败` : ''}）
              </span>
            ) : null}
          </li>
          <li>
            {d.pendingCorrection > 0 ? (
              <span>
                ② <strong>{d.pendingCorrection}</strong> 道题待人工校正（AI 不确定）——
                <a href="/batches">去校正</a>
              </span>
            ) : (
              <span className="muted">② 没有待校正的题</span>
            )}
          </li>
          <li>
            {d.pendingReflection > 0 ? (
              <span>
                ③ <strong>{d.pendingReflection}</strong> 道题待你完成四项反思 —— <a href="/reflect">去反思</a>
              </span>
            ) : (
              <span className="muted">③ 没有待反思的题</span>
            )}
          </li>
          <li>
            {d.eligibleCount > 0 ? (
              <span>
                ④ 有 <strong>{d.eligibleCount}</strong> 道题可安排 —— <a href="/plan">生成本周复习包</a>
              </span>
            ) : (
              <span className="muted">④ 暂无足够题目生成复习包</span>
            )}
          </li>
          {d.activePacket ? (
            <li>
              ⑤ 当前复习包（{d.activePacket.attempted}/{d.activePacket.total} 已回传）——
              <a href={`/packets/${d.activePacket.id}`}>查看/打印</a> ·{' '}
              <a href={`/packets/${d.activePacket.id}/return`}>回传结果</a>
            </li>
          ) : null}
        </ul>
      </section>

      <section className="card">
        <h2>上传新批次</h2>
        <form method="post" action="/batches" encType="multipart/form-data" className="form">
          <label htmlFor="files">选择本周错题照片或 PDF（可多选）</label>
          <input id="files" name="files" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" required />
          <p className="muted">支持 JPG/PNG/WebP/PDF，单个文件不超过 15MB。拍摄时请包含原题、你的解题过程和老师批注。</p>
          <button className="btn primary" type="submit">
            开始上传并识别
          </button>
        </form>
      </section>
    </Layout>
  );
}
