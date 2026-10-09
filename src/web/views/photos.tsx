import type { ReactNode } from 'react';
import type { RecognitionJob } from '../../mobile/contracts.js';
import type { PhotoView } from '../state.js';
import { pickMoreCount, unselectedQuestions } from '../photoPlan.js';
import { Page, Problem, type BarButton, type BarModel } from './layout.js';

/** 上传前看一下（§4.3）。事实要素不删；按网页的实际情况改了两处：照片不进相册、上传前去掉位置信息。 */
export function ConsentPage(): ReactNode {
  const bar: BarModel = {
    caption: '第一次上传前看一下',
    primary: { title: '同意，上传', key: 'consent', post: '/s/consent' },
    secondary: [{ title: '先不传', key: 'goHome', href: '/s/' }],
  };
  return (
    <Page title="上传前看一下" bar={bar}>
      <h1>上传前看一下</h1>
      <section className="card" data-testid="consent">
        <p>拍的照片会传到广州的云服务器，再交给阿里云百炼的 AI 找出做错的题。照片上可能有你的名字和字迹，介意的话先遮住再拍。</p>
        <p className="small muted">用网页拍的照片不会存进手机相册，只存在服务器上；从相册选的，原图还留在相册里。上传前会去掉照片里的位置等拍摄信息。阿里云怎么处理数据，不由这个网页决定。</p>
      </section>
    </Page>
  );
}

function photoStatus(photo: PhotoView): { text: string; tone: string } {
  if (photo.state === 'finding') return { text: 'AI 正在找题', tone: 'blue' };
  if (photo.state === 'failed') return { text: '没认出来', tone: 'red' };
  if (photo.state === 'needsPick') return { text: '找好了 · 要你勾', tone: 'orange' };
  return { text: '找好了', tone: 'green' };
}

export function CapturePage(props: { photos: PhotoView[]; next: { title: string; href: string } | null; caption: string; flash?: { ok?: string | null; err?: string | null } }): ReactNode {
  const visible = props.photos.filter(photo => !(photo.dismissed && photo.state === null && photo.failure));
  const has = props.photos.length > 0;
  const secondary: BarButton[] = has
    ? [{ title: '从相册选', key: 'library', labelFor: 'library-input' }]
    : [{ title: '这周没发卷子，跳过', key: 'skipShoot', post: '/s/skip', fields: { step: 'shoot' } }, { title: '从相册选', key: 'library', labelFor: 'library-input' }];
  const bar: BarModel = {
    caption: props.caption,
    primary: has ? { title: '拍完了，下一步', key: 'next', href: props.next?.href ?? '/s/photos' } : { title: '拍第一页', key: 'capture', labelFor: 'camera-input' },
    secondary,
  };
  return (
    <Page title="拍这周的卷子" bar={bar} flash={props.flash}>
      <h1>拍这周的卷子</h1>
      <p>整页拍全，别裁边；题目和你写的答案都要拍进去。一页拍一张。</p>
      <form method="post" action="/s/capture" encType="multipart/form-data" data-upload="" id="upload-form">
        <input id="camera-input" className="visually-hidden" type="file" name="photo" accept="image/*" capture="environment" data-testid="camera-input" />
        <input id="library-input" className="visually-hidden" type="file" name="photo" accept="image/*" data-testid="library-input" />
        <p className="no-js-only small muted">选好照片后点「上传这张」。</p>
        <button className="btn no-js-only" type="submit" style={{ marginTop: 8 }}>上传这张</button>
        <div className="hidden" data-upload-progress=""><div className="progress"><i /></div></div>
        <p className="small" data-upload-message="" data-testid="upload-message" aria-live="polite" />
        <button type="button" className="btn hidden" data-upload-retry="">再试一次</button>
      </form>
      {has ? <p data-testid="photo-count"><b>已拍 {props.photos.length} 张</b></p> : null}
      <div className="grid">
        {visible.map(photo => {
          const status = photoStatus(photo);
          return (
            <figure key={photo.jobId} data-testid="photo-tile">
              <img src={`/s/img/photo/${photo.jobId}`} alt={`第 ${photo.number} 张`} loading="lazy" />
              <figcaption>第 {photo.number} 张 · <span className={`status tone-${status.tone}`}>{status.text}</span></figcaption>
            </figure>
          );
        })}
        {has ? <label className="add-tile" htmlFor="camera-input" data-testid="add-page">＋ 再拍一页</label> : null}
      </div>
    </Page>
  );
}

function autoCount(job: RecognitionJob | null): { auto: number; picked: number } {
  const questions = (job?.questions ?? []).filter(q => q.status !== 'unselected' && q.status !== 'skipped');
  const picked = questions.filter(q => q.selectedByStudent).length;
  return { auto: questions.length - picked, picked };
}

