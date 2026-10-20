import type { ReactNode } from 'react';
import { CAPTURE_EXAMPLE_PAGE, CAPTURE_EXAMPLE_QUESTION } from '../captureExamples.js';
import type { PhotoView } from '../state.js';
import { pickMoreCount, unselectedQuestions } from '../photoPlan.js';
import { Page, NextBar, Phrased, Problem, WaitLine, quoted, type BarModel } from './layout.js';

export function CaptureExamples(): ReactNode {
  return (
    <figure className="capture-examples" data-testid="capture-examples">
      <div className="capture-example-row">
        <img data-testid="capture-example-page" src={CAPTURE_EXAMPLE_PAGE.path} alt="平放拍全的试卷示例" width={480} height={645} />
        <img data-testid="capture-example-question" src={CAPTURE_EXAMPLE_QUESTION.path} alt="题目和作答都清楚的示例" width={480} height={315} />
      </div>
      <figcaption className="small muted">平放、拍全、光线均匀</figcaption>
    </figure>
  );
}

function CaptureTabs(props: { active: 'capture' | 'history' }): ReactNode {
  return (
    <nav className="capture-tabs" aria-label="错题录入视图">
      <a href="/s/capture" aria-current={props.active === 'capture' ? 'page' : undefined}>新增录入</a>
      <a href="/s/photos" aria-current={props.active === 'history' ? 'page' : undefined}>已上传记录</a>
    </nav>
  );
}

function uploadedAt(photo: PhotoView, timeZone = 'Asia/Shanghai'): string {
  const date = new Date(photo.registeredAt);
  if (!Number.isFinite(date.getTime())) return '上传时间未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export function CapturePage(props: { photos: PhotoView[]; next: { title: string; href: string } | null; caption: string; flash?: { ok?: string | null; err?: string | null } }): ReactNode {
  const has = props.photos.length > 0;
  const bar: BarModel = {
    caption: props.caption,
    primary: { title: '拍照录入', key: 'capture', labelFor: 'camera-input' },
    secondary: [{ title: '从相册选', key: 'library', labelFor: 'library-input' }],
  };
  return (
    <Page title="错题录入" tab="capture" bodyClass="capture-page" flash={props.flash} pollSeconds={props.photos.some(photo => photo.state === 'finding') ? 4 : undefined}>
      <h1>错题录入</h1>
      <CaptureTabs active="capture" />
      <div className="capture-actions"><NextBar model={bar} inline /></div>
      {has ? null : <CaptureExamples />}
      <form method="post" action="/s/capture" encType="multipart/form-data" data-upload="" data-capture-upload="" data-photo-count={props.photos.length} id="upload-form">
        <input id="camera-input" className="visually-hidden" type="file" name="photo" accept="image/*" capture="environment" data-testid="camera-input" />
        {/* 脚本启动后启用相册多选；无脚本时仍用原有单张表单。 */}
        <input id="library-input" className="visually-hidden" type="file" name="photo" accept="image/*" data-testid="library-input" />
        <p className="js-only small muted">从相册可以一次选多张，上传后可继续录入。</p>
        <p className="no-js-only small muted">{quoted('选好照片后点「上传这张」。')}</p>
        <button className="btn no-js-only" type="submit" data-key="upload-nojs">上传这张</button>
        <div className="hidden" data-upload-progress=""><div className="progress" role="progressbar" aria-label="整批上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}><i /></div></div>
        <p className="small" data-upload-message="" data-testid="upload-message" aria-live="polite" />
        <button type="button" className="btn hidden" data-upload-retry="" data-key="upload-retry">再试一次</button>
        <a className="more hidden" href="/s/photos" data-upload-next="" data-key="uploaded-photos">查看已上传的照片 ›</a>
        <ul className="upload-list" data-upload-list="" aria-label="本次照片上传列表" />
      </form>
      <p data-testid="photo-count" className={has ? undefined : 'hidden'}><b>已拍 {props.photos.length} 张</b></p>
      <div data-live="capture-status">{props.photos.some(photo => photo.state === 'finding') ? <p role="status">照片已收到，正在找题。</p> : null}</div>
      {has ? <p><a className="more" href={props.next?.href ?? '/s/items'}>查看错题 ›</a></p> : null}
    </Page>
  );
}

