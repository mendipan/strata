/** Present creation effects for this call, leaving the retained response intact.
 * Replay is established by the broker after its authorization/freshness gates;
 * a result-level `data.reused` flag does not establish a cached operation. */
export function presentOperationEffects<T extends { reused?: boolean; created?: string[] }>(response: T): T {
  return response.reused === true ? { ...response, created: [] } : response;
}
