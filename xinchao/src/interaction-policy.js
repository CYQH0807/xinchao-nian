// Interaction types that a client may report without partner-provided exchange evidence.
export const SELF_REPORT_TYPES = new Set(['sharing', 'reflection', 'task_progress', 'discovery']);

// Return a rejected relationship type and clear it when MCP exchange evidence is missing.
export function gateMcpSelfReport(event, enabled = true) {
  const declared = String(event?.interactionType ?? event?.interaction_type ?? '').trim().toLowerCase();
  if (!enabled || !declared || SELF_REPORT_TYPES.has(declared) || String(event?.exchange ?? '').trim()) return null;
  if (event && typeof event === 'object') {
    event.interactionType = '';
    delete event.interaction_type;
  }
  return declared;
}