function PhotoRow(props: { photo: PhotoView; isNew?: boolean; justAdded?: boolean; timeZone?: string }): ReactNode {
  const { photo } = props;
  if (photo.dismissed && photo.failure) return null;
  const date = uploadedAt(photo, props.timeZone);
  const left = photo.state === 'finding' ? pickMoreCount(photo.job) ?? 0 : unselectedQuestions(photo.job).length;
  const plan = photo.state === 'failed' ? photo.failure : null;
  const status = photo.state === 'finding' ? '照片已收到，正在找题。'
    : photo.state === 'needsPick' ? '这页没有批改痕迹，点这里勾出错题'
    : plan ? plan.title
    : photo.itemCount > 0 ? `已新增 ${photo.itemCount} 道错题` : '暂未新增错题';
  const tone = photo.state === 'finding' ? 'blue' : photo.state === 'needsPick' ? 'orange' : plan ? 'red' : 'green';
  return (
    <li className={`photo-record${props.justAdded ? ' m-rise' : ''}`} data-testid={`photo-row-${photo.number}`} data-row={`photo-${photo.jobId}`}>
      <a className="photo-preview" href={`/s/img/photo/${photo.jobId}?full=1`} target="_blank" rel="noreferrer" aria-label={`查看 ${date} 上传的原图（新窗口）`}>
        <img src={`/s/img/photo/${photo.jobId}`} alt="上传照片缩略图" width={84} height={104} loading="lazy" />
      </a>
      <div className="photo-record-content">
        <time className="small muted" dateTime={photo.registeredAt}>{date}</time>
        {props.isNew ? <span className="tag" data-testid={`photo-new-${photo.number}`}>新拍的</span> : null}
        <p className={`flush tone-${tone}`}><Phrased text={status} /></p>
        {plan ? (
          <>
            <p className="small muted"><Phrased text={plan.detail} /></p>
            <div className="actions">
              {plan.retryTitle ? (
                <form method="post" action={`/s/photos/${photo.jobId}/retry`} className="inline-form">
                  {(plan.retryQuestionIds ?? []).map(id => <input key={id} type="hidden" name="questionIds" value={id} />)}
                  <button className="link-btn" type="submit" data-key="photo-retry">{plan.retryTitle}</button>
                </form>
              ) : null}
              <form method="post" action={`/s/photos/${photo.jobId}/dismiss`} className="inline-form"><button className="link-btn" type="submit" data-key="photo-dismiss">{plan.dismissTitle}</button></form>
            </div>
          </>
        ) : null}
        {photo.state === 'needsPick' ? <a className="more" href={`/s/photos/${photo.jobId}`} data-key="photo-pick">勾出错题</a>
          : left > 0 && !photo.pickDone ? <a className="more" href={`/s/photos/${photo.jobId}`} data-key="photo-pick-more"><Phrased text={`还有 ${left} 道没勾 · 漏了题可以补`} /></a> : null}
      </div>
    </li>
  );
}

/**
 * 这周的练习纸已经生成以后（做完了 / 周中）又拍了卷子：不再把他带去选题（这周的练习已经定了），
 * 而是说清楚新找到的题去了哪里（进错题本，下个周末「选这周要练的题」时会出现），并给「返回错题本」。门槛 G3。
 */
/** 还在找题的照片里，最早登记的那张是什么时候（等了多久从它算）。 */
export function findingSince(photos: PhotoView[]): string | null {
  const times = photos.filter(photo => photo.state === 'finding').map(photo => photo.registeredAt).filter(Boolean).sort();
  return times[0] ?? null;
}

