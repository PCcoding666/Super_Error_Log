import type { ReactNode } from 'react';
import { SUBJECTS } from '../domain/types.js';
import { Layout } from './layout.js';

export function OnboardingPage(props: { error?: string }): ReactNode {
  return (
    <Layout title="首次设置" role="student" flash={props.error ? { err: props.error } : undefined}>
      <h1>欢迎使用错题复习闭环</h1>
      <p className="lead">
        这个工具帮你在周末把一周的纸质错题变成一份可打印的复习包，带回学校用笔完成；
        下周回来记录结果，系统会告诉你哪些题真正掌握了。
      </p>
      <form method="post" action="/onboarding" className="card form">
        <h2>第 1 步：学生档案（匿名）</h2>
        <p className="muted">不需要真实姓名、学校或任何账号，数据只保存在这台设备上。</p>
        <label htmlFor="nickname">昵称（可以虚构）</label>
        <input id="nickname" name="nickname" required maxLength={20} placeholder="例如：小舟" />

        <h2>第 2 步：学科与节奏</h2>
        <fieldset>
          <legend>本学期的学科</legend>
          {SUBJECTS.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" name="subjects" value={s} defaultChecked /> {s}
            </label>
          ))}
        </fieldset>
        <label htmlFor="weekend_pref">周末处理时间偏好</label>
        <select id="weekend_pref" name="weekend_pref">
          <option>周六上午</option>
          <option>周六下午</option>
          <option>周六晚上</option>
          <option>周日上午</option>
        </select>

        <h2>第 3 步：隐私边界</h2>
        <ul className="privacy">
          <li>所有数据只保存在本设备，不会上传到云端训练模型。</li>
          <li>家长视图只能看到知识点薄弱趋势、任务完成率等汇总信息。</li>
          <li>你的错题图片与私人反思，家长视图不可见。</li>
          <li>错因反思由你本人完成，AI 只给建议，不会替你写。</li>
        </ul>
        <label className="check">
          <input type="checkbox" name="privacy_ack" value="yes" required /> 我已了解以上隐私边界
        </label>

        <button className="btn primary" type="submit">
          完成设置，开始使用
        </button>
      </form>
    </Layout>
  );
}
