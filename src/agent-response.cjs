// Decode only a complete JSON object. Never evaluate code or guess at repairs.
const { filePath } = require('./core.cjs');
function validateAction(action) {
  if (['read', 'list'].includes(action.action)) {
    if (
      action.offset !== undefined &&
      (!Number.isSafeInteger(action.offset) || action.offset < 0)
    )
      throw new Error('Read/list offset must be a non-negative integer');
  }
  if (action.action === 'read') {
    if (
      !Array.isArray(action.paths) ||
      action.paths.length < 1 ||
      action.paths.length > 5
    )
      throw new Error(
        'Read requires 1–5 file paths in a paths array; split larger reads into separate actions',
      );
    // Validate the whole batch before fetching any file.
    action.paths.forEach(filePath);
  }
  if (['write', 'replace', 'delete'].includes(action.action))
    filePath(action.path);
  if (
    action.action === 'write' &&
    (typeof action.content !== 'string' ||
      Buffer.byteLength(action.content) > 100000 ||
      action.content.includes('\0'))
  )
    throw new Error('Write requires UTF-8 text under 100 KB');
  if (
    action.action === 'replace' &&
    (typeof action.oldText !== 'string' ||
      !action.oldText ||
      typeof action.newText !== 'string')
  )
    throw new Error('Replace requires nonempty oldText and string newText');
  return action;
}
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
  return validateAction(action);
}
module.exports = { parseAgentResponse };
