import type { ReactNode } from 'react';
import { USAGE_DETAIL_CAP, type AdminFilters, type AdminReport, type UsageSummary } from './report.js';

const number = (value: number | null): string => value === null ? '未采集' : value.toLocaleString('zh-CN');
const percent = (value: number | null): string => value === null ? '未采集' : `${(value * 100).toFixed(1)}%`;
const duration = (value: number | null): string => value === null ? '未采集' : `${(value / 1000).toFixed(2)} s`;
const time = (value: string | null): string => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(value)) : '未采集';
export const OPERATIONS: Record<string, string> = {
  mobile_inventory: '整页找题', mobile_transcribe: '题目精读', mobile_verify: '裁图检查', mobile_ground: '识别修正',
  layout: '题目定位', transcribe: '图文转写与作答核对', diagnose: '错因分析', coach: '提示与答案',
  followup: '复盘追问与归纳', match: '回传匹配', correct: '修订建议', asr: '语音转写',
  crop_inventory: '原图清单', crop_verify: '裁图核验',
};
const ERRORS: Record<string, string> = { timeout: '调用超时', cancelled: '调用取消', rate_limited: '服务限流', provider_error: '服务或网络错误',
  unsupported: '配置、认证或请求不支持', invalid_json: '响应 JSON 无效', invalid_output: '响应格式无效', interrupted: '调用中断', internal: '内部错误',
  network: '网络错误', authentication: '服务认证失败', permission: '服务权限不足', output_truncated: '响应输出被截断', unknown: '未记录原因' };
const errorLabel = (code: string | null) => code ? ERRORS[code] ?? '未记录原因' : '—';
const operation = (name: string) => OPERATIONS[name] ?? name;

