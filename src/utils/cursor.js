const CONTINUATION_KEYS = new Set([
  'continue', 'apcontinue', 'srcontinue', 'sroffset', 'cmcontinue',
  'accontinue', 'aicontinue', 'rvcontinue', 'blcontinue',
  'clcontinue', 'tlcontinue', 'imcontinue', 'plcontinue',
  'elcontinue', 'iicontinue', 'ppcontinue',
]);

export function encodeCursor(value) {
  if (!value || Object.keys(value).length === 0) return null;
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (!value) return {};
  if (typeof value !== 'string' || value.length > 8192) {
    throw new Error('Invalid continuation token');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid continuation token');
  }
  if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object') {
    throw new Error('Invalid continuation token');
  }
  for (const [key, item] of Object.entries(decoded)) {
    if (!CONTINUATION_KEYS.has(key) || !['string', 'number'].includes(typeof item)) {
      throw new Error('Invalid continuation token field');
    }
  }
  return decoded;
}
