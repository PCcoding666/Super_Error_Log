import type { ReactNode } from 'react';
import { stemBlocks } from '../../../src/text/stemBlocks';

/** 题干：普通文字保留换行，GFM 表格画成真表格（窄屏可横向滑动）。 */
export function StemText(props: { text: string }): ReactNode {
  return <>{stemBlocks(props.text).map((block, index) => block.kind === 'text'
    ? <div key={index} className="stem-text">{block.text}</div>
    : <div key={index} className="stem-table-wrap">
      <table className="stem-table">
        <thead><tr>{block.head.map((cell, column) => <th key={column} style={block.align[column] ? { textAlign: block.align[column] } : undefined}>{cell}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={block.align[column] ? { textAlign: block.align[column] } : undefined}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>)}</>;
}
