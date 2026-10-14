const crypto = require('node:crypto');

const projectId = process.env.RIVER_VIEW_FIREBASE_PROJECT_ID || 'river-view-manager';
const databasePath = `projects/${projectId}/databases/(default)/documents`;
const masterEmail = 'dntprbs@gmail.com';
// AI 시험 열쇠의 기본 지문(SHA-256). 원본 열쇠는 코드디 PC에만 있음. 마스터가 재발급하면 riverViewConfig/aiTestKey가 우선함
const defaultTestKeyHash = process.env.RIVER_VIEW_TEST_KEY_HASH || '9638cf2bf5a14535e3a45cf36cf5c2c43c68f5e68ce4bfc3cbc7b78204f9561a';
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
const sha256Hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const constantTimeEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

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
  if (!response.ok) { const error = new Error(data.error?.message || `Firestore request failed (${response.status})`); error.status = response.status; throw error; } return data;
}
async function getDocOrNull(path) { try { return await firestore(path); } catch (error) { if (error.status === 404 || /not found|NOT_FOUND|does not exist/i.test(error.message || '')) return null; throw error; } }
const allowedFields = ['id', 'receivedAt', 'content', 'memo', 'status', 'processContent', 'processDate', 'cost', 'vendor', 'createdAt', 'updatedAt', 'createdBy', 'assignedVendorId', 'customerId', 'photos', 'isTest'];
const cleanJob = job => Object.fromEntries(allowedFields.filter(field => job && job[field] !== undefined).map(field => [field, job[field]]));
const parsePhotos = job => (typeof job.photos === 'string' ? JSON.parse(job.photos || '[]') : (job.photos || []));
const withPhotos = job => ({ ...job, photos: parsePhotos(job) });
const stripCost = job => { const copy = { ...job }; delete copy.cost; return copy; };
const isTestJob = job => job && String(job.isTest) === 'true';
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
async function resolveSession(req) {
  const testKey = req.headers['x-river-view-test-key'];
  if (testKey) { const configured = await getDocOrNull(`${databasePath}/riverViewConfig/aiTestKey`); let valid; if (configured) { const doc = fromDocument(configured); if (doc.disabled === 'true') throw new AuthError(403, 'AI 시험 열쇠가 꺼져 있습니다'); valid = typeof doc.hash === 'string' && doc.hash.length > 0 && constantTimeEqual(sha256Hex(testKey), doc.hash); } else { valid = constantTimeEqual(sha256Hex(testKey), defaultTestKeyHash); } if (!valid) throw new AuthError(401, 'AI 시험 열쇠가 올바르지 않습니다'); return { uid: 'ai-tester', email: 'ai-tester@river-view.local', role: 'master', status: 'approved', vendorName: '', isTest: true, viewAs: '', realUid: 'ai-tester' }; }
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); if (!match) throw new AuthError(401, 'Authorization Bearer token is required');
  const payload = await verifyFirebaseIdToken(match[1]); if (payload.email_verified !== true) throw new AuthError(403, 'Google 이메일 인증이 필요합니다');
  const session = { uid: payload.sub, email: payload.email || '', role: '', status: 'none', vendorName: '', isTest: false, viewAs: '', realUid: payload.sub };
  if (payload.email === masterEmail) { session.role = 'master'; session.status = 'approved'; } else { const userDoc = await getDocOrNull(`${databasePath}/riverViewUsers/${encodeURIComponent(payload.sub)}`); if (userDoc) { const user = fromDocument(userDoc); session.role = user.role || ''; session.status = user.status || 'none'; session.vendorName = user.vendorName || ''; } }
  if (session.role === 'master') { const viewAs = req.headers['x-river-view-view-as']; const viewAsVendor = req.headers['x-river-view-view-as-vendor']; if (viewAs === 'company' || viewAs === 'riverview' || viewAs === 'vendor') { session.viewAs = viewAs; session.role = viewAs; if (viewAs === 'vendor' && viewAsVendor) { session.realUid = session.uid; session.uid = viewAsVendor; } } }
  return session;
}
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
async function uploadPhoto(file, recordId, category) { const root = driveFolder(); if (!root) throw new Error('Google Drive root folder is not configured'); const jobFolder = await getOrCreateFolder(recordId, root); const categoryNames = { before: '작업전', during: '작업중', after: '작업후' }; const categoryFolder = await getOrCreateFolder(categoryNames[category] || '작업후', jobFolder.id); const boundary = `----RiverView${crypto.randomBytes(8).toString('hex')}`; const metadata = JSON.stringify({ name: file.name, mimeType: file.mimeType, parents: [categoryFolder.id] }); const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`), Buffer.from(file.data, 'base64'), Buffer.from(`\r\n--${boundary}--`) ]); const response = await driveRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,createdTime,parents,webViewLink', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) }, body }); return { ...(await response.json()), folderId: categoryFolder.id, folderName: categoryNames[category] || '작업후' }; }
async function deleteDriveFile(fileId) { await driveRequest(`files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }); }