export function PhotosPage(props: { photos: PhotoView[]; bar: BarModel; refresh: boolean; itemCount: number; afterWeek?: boolean; newSince?: string | null;
  added?: { count: number; number: number } | null; now?: Date; timeZone?: string; flash?: { ok?: string | null; err?: string | null } }): ReactNode {
  const since = props.newSince ? Date.parse(props.newSince) : NaN;
  const isNew = (photo: PhotoView): boolean => Number.isFinite(since) && Date.parse(photo.registeredAt) > since;
  const newPhotos = props.photos.filter(isNew);
  const newCount = newPhotos.length;
  const newItemCount = newPhotos.reduce((count, photo) => count + photo.itemCount, 0);
  const finding = newPhotos.some(photo => photo.state === 'finding');
  return (
    <Page title="已上传记录" back={{ href: '/s/capture', label: '新增录入' }} bar={props.bar} pollSeconds={props.refresh ? 3 : undefined} flash={props.flash}>
      <h1>已上传记录</h1>
      <CaptureTabs active="history" />
      <div data-live="added">{props.added ? <div className="flash m-rise" role="status" data-testid="photos-added">{props.added.count} 道加进错题本了 ✓</div> : null}</div>
      <p className="lead">点击缩略图查看原图；需要补勾或重试的照片会显示在记录里。</p>
      <div data-live="after">
      {props.afterWeek || newCount > 0 ? (
        <section className="card callout" data-testid="photos-after-week">
          <h2 className="card-title">补充错题</h2>
          {newCount > 0 ? <p role="status" data-testid="photos-added-status">{finding ? '照片已收到，正在找题。' : newItemCount > 0 ? `已新增 ${newItemCount} 道错题` : newPhotos.some(photo => photo.state === 'needsPick') ? '照片已收到，请勾出做错的题。' : '暂未新增错题，请查看下方照片状态。'}</p> : null}
          {newItemCount > 0 && !finding
            ? <p>已保存到错题本，这次补充不会改变之前的练习纸。</p>
            : <p data-testid="photos-new-note">这次补充不会改变之前的练习纸，找到的错题会在保存后出现在错题本。</p>}
        </section>
      ) : null}
      </div>
      {/* 找题的进度：开着脚本时这一块和底栏按需换掉（局部更新），页面别的地方不动。 */}
      <div data-live="photos">
        {props.photos.length === 0 ? (
          <section className="card"><p>还没有上传记录</p><a className="btn" href="/s/capture" data-key="empty-capture">去拍</a></section>
        ) : (
          <section className="card">
            <ul className="list">{[...props.photos].sort((a, b) => Date.parse(b.registeredAt) - Date.parse(a.registeredAt) || b.number - a.number).map(photo => <PhotoRow key={photo.jobId} photo={photo} isNew={isNew(photo)} justAdded={props.added?.number === photo.number} timeZone={props.timeZone} />)}</ul>
            {props.refresh ? <WaitLine since={findingSince(props.photos)} now={props.now ?? new Date()} expect="找好了这一页会自己更新，可以先离开" /> : null}
          </section>
        )}
      </div>
      <div data-live="more">
        {props.itemCount > 0 ? <a className="more" href="/s/items" data-testid="photos-items"><Phrased text={`查看错题本（${props.itemCount} 道）`} suffix={<span className="chev-i" aria-hidden="true">›</span>} /></a> : null}
        <a className="more" href="/s/" data-key="photos-home">返回错题本<span aria-hidden="true">›</span></a>
      </div>
    </Page>
  );
}

/** 勾选面板（§4.4 的网页版）：一屏列出这张照片的候选题，勾了再精读。 */
export function PickPage(props: { photo: PhotoView; error?: string | null; timeZone?: string }): ReactNode {
  const { photo } = props;
  const questions = photo.job?.questions ?? [];
  const selectable = questions.filter(q => q.status === 'unselected');
  const bar: BarModel = {
    caption: '只有勾出的题会进错题本。AI 不判断你做得对不对。',
    primary: { title: '把勾出的题加入错题本', key: 'select', form: 'pick-form', countTemplate: '把这 {n} 道加入错题本', emptyTitle: '先勾出做错的题' },
    secondary: [{ title: '这页没有做错的题', key: 'none', post: `/s/photos/${photo.jobId}/none` }],
  };
  return (
    <Page title="勾出做错的题" back={{ href: '/s/photos', label: '已上传记录' }} bar={bar}>
      <h1>勾出做错的题</h1>
      <p className="small muted"><time dateTime={photo.registeredAt}>{uploadedAt(photo, props.timeZone)}</time> 上传</p>
      <a className="more" href={`/s/img/photo/${photo.jobId}?full=1`} target="_blank" rel="noreferrer" data-key="pick-full-photo"><Phrased text="看这一页的原图" suffix={<span className="chev-i" aria-hidden="true">›</span>} /></a>
      {props.error ? <Problem title="没加进去" detail={props.error} /> : null}
      {selectable.length === 0 ? <p className="muted">这张照片上的题都处理过了。</p> : null}
      <form method="post" action={`/s/photos/${photo.jobId}/select`} id="pick-form" data-pick-count="" data-max="30" data-min="1" data-wait="正在加入…">
        {questions.map(question => {
          const disabled = question.status !== 'unselected';
          return (
            <label key={question.id} className="choice pick" data-testid="pick-candidate">
              <input type="checkbox" name="questionIds" value={question.id} disabled={disabled} />
              <span className="grow">
                <b>第 {question.number} 题</b>{disabled ? <span className="tag">已在错题本</span> : null}
                <img className="crop" src={`/s/img/cand/${photo.jobId}/${question.id}?s=list`} alt={`第 ${question.number} 题`} loading="lazy" />
              </span>
            </label>
          );
        })}
      </form>
    </Page>
  );
}
