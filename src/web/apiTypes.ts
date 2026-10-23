/**
 * 学生端单页应用（client/）和服务器 JSON 接口（src/web/api.ts）共用的数据形状。
 * 只放类型，不放实现：客户端用 Bundler 解析直接引用这个文件。
 */

export interface ApiError { error: { code: string; message: string } }

/** 错题本的四档状态（见 notebook.ts）。 */
export type NotebookStatusGroup = 'todo' | 'practicing' | 'mastered' | 'stable';

export interface NotebookItem {
  id: string;
  shortId: string | null;
  subject: string;
  grade: string | null;
  chapter: string;
  knowledgeTags: string[];
  /** 题干摘录；没有可读文字时为空串。 */
  excerpt: string;
  status: NotebookStatusGroup;
  statusLabel: string;
  /** 缩略图（题干裁图）。 */
  thumb: string;
  /** 录入日 YYYY-MM-DD；旧数据可能为 null。 */
  intakeDay: string | null;
}

export interface NotebookGroup { key: 'today' | 'week' | 'earlier'; title: string; items: NotebookItem[] }

export interface NotebookResponse {
  subject: string;
  subjects: string[];
  grade: string;
  stages: string[];
  chapter: string;
  chapters: string[];
  status: NotebookStatusGroup | '';
  q: string;
  /** 这个学科和学段下的总数（不受章节 / 状态 / 搜索影响）。 */
  total: number;
  /** 当前筛选结果数。 */
  shown: number;
  todo: number;
  groups: NotebookGroup[];
  /** 还在找题的照片数：空状态时提示「AI 还在找题」。 */
  finding: number;
  /** 照片里还有没收进错题本的题（材料流程）。 */
  pendingIntake: number;
}

export interface ItemImage { url: string; fullUrl: string; title: string }
export interface ItemNote { kind: string; title: string; text: string }

export interface ItemDetailResponse {
  item: NotebookItem;
  questionText: string;
  badge: 'ok' | 'low';
  revision: number | null;
  images: ItemImage[];
  notes: ItemNote[];
  canDiscard: boolean;
  category: { grade: string; subject: string; chapter: string; stages: string[]; subjects: string[] };
  /** 材料流程的题：可以看整页材料与批改来源（旧页面）。 */
  materialUrl: string | null;
}

export interface DiscardResponse { removed: string[]; failed: { id: string; message: string }[] }

export interface SettingsResponse {
  grade: string;
  stages: string[];
  /** 邀请码网关下才有退出登录和我的邀请码。 */
  invitation: boolean;
  accountRole: string | null;
  accountRoleLabel: string | null;
  /** ISO 时间或 null：邀请码快到期提醒。 */
  inviteExpires: string | null;
  version: string;
}

export type IntakePhotoState = 'finding' | 'done' | 'needsPick' | 'failed' | 'unsupported';

export interface IntakeQuestion {
  /** 错题本里的题目 id（itm_…）。 */
  id: string;
  excerpt: string;
  chapter: string;
  thumb: string;
}

export interface IntakeCandidate {
  /** 识别出的候选题 id（旧流程为识别任务里的题 id，材料流程为 questionId:revision）。 */
  id: string;
  label: string;
  excerpt: string;
  /** 裁图；材料流程没有裁图时为 null。 */
  crop: string | null;
}

export interface IntakePhoto {
  id: string;
  number: number;
  takenAt: string;
  thumb: string;
  full: string;
  state: IntakePhotoState;
  statusText: string;
  /** 已经在错题本里的题。 */
  questions: IntakeQuestion[];
  /** 没有批改痕迹的页：等学生勾选的候选题。 */
  candidates: IntakeCandidate[];
  failure: { title: string; detail: string; retryable: boolean } | null;
}

export interface IntakeResponse {
  mode: 'legacy' | 'materials';
  /** 材料流程的草稿命名空间：上传时放在 x-draft-namespace 头里。 */
  draftNamespace: string | null;
  photos: IntakePhoto[];
  /** 还有照片在找题：客户端据此轮询。 */
  busy: boolean;
}
