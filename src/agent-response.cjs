// Decode only a complete JSON object. Never evaluate code or guess at repairs.
function parseAgentResponse(choice) {
  if (choice?.finish_reason !== 'stop')
    throw new Error('Model response was incomplete');
  const raw = choice.message?.content;
  if (typeof raw !== 'string' || !raw.trim())
    throw new Error('Model response was empty');
  if (raw.length > 150000) throw new Error('Model response was too large');
  let source = raw.trim();
  // Some models wrap JSON despite response_format. Only unwrap the entire reply.
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
  if (fence) source = fence[1].trim();
  let action;
  try {
    action = JSON.parse(source);
  } catch {
    throw new Error('Model returned invalid JSON');
  }
  if (!action || Array.isArray(action) || typeof action !== 'object')
    throw new Error('Model response must be one JSON action object');
  if (
    !['read', 'list', 'write', 'replace', 'delete', 'finish'].includes(
      action.action,
    )
  )
    throw new Error('Model response has an unknown action');
  return action;
}
module.exports = { parseAgentResponse };
