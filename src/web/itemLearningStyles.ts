/** Isolated styles for the learning detail; shared semantic colors remain in assets.ts. */
export const ITEM_LEARNING_STYLES = `
.item-learning .learning-photo{background:#fff;border-radius:var(--r-1);min-height:44px;min-width:44px}
.item-learning .learning-photo .crop{filter:none;margin:var(--s-4) 0}
.item-learning .learning-reflection{margin:var(--s-4) 0 0}
.item-learning .learning-reflection dt{font-size:var(--fs-2);color:var(--muted);margin-top:var(--s-3)}
.item-learning .learning-reflection dd{margin:0}
.item-learning .reflection-summary{font-size:var(--fs-4);line-height:var(--lh-text)}
.item-learning .learning-history{list-style:none;margin:var(--s-3) 0 0;padding:0}
.item-learning .learning-history .row{align-items:center}
.item-learning .learning-evidence details+details{border-top:1px solid var(--line);padding-top:var(--s-2)}
.item-learning .learning-management summary{min-width:44px}
.item-learning .learning-management .more{display:flex;align-items:center;min-height:44px;min-width:44px}
.item-learning .learning-management .link-btn{min-width:44px}
@media(min-width:800px){.item-learning main{max-width:720px}.item-learning .top{max-width:720px}}
`;
