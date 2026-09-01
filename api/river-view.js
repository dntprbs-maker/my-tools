const crypto = require('node:crypto');

const projectId = process.env.RIVER_VIEW_FIREBASE_PROJECT_ID || 'river-view-manager';
const databasePath = `projects/${projectId}/databases/(default)/documents`;
let tokenCache = { value: '', expiresAt: 0 };
let firebaseKeyCache = { keys: {}, expiresAt: 0 };
let driveTokenCache = { value: '', expiresAt: 0 };

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
const fromDocument = document => { const fields = Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, fromFirestoreValue(value)])); const id = document.name.split('/').pop(); return { ...fields, id: fields.id || id }; };

async function accessToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const serviceAccount = JSON.parse(process.env.RIVER_VIEW_SERVICE_ACCOUNT_JSON || '{}');
  if (!serviceAccount.client_email || !serviceAccount.private_key) throw new Error('Firestore service account is not configured');
  const now = Math.floor(Date.now() / 1000); const header = encode({ alg: 'RS256', typ: 'JWT' });
  const claim = encode({ iss: serviceAccount.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(serviceAccount.private_key, 'base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${signature}` }) });
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
  const data = await response.json(); tokenCache = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 }; return tokenCache.value;
}
async function firestore(path, options = {}) {
  const token = await accessToken(); const response = await fetch(`https://firestore.googleapis.com/v1/${path}`, { ...options, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error?.message || `Firestore request failed (${response.status})`); return data;
}
const allowedFields = ['id', 'receivedAt', 'content', 'memo', 'status', 'processContent', 'processDate', 'cost', 'vendor', 'createdAt', 'updatedAt', 'createdBy', 'assignedVendorId', 'customerId', 'photos'];
const cleanJob = job => Object.fromEntries(allowedFields.filter(field => job && job[field] !== undefined).map(field => [field, job[field]]));
class AuthError extends Error { constructor(statusCode, message) { super(message); this.statusCode = statusCode; } }
async function verifyFirebaseIdToken(token) {
  const parts = token.split('.'); if (parts.length !== 3) throw new AuthError(401, 'Invalid Firebase ID token');
  let header, payload; try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { throw new AuthError(401, 'Invalid Firebase ID token'); }
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` || !payload.sub || typeof payload.sub !== 'string') throw new AuthError(401, 'Invalid Firebase ID token claims');
  const now = Math.floor(Date.now() / 1000); if (!Number.isFinite(payload.exp) || payload.exp <= now || (payload.iat && payload.iat > now + 300)) throw new AuthError(401, 'Expired Firebase ID token');
  if (!header.kid || header.alg !== 'RS256') throw new AuthError(401, 'Invalid Firebase ID token header');
  if (!firebaseKeyCache.keys[header.kid] || firebaseKeyCache.expiresAt <= Date.now()) { const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'); if (!response.ok) throw new AuthError(401, 'Firebase public keys unavailable'); const keys = await response.json(); const match = /max-age=([0-9]+)/.exec(response.headers.get('cache-control') || ''); firebaseKeyCache = { keys, expiresAt: Date.now() + Number(match?.[1] || 3600) * 1000 }; }
  const certificate = firebaseKeyCache.keys[header.kid]; if (!certificate) throw new AuthError(401, 'Unknown Firebase ID token key');
  if (!crypto.createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(certificate, Buffer.from(parts[2], 'base64url'))) throw new AuthError(401, 'Invalid Firebase ID token signature'); return payload;
}
async function requireAllowedUser(req) { const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); if (!match) throw new AuthError(401, 'Authorization Bearer token is required'); const payload = await verifyFirebaseIdToken(match[1]); if (payload.email !== 'dntprbs@gmail.com' || payload.email_verified !== true) throw new AuthError(403, 'This Firebase user is not allowed'); return payload; }
async function driveAccessToken() {
  if (driveTokenCache.value && driveTokenCache.expiresAt > Date.now() + 60_000) return driveTokenCache.value;
  const clientId = process.env.RIVER_VIEW_DRIVE_CLIENT_ID; const clientSecret = process.env.RIVER_VIEW_DRIVE_CLIENT_SECRET; const refreshToken = process.env.RIVER_VIEW_DRIVE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Google Drive OAuth is not configured');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }) });
  const data = await response.json(); if (!response.ok || !data.access_token) throw new Error(data.error_description || 'Google Drive token request failed'); driveTokenCache = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 }; return driveTokenCache.value;
}
async function driveRequest(path, options = {}) { const url = path.startsWith('http') ? path : `https://www.googleapis.com/drive/v3/${path}`; const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${await driveAccessToken()}`, ...(options.headers || {}) } }); if (!response.ok) { const text = await response.text(); throw new Error(`Google Drive request failed (${response.status}): ${text.slice(0, 300)}`); } return response; }
const driveFolder = () => process.env.RIVER_VIEW_DRIVE_ROOT_FOLDER_ID;
async function driveCreateFolder(name, parent) { const response = await driveRequest('files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) }); return response.json(); }
async function getOrCreateFolder(name, parent) { const query = `'${parent}' in parents and name = '${name.replaceAll("'", "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`; const response = await driveRequest(`files?q=${encodeURIComponent(query)}&fields=files(id,name)`); const data = await response.json(); return data.files?.[0] || driveCreateFolder(name, parent); }
async function uploadPhoto(file, recordId, category) { const root = driveFolder(); if (!root) throw new Error('Google Drive root folder is not configured'); const jobFolder = await getOrCreateFolder(recordId, root); const categoryNames = { before: '작업전', during: '작업중', after: '작업후' }; const categoryFolder = await getOrCreateFolder(categoryNames[category] || '작업후', jobFolder.id); const boundary = `----RiverView${crypto.randomBytes(8).toString('hex')}`; const metadata = JSON.stringify({ name: file.name, mimeType: file.mimeType, parents: [categoryFolder.id] }); const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`), Buffer.from(file.data, 'base64'), Buffer.from(`\r\n--${boundary}--`) ]); const response = await driveRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,createdTime,parents,webViewLink'.replace('https://www.googleapis.com/',''), { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) }, body }); return { ...(await response.json()), folderId: categoryFolder.id, folderName: categoryNames[category] || '작업후' }; }
async function deleteDriveFile(fileId) { await driveRequest(`files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }); }

module.exports = async (req, res) => {
  try {
    await requireAllowedUser(req);
    const collection = `${databasePath}/riverViewJobs`;
    const query = req.query || {};
    if (req.method === 'GET' && query.action === 'photo' && query.fileId) { const response = await driveRequest(`files/${encodeURIComponent(query.fileId)}?alt=media`); res.status(200).setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream'); res.end(Buffer.from(await response.arrayBuffer())); return; }
    if (req.method === 'GET') { const data = await firestore(collection); return json(res, 200, { jobs: (data.documents || []).map(fromDocument).map(job => ({ ...job, photos: typeof job.photos === 'string' ? JSON.parse(job.photos || '[]') : (job.photos || []) })) }); }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (req.method === 'POST' && body.action === 'create') { const id = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; const now = new Date().toISOString(); const job = { ...cleanJob(body.job), id, status: body.job?.status || '신규', photos: '[]', createdAt: now, updatedAt: now }; const data = await firestore(`${collection}?documentId=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(toDocument(job)) }); return json(res, 201, { job: { ...fromDocument(data), photos: [] } }); }
    if (req.method === 'POST' && body.action === 'upload-photo') { const file = body.file || {}; if (!body.recordId || !file.name || !file.mimeType || !file.data || !String(file.mimeType).startsWith('image/')) return json(res, 400, { error: 'Valid image file is required' }); if (String(file.data).length > 12_000_000) return json(res, 413, { error: 'Image file is too large' }); const drive = await uploadPhoto(file, body.recordId, body.category); const doc = await firestore(`${collection}/${encodeURIComponent(body.recordId)}`); const job = fromDocument(doc); const photos = typeof job.photos === 'string' ? JSON.parse(job.photos || '[]') : (job.photos || []); const photo = { id: `photo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, recordId: body.recordId, category: body.category || 'after', name: drive.name, mimeType: drive.mimeType, createdAt: drive.createdTime || new Date().toISOString(), driveFileId: drive.id, driveUrl: `/api/river-view?action=photo&fileId=${encodeURIComponent(drive.id)}`, folderId: drive.folderId }; photos.push(photo); const updated = { photos: JSON.stringify(photos), updatedAt: new Date().toISOString() }; try { const saved = await firestore(`${collection}/${encodeURIComponent(body.recordId)}?updateMask.fieldPaths=photos&updateMask.fieldPaths=updatedAt`, { method: 'PATCH', body: JSON.stringify(toDocument(updated)) }); return json(res, 201, { photo, job: { ...fromDocument(saved), photos } }); } catch (error) { try { await deleteDriveFile(drive.id); } catch {} throw error; } }
    if (req.method === 'DELETE' && body.action === 'delete-photo' && body.recordId && body.photoId) { const doc = await firestore(`${collection}/${encodeURIComponent(body.recordId)}`); const job = fromDocument(doc); const photos = typeof job.photos === 'string' ? JSON.parse(job.photos || '[]') : (job.photos || []); const photo = photos.find(item => item.id === body.photoId); if (!photo) return json(res, 404, { error: 'Photo metadata not found' }); await deleteDriveFile(photo.driveFileId); const remaining = photos.filter(item => item.id !== body.photoId); const saved = await firestore(`${collection}/${encodeURIComponent(body.recordId)}?updateMask.fieldPaths=photos&updateMask.fieldPaths=updatedAt`, { method: 'PATCH', body: JSON.stringify(toDocument({ photos: JSON.stringify(remaining), updatedAt: new Date().toISOString() })) }); return json(res, 200, { photoId: body.photoId, job: { ...fromDocument(saved), photos: remaining } }); }
    if (req.method === 'DELETE' && body.action === 'delete-job' && body.id) { const doc = await firestore(`${collection}/${encodeURIComponent(body.id)}`); const job = fromDocument(doc); const photos = typeof job.photos === 'string' ? JSON.parse(job.photos || '[]') : (job.photos || []); for (const photo of photos) { if (photo.driveFileId) { try { await deleteDriveFile(photo.driveFileId); } catch {} } } await firestore(`${collection}/${encodeURIComponent(body.id)}`, { method: 'DELETE' }); return json(res, 200, { deleted: body.id, deletedPhotos: photos.length }); }
    if (req.method === 'PATCH' && body.action === 'update' && body.id) { const updates = { ...cleanJob(body.data), id: body.id, updatedAt: new Date().toISOString() }; const mask = Object.keys(updates).map(field => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&'); const data = await firestore(`${collection}/${encodeURIComponent(body.id)}?${mask}`, { method: 'PATCH', body: JSON.stringify(toDocument(updates)) }); return json(res, 200, { job: { ...fromDocument(data), photos: typeof fromDocument(data).photos === 'string' ? JSON.parse(fromDocument(data).photos || '[]') : (fromDocument(data).photos || []) } }); }
    if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
    return json(res, 400, { error: 'Invalid request' });
  } catch (error) { return json(res, error.statusCode || 500, { error: error.message || 'Server error' }); }
};
