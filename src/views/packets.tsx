import type { ReactNode } from 'react';
import { COMPLETION_LABEL, type Completion, type Role } from '../domain/types.js';
import { Layout } from './layout.js';
import type { ItemRow } from '../services/itemService.js';
import type { Packet } from '../services/planService.js';

export function PacketPage(props: {
  role: Role;
  packet: Packet;
  items: Array<ItemRow & { position: number }>;
  attemptedCount: number;
  flash?: { ok?: string; err?: string };
}): ReactNode {
  const { packet, items } = props;
  return (
    <Layout title="复习包" role={props.role} flash={props.flash}>
      <h1>复习包（{packet.week}）</h1>
      <p className="muted">
        计划完成日期：{packet.planned_date ?? '待定'} · 状态：
        {{ scheduled: '已安排', generated: '已生成 PDF', returned: '已回传' }[packet.status] ?? packet.status}
      </p>
      <p>
        {packet.status === 'scheduled' ? (
          <form method="post" action={`/packets/${packet.id}/generate`}>
            <button className="btn primary" type="submit">
              生成 A4 打印 PDF
            </button>
          </form>
        ) : (
          <a className="btn primary" href={`/packets/${packet.id}/pdf`}>
            下载 PDF（A4 黑白）
          </a>
        )}{' '}
        <a className="btn" href={`/packets/${packet.id}/print-preview`} target="_blank" rel="noreferrer">
          预览打印版式
        </a>{' '}
        <a className="btn" href={`/packets/${packet.id}/return`}>
          回传结果（{props.attemptedCount}/{items.length}）
        </a>
      </p>
      <h2>包含题目</h2>
      <ul className="list">
        {items.map((i) => (
          <li key={i.id} className="card row">
            <div>
              <strong>{i.short_id}</strong> · {i.subject} · {(JSON.parse(i.knowledge_tags) as string[]).join('、')}
            </div>
          </li>
        ))}
      </ul>
      <section className="card">
        <h2>打印说明</h2>
        <ul>
          <li>A4 纵向、黑白打印即可，不需要彩色。</li>
          <li>题目页不含答案；提示与答案核对要点在最后一页，可裁开放在家里。</li>
          <li>每题有答题空间与结果勾选框，做完直接在纸上勾选。</li>
        </ul>
      </section>
    </Layout>
  );
}

export function PacketReturnPage(props: {
  role: Role;
  packet: Packet;
  items: Array<ItemRow & { position: number }>;
  recorded: Record<string, { completion: string; correct: number; performed_at: string | null }>;
  flash?: { ok?: string; err?: string };
}): ReactNode {
  const { packet, items, recorded } = props;
  return (
    <Layout title="回传结果" role={props.role} flash={props.flash}>
      <h1>回传复习结果</h1>
      <p className="muted">
        对照纸质复习包，逐题选择完成情况与对错。独立完成且做对，才会在 3–7 天后被记为「暂时掌握」。
      </p>

      <section className="card">
        <h2>方式一：上传完成页照片（可选）</h2>
        <form method="post" action={`/packets/${packet.id}/return-upload`} encType="multipart/form-data" className="form">
          <label htmlFor="sheet">完成页照片（系统尝试按短 ID 匹配，低置信度会请你手动确认）</label>
          <input id="sheet" name="files" type="file" accept="image/jpeg,image/png,image/webp" multiple />
          <button className="btn" type="submit">
            上传匹配
          </button>
        </form>
      </section>

      <section className="card">
        <h2>方式二：快速录入</h2>
        <form method="post" action={`/packets/${packet.id}/return`} className="form">
          {items.map((i) => {
            const rec = recorded[i.id];
            return (
              <fieldset key={i.id} className="return-item">
                <legend>
                  <strong>{i.short_id}</strong> · {i.subject} · {(JSON.parse(i.knowledge_tags) as string[]).join('、')}
                  {rec ? (
                    <span className="badge conf-ok">
                      已记录：{COMPLETION_LABEL[rec.completion as Completion] ?? rec.completion} ·{' '}
                      {rec.correct ? '做对' : '做错'} · {rec.performed_at ?? '旧记录未填写日期'}
                    </span>
                  ) : null}
                </legend>
                <div className="row wrap">
                  {(Object.keys(COMPLETION_LABEL) as Completion[]).map((c) => (
                    <label key={c} className="check">
                      <input
                        type="radio"
                        name={`completion_${i.id}`}
                        value={c}
                        checked={rec ? rec.completion === c : undefined}
                        disabled={Boolean(rec)}
                      />{' '}
                      {COMPLETION_LABEL[c]}
                    </label>
                  ))}
                </div>
                <div className="row wrap">
                  <label className="check">
                    <input
                      type="radio"
                      name={`correct_${i.id}`}
                      value="1"
                      checked={rec ? rec.correct === 1 : undefined}
                      disabled={Boolean(rec)}
                    />{' '}
                    做对
                  </label>
                  <label className="check">
                    <input
                      type="radio"
                      name={`correct_${i.id}`}
                      value="0"
                      checked={rec ? rec.correct === 0 : undefined}
                      disabled={Boolean(rec)}
                    />{' '}
                    做错
                  </label>
                </div>
                <label htmlFor={`performed_${i.id}`}>实际作答日期（请填写纸上真实作答日期）</label>
                <input
                  id={`performed_${i.id}`}
                  name={`performed_${i.id}`}
                  type="date"
                  value={rec?.performed_at ?? undefined}
                  disabled={Boolean(rec)}
                />
                <label htmlFor={`stuck_${i.id}`}>卡住的步骤（可选）</label>
                <input id={`stuck_${i.id}`} name={`stuck_${i.id}`} maxLength={100} disabled={Boolean(rec)} />
              </fieldset>
            );
          })}
          <button className="btn primary" type="submit">
            提交回传结果
          </button>
        </form>
      </section>
    </Layout>
  );
}