function PhotoRow(props: { photo: PhotoView }): ReactNode {
  const { photo } = props;
  const prefix = `第 ${photo.number} 张 · `;
  if (photo.state === 'finding') {
    const more = pickMoreCount(photo.job);
    return (
      <li className="row" data-testid={`photo-row-${photo.number}`}>
        <span className="tone-blue">{prefix}AI 正在找题…</span>
        {more ? <a href={`/s/photos/${photo.jobId}`} className="small">还有 {more} 道没勾 · 漏了题可以补</a> : null}
      </li>
    );
  }
  if (photo.state === 'needsPick') {
    return (
      <li><a className="row" href={`/s/photos/${photo.jobId}`} data-testid={`photo-row-${photo.number}`}>
        <span className="tone-orange" style={{ flex: 1 }}>{prefix}这页没有批改痕迹，点这里勾出错题</span><span className="chev">›</span>
      </a></li>
    );
  }
  if (photo.state === 'failed' && photo.failure) {
    const plan = photo.failure;
    return (
      <li className="row" data-testid={`photo-row-${photo.number}`} style={{ display: 'block' }}>
        <p className="tone-red" style={{ margin: 0 }}>{prefix}{plan.title}</p>
        <p className="small muted">{plan.detail}</p>
        <div>
          {plan.retryTitle ? (
            <form method="post" action={`/s/photos/${photo.jobId}/retry`} className="inline-form">
              {(plan.retryQuestionIds ?? []).map(id => <input key={id} type="hidden" name="questionIds" value={id} />)}
              <button className="link-btn" type="submit">{plan.retryTitle}</button>
            </form>
          ) : null}
          {plan.retryTitle ? ' · ' : null}
          <form method="post" action={`/s/photos/${photo.jobId}/dismiss`} className="inline-form"><button className="link-btn" type="submit">{plan.dismissTitle}</button></form>
        </div>
      </li>
    );
  }
  if (photo.dismissed && photo.failure) return null;
  const { auto, picked } = autoCount(photo.job);
  const left = unselectedQuestions(photo.job).length;
  const text = picked === 0 ? `找到 ${auto} 道有红叉的题` : `${auto + picked} 道已进错题本`;
  return (
    <li className="row" data-testid={`photo-row-${photo.number}`} style={{ display: 'block' }}>
      <span className="tone-green">{prefix}{text}</span>
      {left > 0 && !photo.pickDone ? <><br /><a href={`/s/photos/${photo.jobId}`} className="small">还有 {left} 道没勾 · 漏了题可以补</a></> : null}
    </li>
  );
}

export function PhotosPage(props: { photos: PhotoView[]; bar: BarModel; refresh: boolean; itemCount: number; flash?: { ok?: string | null; err?: string | null } }): ReactNode {
  return (
    <Page title="勾出做错的题" bar={props.bar} refreshSeconds={props.refresh ? 4 : undefined} flash={props.flash}>
      <h1>勾出做错的题</h1>
      <p>有红叉、订正的题，AI 会自己找出来。没批改过的页（比如答题卡另交的），要你自己勾。</p>
      {props.photos.length === 0 ? (
        <section className="card"><p>这周还没拍卷子</p><a className="btn" href="/s/capture">去拍</a></section>
      ) : (
        <section className="card"><ul className="list">{props.photos.map(photo => <PhotoRow key={photo.jobId} photo={photo} />)}</ul></section>
      )}
      {props.itemCount > 0 ? <p><a href="/s/items" data-testid="photos-items">看看找到的错题（{props.itemCount} 道）›</a></p> : null}
    </Page>
  );
}

/** 勾选面板（§4.4 的网页版）：一屏列出这张照片的候选题，勾了再精读。 */
export function PickPage(props: { photo: PhotoView; error?: string | null }): ReactNode {
  const { photo } = props;
  const questions = photo.job?.questions ?? [];
  const selectable = questions.filter(q => q.status === 'unselected');
  const bar: BarModel = {
    caption: '只有勾出的题会进错题本。AI 不判断你做得对不对。',
    primary: { title: '把勾出的题加入错题本', key: 'select', form: 'pick-form', countTemplate: '把这 {n} 道加入错题本', emptyTitle: '先勾出做错的题' },
    secondary: [{ title: '这页没有做错的题', key: 'none', post: `/s/photos/${photo.jobId}/none` }],
  };
  return (
    <Page title={`第 ${photo.number} 张：勾出做错的题`} back={{ href: '/s/photos', label: '‹ 勾出做错的题' }} bar={bar}>
      <h1>第 {photo.number} 张：勾出做错的题</h1>
      <p><a href={`/s/img/photo/${photo.jobId}?full=1`} target="_blank" rel="noreferrer">看原图</a></p>
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
                <img className="crop" src={`/s/img/cand/${photo.jobId}/${question.id}`} alt={`第 ${question.number} 题`} loading="lazy" />
              </span>
            </label>
          );
        })}
      </form>
    </Page>
  );
}