module.exports = async (req, res) => {
  try {
    const session = await resolveSession(req);
    const collection = `${databasePath}/riverViewJobs`;
    const usersCollection = `${databasePath}/riverViewUsers`;
    const configPath = `${databasePath}/riverViewConfig/aiTestKey`;
    const query = req.query || {};
    const isGet = req.method === 'GET';
    const body = isGet ? {} : (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
    const action = isGet ? query.action : body.action;
    const isMaster = session.role === 'master'; const isCompany = session.role === 'company'; const isRiverview = session.role === 'riverview'; const isVendor = session.role === 'vendor';
    const canManage = isMaster || isCompany; const testSession = session.isTest === true;
    const requireApproved = () => { if (session.status !== 'approved') { const error = new AuthError(403, '승인된 계정이 아닙니다.'); error.body = { status: session.status }; throw error; } };
    const canSeeJob = job => testSession ? isTestJob(job) : !isTestJob(job);
    const vendorView = job => isVendor ? stripCost(job) : job;

    if (action === 'me') { const userDoc = testSession ? null : await getDocOrNull(`${usersCollection}/${encodeURIComponent(session.uid)}`); const user = userDoc ? fromDocument(userDoc) : {}; return json(res, 200, { uid: session.uid, email: session.email, role: session.role, status: session.status, vendorName: session.vendorName || user.vendorName || '', isTest: testSession, name: user.name || '', org: user.org || '', phone: user.phone || '' }); }

    if (action === 'request-access') {
      if (testSession) return json(res, 400, { error: 'AI 시험 계정은 접속 신청을 할 수 없습니다.' });
      if (isMaster) return json(res, 400, { error: '마스터 계정은 접속 신청이 필요하지 않습니다.' });
      const name = String(body.name || '').trim(); const org = String(body.org || '').trim(); const phone = String(body.phone || '').trim();
      if (!name || !org) return json(res, 400, { error: '이름과 소속을 입력해 주세요.' });
      const userPath = `${usersCollection}/${encodeURIComponent(session.uid)}`;
      const existingDoc = await getDocOrNull(userPath); const existing = existingDoc ? fromDocument(existingDoc) : null;
      if (existing && (existing.status === 'approved' || existing.status === 'suspended')) return json(res, 409, { error: '이미 승인되었거나 중지된 계정입니다.' });
      const now = new Date().toISOString();
      const record = { uid: session.uid, email: session.email, name, org, phone, role: '', status: 'pending', vendorName: '', createdAt: (existing && existing.createdAt) || now, updatedAt: now, decidedBy: '', decidedAt: '' };
      const saved = await firestore(userPath, { method: 'PATCH', body: JSON.stringify(toDocument(record)) });
      return json(res, 200, { user: fromDocument(saved) });
    }

    requireApproved();

    if (isGet && action === 'photo') { const fileId = query.fileId; const recordId = query.recordId; if (!fileId || !recordId) return json(res, 400, { error: 'fileId와 recordId가 필요합니다.' }); const doc = await getDocOrNull(`${collection}/${encodeURIComponent(recordId)}`); if (!doc) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); const job = fromDocument(doc); if (!canSeeJob(job)) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); if (isVendor && job.assignedVendorId !== session.uid) return json(res, 403, { error: '권한이 없습니다.' }); if (!parsePhotos(job).some(photo => photo.driveFileId === fileId)) return json(res, 404, { error: '사진을 찾을 수 없습니다.' }); const response = await driveRequest(`files/${encodeURIComponent(fileId)}?alt=media`); res.status(200).setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream'); res.end(Buffer.from(await response.arrayBuffer())); return; }

    if (isGet && action === 'users') { if (!canManage) return json(res, 403, { error: '권한이 없습니다.' }); const data = await firestore(usersCollection); const users = (data.documents || []).map(fromDocument).filter(user => (String(user.isTest) === 'true') === testSession); users.sort((a, b) => { const left = a.status === 'pending' ? 0 : 1; const right = b.status === 'pending' ? 0 : 1; return left !== right ? left - right : String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }); return json(res, 200, { users }); }

    if (isGet && action === 'vendors') { if (!canManage) return json(res, 403, { error: '권한이 없습니다.' }); const data = await firestore(usersCollection); const vendors = (data.documents || []).map(fromDocument).filter(user => (String(user.isTest) === 'true') === testSession).filter(user => user.role === 'vendor' && user.status === 'approved').map(user => ({ uid: user.uid || user.id, vendorName: user.vendorName || '', name: user.name || '' })); return json(res, 200, { vendors }); }

    if (isGet && action === 'ai-key') { if (!isMaster || testSession) return json(res, 403, { error: '권한이 없습니다.' }); const doc = await getDocOrNull(configPath); const config = doc ? fromDocument(doc) : null; return json(res, 200, { configured: !!config, disabled: config ? config.disabled === 'true' : false, updatedAt: config ? (config.updatedAt || '') : '' }); }

    if (isGet) { const data = await firestore(collection); let jobs = (data.documents || []).map(fromDocument).filter(canSeeJob).map(withPhotos); if (isVendor) jobs = jobs.filter(job => job.assignedVendorId === session.uid).map(stripCost); return json(res, 200, { jobs }); }

    if (action === 'test-create-user') { if (!testSession) return json(res, 403, { error: 'AI 시험 모드에서만 쓸 수 있습니다.' }); const uid = `test-${crypto.randomBytes(6).toString('hex')}`; const now = new Date().toISOString(); const record = { uid, email: `${uid}@river-view.local`, name: String(body.name || '시험 신청자'), org: String(body.org || '시험 소속'), phone: String(body.phone || ''), role: '', status: 'pending', vendorName: '', isTest: 'true', createdAt: now, updatedAt: now, decidedBy: '', decidedAt: '' }; const saved = await firestore(`${usersCollection}?documentId=${encodeURIComponent(uid)}`, { method: 'POST', body: JSON.stringify(toDocument(record)) }); return json(res, 201, { user: fromDocument(saved) }); }
    if (action === 'test-delete-user') { if (!testSession) return json(res, 403, { error: 'AI 시험 모드에서만 쓸 수 있습니다.' }); const uid = String(body.uid || ''); if (!uid.startsWith('test-')) return json(res, 400, { error: '시험 사용자만 지울 수 있습니다.' }); await firestore(`${usersCollection}/${encodeURIComponent(uid)}`, { method: 'DELETE' }); return json(res, 200, { uid }); }
    if (action === 'set-user') {
      if (!canManage) return json(res, 403, { error: '권한이 없습니다.' });
      const targetUid = String(body.uid || ''); const status = String(body.status || '');
      const hasRole = body.role !== undefined; const role = hasRole ? String(body.role || '') : undefined;
      const hasVendorName = body.vendorName !== undefined; const vendorName = hasVendorName ? String(body.vendorName || '').trim() : undefined;
      if (!targetUid) return json(res, 400, { error: '대상 사용자가 필요합니다.' });
      if (!['approved', 'rejected', 'suspended', 'pending'].includes(status)) return json(res, 400, { error: '상태 값이 올바르지 않습니다.' });
      if (hasRole && !['company', 'riverview', 'vendor', ''].includes(role)) return json(res, 400, { error: '역할 값이 올바르지 않습니다.' });
      if (targetUid === 'ai-tester') return json(res, 400, { error: '변경할 수 없는 계정입니다.' });
      const userPath = `${usersCollection}/${encodeURIComponent(targetUid)}`;
      const doc = await getDocOrNull(userPath); if (!doc) return json(res, 404, { error: '사용자를 찾을 수 없습니다.' });
      const existing = fromDocument(doc);
      if ((String(existing.isTest) === 'true') !== testSession) return json(res, 404, { error: '사용자를 찾을 수 없습니다.' });
      if (existing.email === masterEmail) return json(res, 400, { error: '변경할 수 없는 계정입니다.' });
      if (isCompany) { if (!['', 'riverview', 'vendor'].includes(existing.role || '')) return json(res, 403, { error: '권한이 없습니다.' }); if (hasRole && !['riverview', 'vendor'].includes(role)) return json(res, 403, { error: '권한이 없습니다.' }); }
      const nextRole = hasRole ? role : (existing.role || ''); const nextVendorName = hasVendorName ? vendorName : (existing.vendorName || '');
      if (status === 'approved' && !nextRole) return json(res, 400, { error: '승인하려면 역할을 지정해야 합니다.' });
      if (nextRole === 'vendor' && !nextVendorName) return json(res, 400, { error: '외주업체는 업체명이 필요합니다.' });
      const now = new Date().toISOString();
      const updates = { status, updatedAt: now, decidedBy: session.email, decidedAt: now };
      if (hasRole) updates.role = role;
      if (nextRole === 'vendor') updates.vendorName = nextVendorName; else if (hasVendorName) updates.vendorName = vendorName;
      const mask = Object.keys(updates).map(field => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&');
      const saved = await firestore(`${userPath}?${mask}`, { method: 'PATCH', body: JSON.stringify(toDocument(updates)) });
      return json(res, 200, { user: fromDocument(saved) });
    }

    if (action === 'ai-key-rotate') { if (!isMaster || testSession) return json(res, 403, { error: '권한이 없습니다.' }); const key = crypto.randomBytes(32).toString('base64url'); const now = new Date().toISOString(); await firestore(configPath, { method: 'PATCH', body: JSON.stringify(toDocument({ hash: sha256Hex(key), disabled: 'false', updatedAt: now })) }); return json(res, 200, { key }); }

    if (action === 'ai-key-toggle') { if (!isMaster || testSession) return json(res, 403, { error: '권한이 없습니다.' }); const disabled = (body.disabled === true || body.disabled === 'true') ? 'true' : 'false'; const doc = await getDocOrNull(configPath); const now = new Date().toISOString(); if (doc) { await firestore(`${configPath}?updateMask.fieldPaths=disabled&updateMask.fieldPaths=updatedAt`, { method: 'PATCH', body: JSON.stringify(toDocument({ disabled, updatedAt: now })) }); } else { await firestore(configPath, { method: 'PATCH', body: JSON.stringify(toDocument({ hash: defaultTestKeyHash, disabled, updatedAt: now })) }); } return json(res, 200, { disabled: disabled === 'true' }); }

    if (action === 'create') { if (isVendor) return json(res, 403, { error: '접수 등록 권한이 없습니다.' }); const id = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; const now = new Date().toISOString(); const job = { ...cleanJob(body.job), id, status: body.job?.status || '신규', photos: '[]', isTest: testSession ? 'true' : 'false', createdAt: now, updatedAt: now, createdBy: session.email }; const data = await firestore(`${collection}?documentId=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(toDocument(job)) }); return json(res, 201, { job: { ...fromDocument(data), photos: [] } }); }

    if (action === 'upload-photo') {
      if (isRiverview) return json(res, 403, { error: '권한이 없습니다.' });
      const file = body.file || {}; if (!body.recordId || !file.name || !file.mimeType || !file.data || !String(file.mimeType).startsWith('image/')) return json(res, 400, { error: 'Valid image file is required' }); if (String(file.data).length > 12_000_000) return json(res, 413, { error: 'Image file is too large' });
      const doc = await getDocOrNull(`${collection}/${encodeURIComponent(body.recordId)}`); if (!doc) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); const job = fromDocument(doc); if (!canSeeJob(job)) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); if (isVendor && job.assignedVendorId !== session.uid) return json(res, 403, { error: '권한이 없습니다.' });
      const drive = await uploadPhoto(file, body.recordId, body.category);
      const photos = parsePhotos(job); const photo = { id: `photo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, recordId: body.recordId, category: body.category || 'after', name: drive.name, mimeType: drive.mimeType, createdAt: drive.createdTime || new Date().toISOString(), driveFileId: drive.id, driveUrl: `/api/river-view?action=photo&fileId=${encodeURIComponent(drive.id)}&recordId=${encodeURIComponent(body.recordId)}`, folderId: drive.folderId }; photos.push(photo);
      const updated = { photos: JSON.stringify(photos), updatedAt: new Date().toISOString() };
      try { const saved = await firestore(`${collection}/${encodeURIComponent(body.recordId)}?updateMask.fieldPaths=photos&updateMask.fieldPaths=updatedAt`, { method: 'PATCH', body: JSON.stringify(toDocument(updated)) }); return json(res, 201, { photo, job: vendorView({ ...fromDocument(saved), photos }) }); } catch (error) { try { await deleteDriveFile(drive.id); } catch {} throw error; }
    }

    if (action === 'delete-photo' && body.recordId && body.photoId) {
      if (isRiverview) return json(res, 403, { error: '권한이 없습니다.' });
      const doc = await getDocOrNull(`${collection}/${encodeURIComponent(body.recordId)}`); if (!doc) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); const job = fromDocument(doc); if (!canSeeJob(job)) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); if (isVendor && job.assignedVendorId !== session.uid) return json(res, 403, { error: '권한이 없습니다.' });
      const photos = parsePhotos(job); const photo = photos.find(item => item.id === body.photoId); if (!photo) return json(res, 404, { error: 'Photo metadata not found' }); await deleteDriveFile(photo.driveFileId); const remaining = photos.filter(item => item.id !== body.photoId); const saved = await firestore(`${collection}/${encodeURIComponent(body.recordId)}?updateMask.fieldPaths=photos&updateMask.fieldPaths=updatedAt`, { method: 'PATCH', body: JSON.stringify(toDocument({ photos: JSON.stringify(remaining), updatedAt: new Date().toISOString() })) }); return json(res, 200, { photoId: body.photoId, job: vendorView({ ...fromDocument(saved), photos: remaining }) });
    }

    if (action === 'delete-job' && body.id) { if (!isMaster) return json(res, 403, { error: '권한이 없습니다.' }); const doc = await getDocOrNull(`${collection}/${encodeURIComponent(body.id)}`); if (!doc) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); const job = fromDocument(doc); if (!canSeeJob(job)) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); const photos = parsePhotos(job); for (const photo of photos) { if (photo.driveFileId) { try { await deleteDriveFile(photo.driveFileId); } catch {} } } await firestore(`${collection}/${encodeURIComponent(body.id)}`, { method: 'DELETE' }); return json(res, 200, { deleted: body.id, deletedPhotos: photos.length }); }

    if (action === 'update' && body.id) {
      if (isRiverview) return json(res, 403, { error: '권한이 없습니다.' });
      const doc = await getDocOrNull(`${collection}/${encodeURIComponent(body.id)}`); if (!doc) return json(res, 404, { error: '접수를 찾을 수 없습니다.' }); const job = fromDocument(doc); if (!canSeeJob(job)) return json(res, 404, { error: '접수를 찾을 수 없습니다.' });
      const now = new Date().toISOString(); let updates;
      if (isVendor) {
        if (job.assignedVendorId !== session.uid) return json(res, 403, { error: '권한이 없습니다.' });
        const data = body.data || {}; updates = { id: body.id, updatedAt: now };
        if (data.processContent !== undefined) updates.processContent = data.processContent;
        if (data.processDate !== undefined) updates.processDate = data.processDate;
        if (data.status === '처리중' || data.status === '완료') updates.status = data.status;
      } else {
        const data = cleanJob(body.data); delete data.id; delete data.createdAt; delete data.createdBy; delete data.photos; delete data.isTest;
        if (data.assignedVendorId !== undefined && data.assignedVendorId !== '') { const vendorDoc = await getDocOrNull(`${usersCollection}/${encodeURIComponent(data.assignedVendorId)}`); const vendorUser = vendorDoc ? fromDocument(vendorDoc) : null; if (!vendorUser || vendorUser.role !== 'vendor' || vendorUser.status !== 'approved' || (String(vendorUser.isTest) === 'true') !== testSession) return json(res, 400, { error: '승인된 외주업체가 아닙니다.' }); data.vendor = vendorUser.vendorName || ''; }
        updates = { ...data, id: body.id, updatedAt: now };
      }
      const mask = Object.keys(updates).map(field => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&');
      const saved = await firestore(`${collection}/${encodeURIComponent(body.id)}?${mask}`, { method: 'PATCH', body: JSON.stringify(toDocument(updates)) });
      const savedJob = fromDocument(saved); return json(res, 200, { job: vendorView({ ...savedJob, photos: parsePhotos(savedJob) }) });
    }

    if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
    return json(res, 400, { error: 'Invalid request' });
  } catch (error) { return json(res, error.statusCode || 500, { error: error.message || 'Server error', ...(error.body || {}) }); }
};
