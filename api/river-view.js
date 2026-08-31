const crypto = require('node:crypto');

const projectId = process.env.RIVER_VIEW_FIREBASE_PROJECT_ID || 'river-view-manager';
const databasePath = `projects/${projectId}/databases/(default)/documents`;
let tokenCache = { value: '', expiresAt: 0 };

const json = (res, status, body) => { res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const asFirestoreValue = value => {
  if (value === null || value === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  return { stringValue: String(value) };
};
const fromFirestoreValue = value => {
  if (!value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  return value;
};
const toDocument = data => ({ fields: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined).map(([key, value]) => [key, asFirestoreValue(value)])) });
const fromDocument = document => {
  const fields = Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, fromFirestoreValue(value)]));
  const id = document.name.split('/').pop();
  return { ...fields, id: fields.id || id };
};

async function accessToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const serviceAccount = JSON.parse(process.env.RIVER_VIEW_SERVICE_ACCOUNT_JSON || '{}');
  if (!serviceAccount.client_email || !serviceAccount.private_key) throw new Error('Firestore service account is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const claim = encode({ iss: serviceAccount.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(serviceAccount.private_key, 'base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${signature}` }) });
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
  const data = await response.json(); tokenCache = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 }; return tokenCache.value;
}
async function firestore(path, options = {}) {
  const token = await accessToken(); const response = await fetch(`https://firestore.googleapis.com/v1/${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (error) { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error?.message || `Firestore request failed (${response.status})`);
  return data;
}
const allowedFields = ['id', 'receivedAt', 'content', 'memo', 'status', 'processContent', 'processDate', 'cost', 'vendor', 'createdAt', 'updatedAt', 'createdBy', 'assignedVendorId', 'customerId'];
const cleanJob = job => Object.fromEntries(allowedFields.filter(field => job && job[field] !== undefined).map(field => [field, job[field]]));

module.exports = async (req, res) => {
  try {
    const collection = `${databasePath}/riverViewJobs`;
    if (req.method === 'GET') {
      const data = await firestore(collection); return json(res, 200, { jobs: (data.documents || []).map(fromDocument) });
    }
    if (req.method !== 'POST' && req.method !== 'PATCH') return json(res, 405, { error: 'Method not allowed' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (req.method === 'POST' && body.action === 'create') {
      const id = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const now = new Date().toISOString(); const job = { ...cleanJob(body.job), id, status: body.job?.status || '신규', createdAt: now, updatedAt: now };
      const data = await firestore(`${collection}?documentId=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(toDocument(job)) }); return json(res, 201, { job: fromDocument(data) });
    }
    if (req.method === 'PATCH' && body.action === 'update' && body.id) {
      const updates = { ...cleanJob(body.data), id: body.id, updatedAt: new Date().toISOString() };
      const mask = Object.keys(updates).map(field => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&');
      const data = await firestore(`${collection}/${encodeURIComponent(body.id)}?${mask}`, { method: 'PATCH', body: JSON.stringify(toDocument(updates)) }); return json(res, 200, { job: fromDocument(data) });
    }
    return json(res, 400, { error: 'Invalid request' });
  } catch (error) { return json(res, 500, { error: error.message || 'Server error' }); }
};
