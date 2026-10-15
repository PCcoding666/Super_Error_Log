import { getDb } from '../db/connection.js';

export interface WeakTag {
  tag: string;
  subject: string | null;
  count: number;
  causes: string[];
}

export interface RecurrenceAlert {
  kind: 'tag' | 'cause';
  name: string;
  count: number;
}

/** 薄弱知识点：按未归档题目中出现频次聚合 */
export function weakTags(studentId: string, limit = 10): WeakTag[] {
  const rows = getDb()
    .prepare(
      `SELECT je.value AS tag, ei.subject, COUNT(*) AS n
       FROM error_item ei, json_each(ei.knowledge_tags) je
       WHERE ei.student_id = ? AND ei.status != 'archived_not_worth_review'
       GROUP BY je.value ORDER BY n DESC LIMIT ?`,
    )
    .all(studentId, limit) as Array<{ tag: string; subject: string | null; n: number }>;

  return rows.map((r) => {
    const causes = getDb()
      .prepare(
        `SELECT DISTINCT d.cause FROM error_diagnosis d
         JOIN error_item ei ON ei.id = d.item_id
         WHERE ei.student_id = ? AND ei.knowledge_tags LIKE ?`,
      )
      .all(studentId, `%"${r.tag}"%`) as Array<{ cause: string }>;
    return { tag: r.tag, subject: r.subject, count: r.n, causes: causes.map((c) => c.cause) };
  });
}

/** 错误模式复发：同知识点或同错因出现 ≥2 次 */
export function recurrenceAlerts(studentId: string): RecurrenceAlert[] {
  const db = getDb();
  const tagRows = db
    .prepare(
      `SELECT je.value AS name, COUNT(*) AS n
       FROM error_item ei, json_each(ei.knowledge_tags) je
       WHERE ei.student_id = ? AND ei.status != 'archived_not_worth_review'
       GROUP BY je.value HAVING n >= 2 ORDER BY n DESC`,
    )
    .all(studentId) as Array<{ name: string; n: number }>;
  const causeRows = db
    .prepare(
      `SELECT d.cause AS name, COUNT(*) AS n
       FROM error_diagnosis d JOIN error_item ei ON ei.id = d.item_id
       WHERE ei.student_id = ? AND ei.status != 'archived_not_worth_review'
       GROUP BY d.cause HAVING n >= 2 ORDER BY n DESC`,
    )
    .all(studentId) as Array<{ name: string; n: number }>;
  return [
    ...tagRows.map((r) => ({ kind: 'tag' as const, name: r.name, count: r.n })),
    ...causeRows.map((r) => ({ kind: 'cause' as const, name: r.name, count: r.n })),
  ];
}

export function masteryTrend(studentId: string): Array<{ status: string; n: number }> {
  return getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM error_item WHERE student_id = ? GROUP BY status')
    .all(studentId) as Array<{ status: string; n: number }>;
}

export interface ParentAggregate {
  weeklyCompletion: Array<{ week: string; total: number; attempted: number }>;
  subjectMastery: Array<{ subject: string; mastered: number; total: number }>;
  topWeakTags: Array<{ tag: string; count: number }>;
}

/** 家长聚合视图：只输出聚合数字与标签名，不含题目原文/反思/图片 */
export function parentAggregate(studentId: string): ParentAggregate {
  const db = getDb();
  const weeklyCompletion = db
    .prepare(
      `SELECT rp.week, COUNT(DISTINCT rpi.item_id) AS total,
              COUNT(DISTINCT ra.item_id) AS attempted
       FROM review_packet rp
       JOIN review_packet_item rpi ON rpi.packet_id = rp.id
       LEFT JOIN review_attempt ra ON ra.packet_id = rp.id AND ra.item_id = rpi.item_id
       WHERE rp.student_id = ?
       GROUP BY rp.week ORDER BY rp.week`,
    )
    .all(studentId) as Array<{ week: string; total: number; attempted: number }>;

  const subjectMastery = db
    .prepare(
      `SELECT subject, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('temporarily_mastered','stably_mastered') THEN 1 ELSE 0 END) AS mastered
       FROM error_item
       WHERE student_id = ? AND status != 'archived_not_worth_review' AND subject IS NOT NULL
       GROUP BY subject`,
    )
    .all(studentId) as Array<{ subject: string; total: number; mastered: number }>;

  const topWeakTags = db
    .prepare(
      `SELECT je.value AS tag, COUNT(*) AS count
       FROM error_item ei, json_each(ei.knowledge_tags) je
       WHERE ei.student_id = ? AND ei.status != 'archived_not_worth_review'
       GROUP BY je.value ORDER BY count DESC LIMIT 5`,
    )
    .all(studentId) as Array<{ tag: string; count: number }>;

  return { weeklyCompletion, subjectMastery, topWeakTags };
}
