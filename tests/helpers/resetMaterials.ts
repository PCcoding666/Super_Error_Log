import type { DatabaseSync } from 'node:sqlite';
/** Legacy fixtures now create material mappings during the same bridge transaction.
 * Delete their children first; retain production FK enforcement throughout test cleanup. */
export function resetMaterials(db:DatabaseSync):void {
 for(const table of ['material_inclusion_event','material_inclusion','material_answer_origin','material_answer_operation','material_answer_selection','material_action_batch','material_answer_import','material_item_link','material_legacy_map','material_job','material_grade','material_answer','material_link_event','material_fragment','material_attempt','material_question','material_asset','material_document','material_capture','material_workspace'])db.prepare(`DELETE FROM ${table}`).run();
}
