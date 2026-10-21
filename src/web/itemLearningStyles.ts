/** Isolated styles for the learning detail; shared semantic colors remain in assets.ts. */
export const ITEM_LEARNING_STYLES = `
.item-learning .learning-photo{display:block;background:var(--surround);border-radius:var(--r-2);min-height:44px;min-width:44px;overflow:hidden;text-decoration:none}
.item-learning .learning-photo .hint{display:block;padding:8px 16px 12px;text-align:right}
.item-learning .learning-photo .crop{filter:none;margin:var(--s-4) 0}
.item-learning .learning-reflection{margin:var(--s-4) 0 0}
.item-learning .learning-reflection dt{font-size:var(--fs-2);color:var(--muted);margin-top:var(--s-3)}
.item-learning .learning-reflection dd{margin:0}
.item-learning .reflection-summary{font-size:var(--fs-4);line-height:var(--lh-text)}
.item-learning .learning-history{list-style:none;margin:var(--s-3) 0 0;padding:0}
.item-learning .learning-history .row{align-items:center}
.item-learning .learning-stack{margin:var(--s-4) 0}
.item-learning .learning-stack>section,.item-learning .learning-evidence,.item-learning .learning-management{padding:12px 16px}
.item-learning .learning-stack>*+*,.item-learning .disclosure+.disclosure{box-shadow:inset 0 1px 0 var(--line)}
.item-learning .stack-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px}
.item-learning .stack-label{margin:0;font-size:var(--fs-3);font-weight:600}
.item-learning .disclosure>summary{display:flex;align-items:center;gap:8px;list-style:none;min-height:44px;padding:8px 0;font-weight:600}
.item-learning .disclosure>summary::-webkit-details-marker{display:none}
.item-learning .disclosure>summary::before{content:"";width:7px;height:7px;flex:none;border-right:1.8px solid var(--muted);border-bottom:1.8px solid var(--muted);transform:rotate(-45deg)}
.item-learning .disclosure[open]>summary::before{transform:rotate(45deg)}
.item-learning .nav-disclosure>summary{justify-content:space-between}
.item-learning .nav-disclosure>summary::before{display:none}
.item-learning .disclosure-body{padding:0 0 8px 22px}
.item-learning .learning-management summary{min-width:44px}
.item-learning .learning-management .more{display:flex;align-items:center;min-height:44px;min-width:44px}
.item-learning .learning-management .link-btn{min-width:44px}
.item-learning .answer-text{min-width:0;margin:var(--s-3) 0 var(--s-4);line-height:1.9}
.item-learning .answer-text+.answer-text{padding-top:var(--s-3);border-top:1px solid var(--line)}
.item-learning .answer-part{margin-top:var(--s-5)}
.item-learning .answer-part:first-child{margin-top:0}
.item-learning .answer-part-label{font-size:var(--fs-3);line-height:var(--lh-tight);margin:0 0 var(--s-2);font-weight:650}
.item-learning .answer-case{display:flex;align-items:baseline;gap:var(--s-2);margin:var(--s-4) 0;padding-left:var(--s-3);border-left:2px solid var(--line)}
.item-learning .answer-case-label{flex:none;color:var(--accent);font-weight:600}
.item-learning .answer-content{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;text-wrap:pretty}
.item-learning .answer-result{margin:var(--s-4) 0;padding:var(--s-3);border-radius:var(--r-1);background:var(--paper)}
.item-learning .answer-math{display:inline-block;max-width:100%;overflow-x:auto;vertical-align:middle;padding:var(--s-1) 1px;white-space:normal;overflow-wrap:normal;text-wrap:nowrap}
.item-learning .answer-math math{font-size:1.1em;color:inherit}
.item-learning .answer-math-display{display:block;padding:var(--s-3) 0;margin:var(--s-2) 0}
.item-learning .answer-original{margin-top:var(--s-3);font-size:var(--fs-2);color:var(--muted)}
.item-learning .answer-original summary{font-weight:400}
.item-learning .answer-original pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink);margin:var(--s-2) 0}
.item-learning .answer-deduction{display:inline-block;padding:var(--s-1) var(--s-3);border-radius:var(--r-1);background:var(--paper);font-weight:600}
@media(min-width:800px){.item-learning main{max-width:720px}.item-learning .top{max-width:720px}}
`;
