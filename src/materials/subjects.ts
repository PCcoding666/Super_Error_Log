import { SUBJECTS } from '../domain/types.js';

/** Subjects outside the trial scope (数学/物理/化学). Only clearly named other subjects count; unknown stays supported. */
const OTHER_SUBJECTS:[RegExp,string][]=[[/语文|chinese/i,'语文'],[/英语|english/i,'英语'],[/生物|biology/i,'生物'],[/历史|history/i,'历史'],[/政治|道德与法治|道法|思想品德|politic/i,'政治'],[/地理|geograph/i,'地理'],[/日语|俄语|法语|德语|japanese|russian|french|german/i,'外语'],[/信息技术|通用技术|音乐|美术|体育/i,'其他学科']];
export function unsupportedSubject(subject:string|null|undefined):string|null {
 const text=subject?.trim();if(!text)return null;
 if(SUBJECTS.some(s=>text.includes(s))||/math|physic|chemi/i.test(text))return null;
 return OTHER_SUBJECTS.find(([pattern])=>pattern.test(text))?.[1]??null;
}
export const UNSUPPORTED_SUBJECT_MESSAGE='目前只支持数学、物理、化学。';
