export const CHECKLIST_CEILINGS = Object.freeze({ records: 80, json_bytes: 2 * 1024 * 1024,
  transfer_bytes: 64 * 1024 * 1024, operations: 2000, repo_tokens: 4, management_calls: 40,
  app_requests: 3, app_operations: 32, app_response_bytes: 64 * 1024, request_bytes: 256 * 1024, response_bytes: 256 * 1024,
  run_ms: 30 * 60 * 1000, cleanup_ms: 2 * 60 * 1000, stage_batches: 2 });
export type AppPins = { release_ref: string; realization_ref: string; module_sha256: string; output_tree: string; input_sha256: string };