export function adminLink(filters: AdminFilters, changes: Partial<AdminFilters> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...changes })) if (value !== '' && !(key === 'page' && value === 1)) query.set(key, String(value));
  return `/admin/${query.size ? `?${query}` : ''}`;
}
function Shell({ title, children, signedIn = false }: { title: string; children: ReactNode; signedIn?: boolean }): ReactNode {
  return <html lang="zh-CN"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{`${title} · 纸错题管理后台`}</title><link rel="stylesheet" href="/admin/styles.css" /></head>
    <body><header className="topbar"><a className="brand" href="/admin/"><span className="brand-mark" aria-hidden="true">纸</span>纸错题<span className="brand-label">管理后台</span></a>
      {signedIn && <><nav aria-label="后台导航"><a href="#accounts">账号与邀请码</a><a href="#performance">性能</a><a href="#calls">调用记录</a></nav>
        <form method="post" action="/admin/logout"><button className="quiet" type="submit">退出登录</button></form></>}</header>
      <main>{children}</main><footer>统计时间采用 UTC+8（Asia/Singapore）</footer></body></html>;
}
export function AdminLogin({ error }: { error?: string }): ReactNode {
  return <Shell title="管理员登录"><section className="login-card"><p className="eyebrow">ADMIN CONSOLE</p><h1>管理员登录</h1>
    <p className="subtle">查看邀请码账号的使用情况与 AI 调用性能。</p>
    {error && <p className="notice warning" role="alert">{error}</p>}
    <form method="post" action="/admin/login"><label htmlFor="password">管理员密码</label>
      <input id="password" name="password" type="password" autoComplete="current-password" maxLength={256} required autoFocus />
      <button type="submit">进入管理后台</button></form><p className="small subtle">使用独立的管理员密码登录，学生邀请码用于学生入口。</p></section></Shell>;
}
export function AdminProblem({ message }: { message: string }): ReactNode {
  return <Shell title="暂时无法查看"><section className="login-card"><h1>暂时无法查看</h1><p role="alert">{message}</p><a href="/admin/">返回后台</a></section></Shell>;
}
function PerformanceTable({ rows }: { rows: Array<{ name: string; usage: UsageSummary }> }): ReactNode {
  return <div className="table-scroll"><table><thead><tr><th scope="col">模型 / 功能</th><th scope="col">调用</th><th scope="col">已报告 tokens</th><th scope="col">接口成功率</th><th scope="col">平均耗时</th><th scope="col">P95</th><th scope="col">耗时样本</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.name}><td>{operation(row.name)}</td><td>{number(row.usage.calls)}</td><td>{number(row.usage.totalTokens)}</td><td>{percent(row.usage.successRate)}</td><td>{duration(row.usage.averageMs)}</td><td>{duration(row.usage.p95Ms)}</td><td>{row.usage.timedCalls} / {row.usage.calls}</td></tr>)}</tbody></table>
    {rows.length === 0 && <p className="empty">当前筛选下没有调用记录。</p>}</div>;
}
export function AdminDashboard(report: AdminReport): ReactNode {
  const { filters, summary } = report;
  const warnings = report.accounts.flatMap(account => account.warnings.map(message => `${account.label}：${message}`));
  return <Shell title="用量与性能" signedIn>
    <div className="page-heading"><div><p className="eyebrow">USAGE & PERFORMANCE</p><h1>用量与性能</h1><p className="subtle">从邀请码账号，查看每一次 AI 调用。</p></div>
      <div className="refresh"><span className="small subtle">更新于 {time(new Date().toISOString())}</span><a className="button secondary" href={adminLink(filters)}>刷新数据</a></div></div>
    {warnings.length > 0 && <div className="notice warning" role="status"><strong>部分统计不完整</strong><ul>{warnings.map((message, i) => <li key={i}>{message}</li>)}</ul></div>}
    <form method="get" action="/admin/" className="filters" aria-label="统计筛选">
      <label>账号<select aria-label="账号" name="studentId" defaultValue={filters.studentId}><option value="">全部账号</option>{report.accountOptions.map(account => <option key={account.studentId} value={account.studentId}>{account.label} · {account.studentId.slice(0, 8)}</option>)}</select></label>
      <label>开始日期<input type="date" name="from" defaultValue={filters.from} /></label><label>结束日期<input type="date" name="to" defaultValue={filters.to} /></label>
      <label>模型<select aria-label="模型" name="model" defaultValue={filters.model}><option value="">全部模型</option>{[...new Set([...report.models, ...(filters.model ? [filters.model] : [])])].map(model => <option key={model}>{model}</option>)}</select></label>
      <label>功能<select aria-label="功能" name="operation" defaultValue={filters.operation}><option value="">全部功能</option>{[...new Set([...report.operations, ...(filters.operation ? [filters.operation] : [])])].map(name => <option key={name} value={name}>{operation(name)}</option>)}</select></label>
      <div className="filter-actions"><button type="submit">应用筛选</button><a href="/admin/">重置</a></div>
    </form>
    <section className="metrics" aria-label="调用概览">
      <article className="metric accent"><span>已报告 tokens</span><strong data-testid="total-tokens">{number(summary.totalTokens)}</strong><small>已知输入 + 已知输出</small></article>
      <article className="metric"><span>输入 tokens</span><strong>{number(summary.inputTokens)}</strong><small>{summary.knownInputCalls} / {summary.calls} 次有用量记录</small></article>
      <article className="metric"><span>输出 tokens</span><strong>{number(summary.outputTokens)}</strong><small>{summary.knownOutputCalls} / {summary.calls} 次有用量记录</small></article>
      <article className="metric"><span>接口成功率</span><strong>{percent(summary.successRate)}</strong><small>{summary.succeeded} 成功 · {summary.failed} 失败</small></article>
      <article className="metric"><span>平均调用耗时</span><strong>{duration(summary.averageMs)}</strong><small>{summary.timedCalls} 次有耗时记录</small></article>
      <article className="metric"><span>P95 调用耗时</span><strong>{duration(summary.p95Ms)}</strong><small>95% 的有记录调用不超过此耗时</small></article>
    </section>
    <p className="coverage">共 {number(summary.calls)} 次已记录调用，重试分别计数。未返回用量的调用标为“未采集”；已报告 tokens 是可计量部分，可能低于实际总用量。</p>
    <section className="panel" id="accounts"><div className="section-heading"><div><h2>账号与邀请码</h2><p className="subtle small">{report.accounts.length} 个账号 · AI 指标使用当前筛选，学习使用次数为累计值。补发邀请码不重复累计用量。</p></div></div>
      <div className="table-scroll"><table className="accounts-table"><thead><tr><th scope="col">账号</th><th scope="col">最近活跃</th><th scope="col">邀请码 / 会话</th><th scope="col">调用次数</th><th scope="col">输入 / 输出 tokens</th><th scope="col">接口成功率</th><th scope="col">累计使用</th></tr></thead>
        <tbody>{report.accounts.map(account => <tr key={account.studentId}><td><a className="account-name" href={adminLink(filters, { studentId: account.studentId, page: 1 })}>{account.label}</a>{account.grade ? <small className="block">学段 {account.grade}</small> : null}<small className="mono block">{account.studentId}</small></td>
          <td>{time(account.lastActiveAt)}</td><td>{account.invitations.length} 个邀请码<small className="block subtle">{account.activeSessions} 个有效会话</small></td>
          <td>{account.usage.calls}</td><td>{number(account.usage.inputTokens)} / {number(account.usage.outputTokens)}</td><td>{percent(account.usage.successRate)}</td>
          <td><details><summary>查看使用情况</summary><dl className="activity"><dt>录入题目照片</dt><dd>{number(account.activity.photos)}</dd><dt>错题</dt><dd>{number(account.activity.items)}</dd>
            <dt>练习包</dt><dd>{number(account.activity.packets)}</dd><dt>已生成打印包</dt><dd>{number(account.activity.printed)}</dd><dt>复盘记录</dt><dd>{number(account.activity.reflections)}</dd><dt>重做记录</dt><dd>{number(account.activity.returns)}</dd></dl>
            <p className="small subtle">新采集最早记录：{time(account.firstCollectedAt)}<br />可恢复的历史识别调用：{account.legacyCalls} 次</p></details></td></tr>)}</tbody></table>
        {report.accounts.length === 0 && <p className="empty">还没有符合条件的账号。</p>}</div>
      <details className="invite-details"><summary>查看全部邀请码对应关系</summary><p className="small subtle">展示邀请码编号，不是登录原码。历史原码未保存，无法还原。</p>
        <div className="table-scroll"><table><thead><tr><th scope="col">邀请码编号</th><th scope="col">对应账号</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">首次登录时间</th><th scope="col">到期时间</th></tr></thead>
          <tbody>{report.accounts.flatMap(account => account.invitations.map(invitation => <tr key={invitation.invitationId}><td className="mono">{invitation.invitationId}</td><td>{account.label}</td>
            <td><span className={`badge ${invitation.status === 'redeemed' ? 'success' : ''}`}>{({ pending: '可使用', active: '可重复登录', redeemed: '已兑换（旧码）', expired: '已过期' })[invitation.status]}</span></td>
            <td>{time(invitation.createdAt)}</td><td>{invitation.redeemedAt ? time(invitation.redeemedAt) : '—'}</td><td>{time(invitation.expiresAt)}</td></tr>))}</tbody></table></div></details>
    </section>
    <section className="panel" id="performance"><div className="section-heading"><div><h2>调用性能</h2><p className="subtle small">耗时包含请求、响应读取与解析，不含排队。接口成功不代表题目识别正确。</p></div></div>
      <h3>按模型</h3><PerformanceTable rows={report.byModel} /><h3>按功能</h3><PerformanceTable rows={report.byOperation} />
      <div className="failures"><h3>失败原因</h3>{report.failures.length ? <ul>{report.failures.map(row => <li key={row.code}><span>{errorLabel(row.code)}</span><strong>{row.count} 次</strong></li>)}</ul> : <p className="subtle small">当前筛选下没有已记录的失败调用。</p>}</div>
    </section>
    <section className="panel" id="calls"><div className="section-heading"><div><h2>调用明细</h2><p className="subtle small">最新在前 · 每页 50 条{report.detailLimited ? ` · 明细最多展示 ${USAGE_DETAIL_CAP.toLocaleString('zh-CN')} 条，上方合计仍是全部调用` : ''} · 历史识别日志缺少的耗时保留为“未采集”。</p></div><span className="badge">{summary.calls} 条记录</span></div>
      <div className="table-scroll"><table className="calls-table"><thead><tr><th scope="col">时间</th><th scope="col">账号</th><th scope="col">功能</th><th scope="col">模型</th><th scope="col">输入 tokens</th><th scope="col">输出 tokens</th><th scope="col">耗时</th><th scope="col">状态</th><th scope="col">失败原因 / HTTP</th></tr></thead>
        <tbody>{report.records.map(row => <tr key={`${row.studentId}:${row.id}`}><td>{time(row.startedAt)}<small className="block subtle">{row.source === 'legacy' ? '历史识别日志' : '统一采集'}</small></td><td>{row.accountLabel}</td><td>{operation(row.operation)}</td><td>{row.model}</td>
          <td>{number(row.inputTokens)}</td><td>{number(row.outputTokens)}</td><td>{duration(row.durationMs)}</td><td><span className={`badge ${row.status === 'succeeded' ? 'success' : 'failure'}`}>{row.status === 'succeeded' ? '成功' : '失败'}</span></td><td>{errorLabel(row.errorCode)}<small className="block subtle">HTTP {row.httpStatus ?? '未返回'}</small></td></tr>)}</tbody></table>
        {report.records.length === 0 && <p className="empty">没有符合筛选条件的调用。</p>}</div>
      <div className="pagination"><span className="subtle small">第 {filters.page} 页 / 共 {report.pages} 页</span><div>{filters.page > 1 && <a className="button secondary" href={adminLink(filters, { page: filters.page - 1 })}>上一页</a>}{filters.page < report.pages && <a className="button secondary" href={adminLink(filters, { page: filters.page + 1 })}>下一页</a>}</div></div>
    </section>
    <aside className="notice"><strong>数据覆盖说明</strong><p>新采集覆盖文字、图片与语音的实际模型调用。历史数据只能恢复已有的部分图片识别日志；没有记录的历史用量、进程意外终止前尚未落盘的调用无法补算。Mock 示例不计入真实模型调用。</p></aside>
  </Shell>;
}
