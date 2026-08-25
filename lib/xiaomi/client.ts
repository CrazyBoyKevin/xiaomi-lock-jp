import { decryptResponse, encryptLockUserPassword, encryptParams } from './crypto';
import { refreshXiaomiAuth } from './auth-refresh';
import type {
  DeviceSpec,
  SpecAction,
  SpecProperty,
  XiaomiAuth,
  XiaomiDevice,
  XiaomiInventory,
  XiaomiLockCloudPassword,
  XiaomiLockCloudPasswordList,
  XiaomiRegion,
} from './types';

const OPERATE_COMMON = '_language=ZH_CN&_appVersion=11.3.203&_platform=1&_platformVersion=18.7';
// Public access key embedded in the official xiaomi.lock.d100j iOS plugin.
// Xiaomi's plugin includes it on every MIoT action request.
const MIOT_ACTION_ACCESS_KEY = 'IOS00026747c5acafc2';
const deviceSpecCache = new Map<string, { value: DeviceSpec; expiresAt: number }>();
const DEVICE_SPEC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function authRegion(auth: XiaomiAuth): XiaomiRegion {
  return auth.region === 'CN' ? 'CN' : 'JP';
}

function apiHost(auth: XiaomiAuth, uri: string) {
  if (authRegion(auth) === 'CN') return 'api.io.mi.com';
  return uri.startsWith('/miotspec/') ? 'sg.core.api.io.mi.com' : 'sg.api.io.mi.com';
}

function cookieValue(value: string) {
  const unquoted = value.replace(/^"|"$/g, '');
  try { return decodeURIComponent(unquoted); }
  catch { return unquoted; }
}

function cookie(auth: XiaomiAuth) {
  const serviceToken = cookieValue(auth.serviceToken);
  const region = authRegion(auth);
  return [
    `cUserId=${auth.cUserId}`,
    `yetAnotherServiceToken=${serviceToken}`,
    `serviceToken=${serviceToken}`,
    `timezone_id=${region === 'CN' ? 'Asia/Shanghai' : 'Asia/Tokyo'}`,
    `timezone=${region === 'CN' ? 'GMT+08:00' : 'GMT+09:00'}`,
    `countryCode=${region}`,
    `PassportDeviceId=${auth.deviceId}`,
    `DEVICEID=${auth.deviceId}`,
    'locale=zh_CN',
    `userId=${auth.userId}`,
    'APPVERSION=1103203',
    'channel=MI_APP_STORE',
    'is_daylight=0',
    'dst_offset=0',
    'request_from=mihome_sdk',
    'xm_version=4.0',
  ].join('; ');
}

async function miRequestOnce(auth: XiaomiAuth, uri: string, data: unknown, model?: string) {
  const { params, nonce } = await encryptParams(uri, data, auth.ssecurity);
  const host = apiHost(auth, uri);
  const region = authRegion(auth);
  const response = await fetch(`https://${host}/app${uri}`, {
    method: 'POST',
    headers: {
      'user-agent': auth.ua,
      'accept': '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'content-type': 'application/x-www-form-urlencoded',
      'miot-encrypt-algorithm': 'ENCRYPT-RC4',
      'miot-accept-encoding': 'GZIP',
      'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
      'origin-from': 'MiHome',
      'operate-common': `_region=${region}&${OPERATE_COMMON}&_deviceId=${encodeURIComponent(auth.deviceId)}`,
      'domain-refer': host,
      'cookie': cookie(auth),
      ...(model ? { 'miot-request-model': model } : {}),
    },
    body: new URLSearchParams(params),
  });

  const text = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      detail = String(body.message || body.description || body.desc || body.error || '');
    } catch { /* upstream often returns an empty body for rejected sessions */ }
    throw new Error(`米家云请求失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`);
  }

  let decoded = text;
  try {
    JSON.parse(text);
  } catch {
    decoded = await decryptResponse(auth.ssecurity, nonce, text);
  }
  const result = JSON.parse(decoded);
  if (result.code !== 0 || !('result' in result)) {
    throw new Error(result.message || result.desc || `米家云返回错误 ${result.code}`);
  }
  return result.result;
}

export async function miRequest(auth: XiaomiAuth, uri: string, data: unknown, model?: string) {
  try {
    return await miRequestOnce(auth, uri, data, model);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('HTTP 401')) throw error;
    Object.assign(auth, await refreshXiaomiAuth(auth));
    return miRequestOnce(auth, uri, data, model);
  }
}

export async function getAccountInventory(auth: XiaomiAuth): Promise<XiaomiInventory> {
  const homeResult = await miRequest(auth, '/v2/homeroom/gethome_merged', {
    fg: true, fetch_share: true, fetch_share_dev: true, fetch_cariot: true, limit: 300, app_ver: 7, plat_form: 0,
  });
  const homes = homeResult.homelist ?? [];
  const devices: XiaomiDevice[] = [];

  for (const home of homes) {
    const roomNames = new Map((home.roomlist ?? []).map((room: { id: string | number; name: string }) => [String(room.id), room.name]));
    const deviceRooms = new Map<string, string>();
    for (const room of home.roomlist ?? []) {
      for (const did of room.dids ?? []) deviceRooms.set(String(did), String(room.id));
    }
    let startDid = '';
    let hasMore = true;
    while (hasMore) {
      const result = await miRequest(auth, '/home/home_device_list', {
        home_owner: Number(home.uid), home_id: Number(home.id), limit: 200, start_did: startDid,
        get_split_device: true, support_smart_home: true, get_cariot_device: true, get_third_device: true,
      });
      for (const device of result.device_info ?? []) {
        const roomId = String(device.room_id ?? device.roomid ?? deviceRooms.get(String(device.did)) ?? 'unassigned');
        cacheDeviceMac(auth, String(device.did), device.mac);
        // Do not expose the device token to browser state with the inventory.
        const { token: _deviceToken, ...publicDevice } = device;
        void _deviceToken;
        devices.push({
          ...publicDevice,
          home_id: String(home.id),
          home_name: home.name || `公寓楼 ${home.id}`,
          room_id: roomId,
          room_name: roomNames.get(roomId) || device.room_name || (roomId === 'unassigned' ? '未分配房间' : `房间 ${roomId}`),
        });
      }
      const nextDid = String(result.max_did ?? '');
      hasMore = Boolean(result.has_more && nextDid && nextDid !== startDid);
      startDid = nextDid;
    }
  }

  return {
    homes: homes.map((home: { id: string | number; name?: string; roomlist?: Array<{ id: string | number; name?: string }> }) => ({
      id: String(home.id),
      name: home.name || `公寓楼 ${home.id}`,
      rooms: (home.roomlist ?? []).map((room) => ({ id: String(room.id), name: room.name || `房间 ${room.id}` })),
    })),
    devices,
  };
}

function extractJsonScript(html: string) {
  const match = html.match(/<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('无法读取该设备的 MIoT 规格');
  return JSON.parse(match[1]);
}

export async function getDeviceSpec(model: string): Promise<DeviceSpec> {
  const cached = deviceSpecCache.get(model);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(`https://home.miot-spec.com/spec/${encodeURIComponent(model)}`, {
    headers: { 'user-agent': 'Mi-Lock-Console/0.1' },
  });
  if (!response.ok) throw new Error(`无法获取设备规格（HTTP ${response.status}）`);
  const content = extractJsonScript(await response.text());
  const product = content.props.product;
  const i18n = content.props.i18n?.zh_cn ?? {};
  const properties: SpecProperty[] = [];
  const actions: SpecAction[] = [];

  for (const service of content.props.tree.services ?? []) {
    for (const property of service.properties ?? []) {
      const description = i18n[`service:${String(service.iid).padStart(3, '0')}:property:${String(property.iid).padStart(3, '0')}`] || property.description || property.type;
      properties.push({
        name: property.type,
        description,
        type: property.format?.startsWith('uint') ? 'uint' : property.format?.startsWith('int') ? 'int' : property.format,
        rw: `${property.access?.includes('read') ? 'r' : ''}${property.access?.includes('write') ? 'w' : ''}`,
        range: property.valueRange ?? null,
        valueList: property.valueList?.map((entry: { value: string | number; description: string; i18nKey?: string }) => ({
          value: entry.value, description: (entry.i18nKey && i18n[entry.i18nKey]) || entry.description,
        })) ?? null,
        siid: service.iid,
        piid: property.iid,
      });
    }
    for (const action of service.actions ?? []) {
      const description = i18n[`service:${String(service.iid).padStart(3, '0')}:action:${String(action.iid).padStart(3, '0')}`] || action.description || action.type;
      actions.push({
        name: action.type,
        description,
        siid: service.iid,
        aiid: action.iid,
        inputPiids: action.in ?? [],
        outputPiids: action.out ?? [],
      });
    }
  }
  const spec = { name: product.name, model: product.model, properties, actions };
  deviceSpecCache.set(model, { value: spec, expiresAt: Date.now() + DEVICE_SPEC_CACHE_TTL_MS });
  return spec;
}

type PasswordOperation =
  | {
      mode: 'create';
      did: string;
      model: string;
      pin: string;
      userName: string;
      passwordName: string;
      userMode: 'existing' | 'new';
      userId?: number;
    }
  | { mode: 'delete'; did: string; model: string; userId: number; passwordId: number };

type MiotActionReply = { code?: number; out?: unknown[] };

type DeviceActionOperation = {
  did: string;
  model: string;
  siid: number;
  aiid: number;
  values?: unknown[];
};

type CachedLockSecret = { value: string; expiresAt: number };
const lockSecretCache = new Map<string, CachedLockSecret>();
const lockSecretPreparation = new Map<string, Promise<void>>();
const LOCK_SECRET_CACHE_TTL_MS = 30 * 60 * 1000;
const DEVICE_IDENTITY_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const deviceMacCache = new Map<string, CachedLockSecret>();

function lockSecretCacheKey(auth: XiaomiAuth, did: string) {
  return `${authRegion(auth)}:${auth.userId}:${did}`;
}

function cacheDeviceMac(auth: XiaomiAuth, did: string, mac: unknown) {
  if (typeof mac !== 'string') return;
  const compact = mac.replace(/[:-]/g, '');
  if (!/^[\da-f]{12}$/i.test(compact)) return;
  const normalized = compact.match(/../g)?.join(':');
  if (!normalized) return;
  deviceMacCache.set(lockSecretCacheKey(auth, did), {
    value: normalized,
    expiresAt: Date.now() + DEVICE_IDENTITY_CACHE_TTL_MS,
  });
}

async function deviceMac(auth: XiaomiAuth, did: string) {
  const cacheKey = lockSecretCacheKey(auth, did);
  let cached = deviceMacCache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) {
    await getAccountInventory(auth);
    cached = deviceMacCache.get(cacheKey);
  }
  if (!cached || cached.expiresAt <= Date.now()) {
    throw new Error('米家未返回这台门锁的蓝牙 MAC，无法按设备协议加密用户密码');
  }
  return cached.value;
}

function collectUserIdsFromCache(value: unknown, ids: Set<number>) {
  if (typeof value === 'string') {
    try { collectUserIdsFromCache(JSON.parse(value), ids); }
    catch { /* Non-JSON cache values are unrelated. */ }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUserIdsFromCache(item, ids);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const uid = Number(record.uid);
  if (Number.isInteger(uid) && uid >= 0 && uid <= 49) ids.add(uid);
  for (const nested of Object.values(record)) collectUserIdsFromCache(nested, ids);
}

function parseEmbeddedJson(value: unknown, depth = 0): unknown {
  if (typeof value !== 'string' || depth >= 4) return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return parseEmbeddedJson(JSON.parse(trimmed), depth + 1); }
  catch { return value; }
}

function cloudPropertyValue(value: unknown, propertyName: 's_user_list' | 's_visitor_list'): { found: boolean; value?: unknown } {
  if (typeof value === 'string') return cloudPropertyValue(parseEmbeddedJson(value), propertyName);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = cloudPropertyValue(item, propertyName);
      if (found.found) return found;
    }
    return { found: false };
  }
  if (!value || typeof value !== 'object') return { found: false };
  const record = value as Record<string, unknown>;
  for (const key of [`prop.${propertyName}`, propertyName]) {
    if (!(key in record)) continue;
    const property = record[key];
    if (property && typeof property === 'object' && !Array.isArray(property) && 'value' in property) {
      return { found: true, value: parseEmbeddedJson((property as Record<string, unknown>).value) };
    }
    return { found: true, value: parseEmbeddedJson(property) };
  }
  for (const nested of Object.values(record)) {
    const found = cloudPropertyValue(nested, propertyName);
    if (found.found) return found;
  }
  return { found: false };
}

function numericField(record: Record<string, unknown>, names: string[], minimum: number, maximum: number) {
  for (const name of names) {
    if (!(name in record)) continue;
    const value = Number(record[name]);
    if (Number.isSafeInteger(value) && value >= minimum && value <= maximum) return value;
  }
  return undefined;
}

function textField(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80);
  }
  return undefined;
}

function timestampField(record: Record<string, unknown>) {
  const value = numericField(record, ['created_at', 'createdAt', 'create_time', 'createTime', 'ctime', 'timestamp'], 1, Number.MAX_SAFE_INTEGER);
  if (!value) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  return milliseconds > Date.UTC(2000, 0, 1) && milliseconds < Date.UTC(2100, 0, 1) ? milliseconds : null;
}

function normalizeCloudPasswords(value: unknown, kind: 'user' | 'visitor') {
  const entries: XiaomiLockCloudPassword[] = [];
  const emitted = new Set<string>();

  const visit = (raw: unknown, inheritedUserId?: number, inheritedName?: string): number => {
    const parsed = parseEmbeddedJson(raw);
    if (Array.isArray(parsed)) return parsed.reduce((count, item) => count + visit(item, inheritedUserId, inheritedName), 0);
    if (!parsed || typeof parsed !== 'object') return 0;
    const record = parsed as Record<string, unknown>;
    const userId = numericField(record, ['uid', 'user_id', 'userId', 'userid'], 0, 49) ?? inheritedUserId;
    const passwordName = textField(record, [
      'pName', 'password_name', 'passwordName', 'password_nickname', 'passwordNickname',
      'pwd_name', 'pwdName', 'key_name', 'keyName',
    ]);
    const name = passwordName
      ?? textField(record, ['uName', 'name', 'nickname', 'user_name', 'userName', 'remark', 'alias'])
      ?? inheritedName;
    const passwordId = numericField(record, ['pid', 'password_id', 'passwordId', 'passwordid', 'pwd_id', 'pwdId', 'key_id', 'keyId'], 0, 65535);
    let nestedCount = 0;

    for (const [key, nested] of Object.entries(record)) {
      if (['uid', 'user_id', 'userId', 'userid', 'uName', 'name', 'nickname', 'user_name', 'userName', 'remark', 'alias'].includes(key)) continue;
      const numericKeyUserId = /^\d{1,2}$/.test(key) && Number(key) <= 49 && nested && typeof nested === 'object'
        ? Number(key)
        : undefined;
      nestedCount += visit(nested, numericKeyUserId ?? userId, name);
    }

    // s_user_list keeps the user object after its last credential is removed.
    // That object is a valid user, but it is not a password row.
    if (userId === undefined || passwordId === undefined) return nestedCount;
    const stablePasswordId = passwordId;
    const identity = `${kind}:${userId}:${stablePasswordId}`;
    if (emitted.has(identity)) return nestedCount;
    emitted.add(identity);
    entries.push({
      key: identity,
      name: name || (kind === 'visitor' ? `访客 ${userId}` : `门锁用户 ${userId}`),
      kind,
      userId,
      passwordId: stablePasswordId,
      createdAt: timestampField(record),
      deletable: stablePasswordId !== 65535,
    });
    return nestedCount + 1;
  };

  visit(value);
  return entries;
}

function normalizeCloudUsers(value: unknown) {
  const users = new Map<number, string>();

  const visit = (raw: unknown, inheritedUserId?: number, inheritedName?: string) => {
    const parsed = parseEmbeddedJson(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) visit(item, inheritedUserId, inheritedName);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const record = parsed as Record<string, unknown>;
    const userId = numericField(record, ['uid', 'user_id', 'userId', 'userid'], 0, 49) ?? inheritedUserId;
    const name = textField(record, ['uName', 'name', 'nickname', 'user_name', 'userName', 'remark', 'alias']) ?? inheritedName;
    if (userId !== undefined) users.set(userId, name || users.get(userId) || `门锁用户 ${userId}`);

    for (const [key, nested] of Object.entries(record)) {
      if (['uid', 'user_id', 'userId', 'userid', 'uName', 'name', 'nickname', 'user_name', 'userName', 'remark', 'alias'].includes(key)) continue;
      const numericKeyUserId = /^\d{1,2}$/.test(key) && Number(key) <= 49 && nested && typeof nested === 'object'
        ? Number(key)
        : undefined;
      visit(nested, numericKeyUserId ?? userId, name);
    }
  };

  visit(value);
  return users;
}

type LockUserDataCredential = {
  userId: number;
  passwordId: number;
  passwordType: number;
  status: number;
};

function decodeLockUserData(value: unknown): LockUserDataCredential[] | null {
  const parsed = parseEmbeddedJson(value);
  if (!Array.isArray(parsed)) return null;
  const encoded = parsed.find((item) => item && typeof item === 'object'
    && Number((item as Record<string, unknown>).piid) === 36
    && typeof (item as Record<string, unknown>).value === 'string') as Record<string, unknown> | undefined;
  if (!encoded || typeof encoded.value !== 'string') return null;

  try {
    const binary = atob(encoded.value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length < 6 || bytes[0] !== 0xfa || bytes[bytes.length - 1] !== 0xfb) return null;
    const credentials: LockUserDataCredential[] = [];
    // D100 user-data is 0xFA + repeated four-byte records + 0xFB:
    // [user id, password id, credential type, active status].
    for (let offset = 1; offset + 3 < bytes.length - 1; offset += 4) {
      const userId = bytes[offset];
      const passwordId = bytes[offset + 1];
      const passwordType = bytes[offset + 2];
      const status = bytes[offset + 3];
      if (userId === 0 && passwordId === 0 && passwordType === 0 && status === 0) continue;
      credentials.push({ userId, passwordId, passwordType, status });
    }
    return credentials;
  } catch {
    return null;
  }
}

function collectLockUserDataEvents(value: unknown, rows: Array<{ time: number; value: unknown }>) {
  if (Array.isArray(value)) {
    for (const item of value) collectLockUserDataEvents(item, rows);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.key === '24.1' && 'value' in record) {
    const time = Number(record.time);
    if (Number.isFinite(time)) rows.push({ time, value: record.value });
  }
  for (const nested of Object.values(record)) collectLockUserDataEvents(nested, rows);
}

async function latestLockUserData(
  auth: XiaomiAuth,
  operation: Pick<PasswordOperation, 'did' | 'model'>,
) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const response = await miRequest(auth, '/user/get_user_device_data', {
      did: operation.did,
      key: '24.1',
      type: 'event',
      time_start: now - 30 * 24 * 60 * 60,
      time_end: now + 60,
      limit: 5,
    }, operation.model);
    const rows: Array<{ time: number; value: unknown }> = [];
    collectLockUserDataEvents(response, rows);
    rows.sort((left, right) => right.time - left.time);
    for (const row of rows) {
      const credentials = decodeLockUserData(row.value);
      if (credentials) return { credentials, time: row.time };
    }
  } catch {
    // Older locks do not publish 24.1; their cloud cache remains the fallback.
  }
  return null;
}

export async function getLockCloudPasswords(
  auth: XiaomiAuth,
  operation: Pick<PasswordOperation, 'did' | 'model'>,
): Promise<XiaomiLockCloudPasswordList> {
  const cached = await miRequest(auth, '/v2/device/batchgetdatas', [
    { did: operation.did, props: ['prop.s_user_list', 'prop.s_visitor_list'] },
  ], operation.model);
  const userList = cloudPropertyValue(cached, 's_user_list');
  const visitorList = cloudPropertyValue(cached, 's_visitor_list');
  if (!userList.found && !visitorList.found) {
    throw new Error('米家云没有返回门锁用户列表，页面不会使用本地缓存代替');
  }
  const cachedEntries = [
    ...(userList.found ? normalizeCloudPasswords(userList.value, 'user') : []),
    ...(visitorList.found ? normalizeCloudPasswords(visitorList.value, 'visitor') : []),
  ];
  const cloudUsers = userList.found ? normalizeCloudUsers(userList.value) : new Map<number, string>();
  const userData = await latestLockUserData(auth, operation);
  const activeCredentials = userData
    ? new Set(userData.credentials
      .filter((credential) => credential.status !== 0 && credential.passwordId !== 0)
      .map((credential) => `${credential.userId}:${credential.passwordId}`))
    : null;
  const entries = activeCredentials
    ? cachedEntries.filter((entry) => entry.passwordId !== null && activeCredentials.has(`${entry.userId}:${entry.passwordId}`))
    : cachedEntries;
  const passwordCountByUser = new Map<number, number>();
  for (const entry of entries) {
    if (entry.kind === 'user') passwordCountByUser.set(entry.userId, (passwordCountByUser.get(entry.userId) ?? 0) + 1);
  }
  return {
    entries: entries.sort((left, right) => left.userId - right.userId || (left.passwordId ?? -1) - (right.passwordId ?? -1)),
    users: [...cloudUsers.entries()]
      .sort(([left], [right]) => left - right)
      .map(([userId, name]) => ({ userId, name, passwordCount: passwordCountByUser.get(userId) ?? 0 })),
    syncedAt: userData ? userData.time * 1000 : Date.now(),
    source: 'xiaomi-cloud',
  };
}

async function readLockUserListCache(
  auth: XiaomiAuth,
  operation: Pick<PasswordOperation, 'did' | 'model'>,
) {
  const cached = await miRequest(auth, '/v2/device/batchgetdatas', [
    { did: operation.did, props: ['prop.s_user_list'] },
  ], operation.model);
  const property = cloudPropertyValue(cached, 's_user_list');
  const parsed = property.found ? parseEmbeddedJson(property.value) : null;
  if (!Array.isArray(parsed)) throw new Error('米家云没有返回可编辑的门锁用户列表');
  return parsed;
}

function updateLockUserNames(
  users: unknown[],
  target: { userId: number; passwordId: number; userName?: string; passwordName: string },
) {
  let foundUser = false;
  let foundPassword = false;
  const updated = users.map((rawUser) => {
    if (!rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) return rawUser;
    const user = rawUser as Record<string, unknown>;
    if (Number(user.uid) !== target.userId) return rawUser;
    foundUser = true;
    const passwords = Array.isArray(user.password) ? user.password.map((rawPassword) => {
      if (!rawPassword || typeof rawPassword !== 'object' || Array.isArray(rawPassword)) return rawPassword;
      const password = rawPassword as Record<string, unknown>;
      if (Number(password.pid) !== target.passwordId) return rawPassword;
      foundPassword = true;
      return { ...password, pName: target.passwordName };
    }) : user.password;
    return {
      ...user,
      ...(target.userName ? { uName: target.userName } : {}),
      password: passwords,
    };
  });
  return { updated, foundUser, foundPassword };
}

function lockCloudNamesMatch(
  users: unknown[],
  target: { userId: number; passwordId: number; userName?: string; passwordName: string },
) {
  return users.some((rawUser) => {
    if (!rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) return false;
    const user = rawUser as Record<string, unknown>;
    if (Number(user.uid) !== target.userId || (target.userName && user.uName !== target.userName)) return false;
    return Array.isArray(user.password) && user.password.some((rawPassword) => rawPassword
      && typeof rawPassword === 'object' && !Array.isArray(rawPassword)
      && Number((rawPassword as Record<string, unknown>).pid) === target.passwordId
      && (rawPassword as Record<string, unknown>).pName === target.passwordName);
  });
}

async function syncLockCloudNames(
  auth: XiaomiAuth,
  operation: Pick<PasswordOperation, 'did' | 'model'>,
  target: { userId: number; passwordId: number; userName?: string; passwordName: string },
) {
  let updatedUsers: unknown[] | null = null;
  for (const delay of [500, 700, 1000, 1500, 2500, 4000]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const users = await readLockUserListCache(auth, operation);
    const updated = updateLockUserNames(users, target);
    if (updated.foundUser && updated.foundPassword) {
      updatedUsers = updated.updated;
      break;
    }
  }
  if (!updatedUsers) throw new Error('门锁已创建密码，但米家云用户列表尚未出现该记录，无法写入用户名称');

  await miRequest(auth, '/v2/device/batch_set_props', [{
    did: operation.did,
    props: { 'prop.s_user_list': JSON.stringify(updatedUsers) },
  }], operation.model);

  for (const delay of [300, 600, 1000, 1800]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const users = await readLockUserListCache(auth, operation);
    if (lockCloudNamesMatch(users, target)) return;
  }
  throw new Error('密码已创建，但米家云未确认用户名称和密码名称，请刷新列表检查');
}

async function availableLockUserId(auth: XiaomiAuth, operation: Extract<PasswordOperation, { mode: 'create' }>) {
  // Slot 0 is the D100 owner. Xiaomi's plugin selects the first free ID from
  // 0..49 after reading both cached user lists.
  const usedIds = new Set<number>([0]);
  const cached = await miRequest(auth, '/v2/device/batchgetdatas', [
    { did: operation.did, props: ['prop.s_user_list', 'prop.s_visitor_list'] },
  ], operation.model);
  collectUserIdsFromCache(cached, usedIds);
  for (let userId = 0; userId <= 49; userId += 1) {
    if (!usedIds.has(userId)) return userId;
  }
  throw new Error('门锁的 50 个用户槽位已全部占用，请先删除一个旧用户');
}

function cacheLockSecret(auth: XiaomiAuth, did: string, value: string) {
  lockSecretCache.set(lockSecretCacheKey(auth, did), {
    value, expiresAt: Date.now() + LOCK_SECRET_CACHE_TTL_MS,
  });
}

function takeCachedLockSecret(auth: XiaomiAuth, did: string) {
  const key = lockSecretCacheKey(auth, did);
  const cached = lockSecretCache.get(key);
  lockSecretCache.delete(key);
  return cached && cached.expiresAt > Date.now() ? cached.value : undefined;
}

function actionReply(result: unknown): MiotActionReply {
  const reply = Array.isArray(result) ? result[0] : result;
  if (!reply || typeof reply !== 'object') throw new Error('门锁没有返回有效的操作结果');
  const parsed = reply as MiotActionReply;
  if (typeof parsed.code === 'number' && parsed.code !== 0) {
    throw new Error(`门锁拒绝了操作（MIoT ${parsed.code}）`);
  }
  return parsed;
}

function outputValues(spec: DeviceSpec, action: SpecAction, reply: MiotActionReply) {
  const values = new Map<string, unknown>();
  for (const [index, item] of (reply.out ?? []).entries()) {
    const object = item && typeof item === 'object' ? item as { piid?: number; value?: unknown } : undefined;
    const piid = object?.piid ?? action.outputPiids[index];
    const property = spec.properties.find((entry) => entry.siid === action.siid && entry.piid === piid);
    if (property) values.set(property.name, object && 'value' in object ? object.value : item);
  }
  return values;
}

function actionObjects(spec: DeviceSpec, action: SpecAction, values: unknown[]) {
  return values.map((value, index) => {
    const piid = action.inputPiids[index];
    const property = spec.properties.find((entry) => entry.siid === action.siid && entry.piid === piid);
    const listedValues = property?.valueList?.map((entry) => Number(entry.value)) ?? [];
    const isByte = property?.type === 'uint' && (
      (property.range?.[1] !== undefined && property.range[1] <= 255)
      || (listedValues.length > 0 && listedValues.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255))
    );
    const type = property?.type === 'string' || typeof value === 'string'
      ? 10
      : property?.type === 'bool' || typeof value === 'boolean' || isByte ? 1 : 3;
    return { type, value, piid };
  });
}

async function requestSpecAction(
  auth: XiaomiAuth,
  operation: Pick<DeviceActionOperation, 'did' | 'model'>,
  spec: DeviceSpec,
  action: SpecAction,
  values: unknown[],
) {
  return miRequest(auth, '/miotspec/action', {
    accessKey: MIOT_ACTION_ACCESS_KEY,
    params: {
      did: operation.did,
      siid: action.siid,
      aiid: action.aiid,
      in: values,
      objects: actionObjects(spec, action, values),
    },
  }, operation.model);
}

function successfulLockResult(value: unknown) {
  return value === 1 || value === true || value === '1';
}

async function currentLockSecret(
  auth: XiaomiAuth,
  operation: DeviceActionOperation,
  spec: DeviceSpec,
  getSecretAction: SpecAction,
) {
  const reply = actionReply(await requestSpecAction(auth, operation, spec, getSecretAction, []));
  const outputs = outputValues(spec, getSecretAction, reply);
  const secret = outputs.get('secret');
  const result = outputs.get('res') ?? outputs.get('result');
  const message = outputs.get('msg');
  if (typeof secret !== 'string' || !secret || !successfulLockResult(result)) {
    throw new Error(typeof message === 'string' && message
      ? `门锁安全握手失败：${message}`
      : '门锁没有返回有效的动态安全密文，请确认门锁 Wi-Fi 在线');
  }
  return secret;
}

async function runSecureLockAction(
  auth: XiaomiAuth,
  operation: DeviceActionOperation,
  spec: DeviceSpec,
  action: SpecAction,
  getSecretAction: SpecAction,
) {
  const preparation = lockSecretPreparation.get(lockSecretCacheKey(auth, operation.did));
  if (preparation) {
    try { await preparation; }
    catch { /* The normal fresh-handshake fallback below will report errors. */ }
  }
  const execute = async (secret: string) => {
    const reply = actionReply(await requestSpecAction(auth, operation, spec, action, [secret]));
    const outputs = outputValues(spec, action, reply);
    return { reply, outputs };
  };

  const cachedSecret = takeCachedLockSecret(auth, operation.did);
  let source: 'cached' | 'fresh' | 'refreshed' = cachedSecret ? 'cached' : 'fresh';
  let result: Awaited<ReturnType<typeof execute>> | undefined;
  if (cachedSecret) {
    try { result = await execute(cachedSecret); }
    catch { /* A stale cached token is recovered below with a fresh handshake. */ }
  }

  let status = result?.outputs.get('res') ?? result?.outputs.get('result');
  if (!result || !successfulLockResult(status)) {
    source = cachedSecret ? 'refreshed' : 'fresh';
    result = await execute(await currentLockSecret(auth, operation, spec, getSecretAction));
    status = result.outputs.get('res') ?? result.outputs.get('result');
  }
  if (!cachedSecret && !successfulLockResult(status)) {
    source = 'refreshed';
    result = await execute(await currentLockSecret(auth, operation, spec, getSecretAction));
    status = result.outputs.get('res') ?? result.outputs.get('result');
  }

  if (!successfulLockResult(status)) {
    const message = result.outputs.get('msg');
    throw new Error(typeof message === 'string' && message
      ? `门锁未执行指令：${message}`
      : '米家云已接收请求，但门锁没有执行指令');
  }

  // The successful response contains the next one-time token. Keep it only in
  // server memory so the following command normally needs a single request.
  const nextSecret = result.outputs.get('msg');
  if (typeof nextSecret === 'string' && nextSecret) {
    cacheLockSecret(auth, operation.did, nextSecret);
  }
  return { ...result.reply, out: [status], secure: true, secretSource: source };
}

export async function prepareSecureDeviceAction(auth: XiaomiAuth, operation: Pick<DeviceActionOperation, 'did' | 'model'>) {
  const cacheKey = lockSecretCacheKey(auth, operation.did);
  const cached = lockSecretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { prepared: true };
  const existing = lockSecretPreparation.get(cacheKey);
  if (existing) { await existing; return { prepared: true }; }

  const spec = await getDeviceSpec(operation.model);
  const secureAction = spec.actions.find((action) => action.inputPiids.length === 1
    && spec.properties.some((property) => property.siid === action.siid
      && property.piid === action.inputPiids[0] && property.name === 'secret'));
  if (!secureAction) return { prepared: false };
  const getSecretAction = spec.actions.find((action) => action.siid === secureAction.siid && action.name === 'get-lockmsg');
  if (!getSecretAction) return { prepared: false };
  const context: DeviceActionOperation = {
    ...operation, siid: getSecretAction.siid, aiid: getSecretAction.aiid,
  };
  const preparation = (async () => {
    cacheLockSecret(auth, operation.did, await currentLockSecret(auth, context, spec, getSecretAction));
  })();
  lockSecretPreparation.set(cacheKey, preparation);
  try { await preparation; }
  finally {
    if (lockSecretPreparation.get(cacheKey) === preparation) lockSecretPreparation.delete(cacheKey);
  }
  return { prepared: true };
}

export async function runDeviceAction(auth: XiaomiAuth, operation: DeviceActionOperation) {
  const spec = await getDeviceSpec(operation.model);
  const action = spec.actions.find((entry) => entry.siid === operation.siid && entry.aiid === operation.aiid);
  if (!action) throw new Error('设备规格中不存在该操作');

  const inputProperties = action.inputPiids.map((piid) =>
    spec.properties.find((property) => property.siid === action.siid && property.piid === piid));
  const usesRotatingSecret = inputProperties.length === 1 && inputProperties[0]?.name === 'secret';
  if (usesRotatingSecret) {
    const getSecretAction = spec.actions.find((entry) => entry.siid === action.siid && entry.name === 'get-lockmsg');
    if (!getSecretAction) throw new Error('该门锁缺少动态安全密文协商能力');
    return runSecureLockAction(auth, operation, spec, action, getSecretAction);
  }

  const values = operation.values ?? [];
  if (values.length !== action.inputPiids.length) throw new Error('设备操作参数数量不正确');
  return requestSpecAction(auth, operation, spec, action, values);
}

function actionInputs(spec: DeviceSpec, action: SpecAction, supplied: Record<string, unknown>) {
  return action.inputPiids.map((piid) => {
    const property = spec.properties.find((entry) => entry.siid === action.siid && entry.piid === piid);
    if (!property || !(property.name in supplied)) {
      throw new Error(`暂不支持该门锁的密码字段（${property?.name || `piid ${piid}`}）`);
    }
    return supplied[property.name];
  });
}

function passwordActionResult(outputs: Map<string, unknown>) {
  const raw = outputs.get('result') ?? outputs.get('password-result');
  const code = Number(raw);
  return {
    code: Number.isFinite(code) ? code : undefined,
    asynchronous: outputs.has('result') && code === 1,
  };
}

async function refreshLockUserData(
  auth: XiaomiAuth,
  operation: Pick<PasswordOperation, 'did' | 'model'>,
  spec: DeviceSpec,
) {
  const action = spec.actions.find((entry) => entry.name === 'update-user-data');
  if (!action) return { requested: false, asynchronous: false };

  const reply = actionReply(await requestSpecAction(auth, operation, spec, action, []));
  const outputs = outputValues(spec, action, reply);
  const rawResult = outputs.get('result');
  const code = Number(rawResult);
  if (rawResult !== true && !(rawResult !== false && rawResult !== null && rawResult !== undefined
    && (code === 0 || code === 1))) {
    const rawMessage = outputs.get('msg');
    const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
    throw new Error(message || `门锁用户数据同步失败${Number.isFinite(code) ? `（设备状态码 ${code}）` : ''}`);
  }
  return { requested: true, asynchronous: code === 1 };
}

async function performPasswordAction(
  auth: XiaomiAuth,
  operation: PasswordOperation,
  spec: DeviceSpec,
  action: SpecAction,
  supplied: Record<string, unknown>,
) {
  const values = actionInputs(spec, action, supplied);
  const reply = actionReply(await requestSpecAction(auth, operation, spec, action, values));
  const outputs = outputValues(spec, action, reply);
  const rawMessage = outputs.get('msg');
  const message = typeof rawMessage === 'string' && rawMessage.trim() && !/^-?\d+$/.test(rawMessage.trim())
    ? rawMessage.trim()
    : '';

  // Two MIoT password protocols are in use. Newer D100 locks return `result`
  // where 0 means success and 1 means asynchronous success. Other locks return
  // `password-result`, where 1 means success and 2 means a duplicate password.
  const passwordResult = outputs.get('password-result');
  if (passwordResult !== undefined) {
    const code = Number(passwordResult);
    if (code !== 1) {
      const operationName = operation.mode === 'create' ? '创建' : '删除';
      const status = Number.isFinite(code) ? `（设备状态码 ${code} · ${spec.model}）` : '';
      throw new Error(message || `门锁未确认密码${operationName}成功${status}`);
    }
    return outputs;
  }

  const result = outputs.get('result');
  if (result === true) return outputs;
  const code = Number(result);
  if (result !== false && result !== null && result !== undefined && (code === 0 || code === 1)) return outputs;
  const operationName = operation.mode === 'create' ? '创建' : '删除';
  if (result === undefined || result === null) throw new Error(`门锁未返回密码${operationName}结果`);
  const status = Number.isFinite(code) ? String(code) : String(result);
  throw new Error(message || `门锁未确认密码${operationName}成功（设备状态码 ${status} · ${spec.model}）`);
}

export async function manageLockPassword(auth: XiaomiAuth, operation: PasswordOperation) {
  const spec = await getDeviceSpec(operation.model);

  if (operation.mode === 'create') {
    if (!/^\d{6}$/.test(operation.pin)) throw new Error('门锁密码必须是 6 位数字');
    const userName = operation.userName.trim();
    if (operation.userMode === 'new'
      && (!userName || userName.length > 32 || /[\u0000-\u001f\u007f]/.test(userName))) {
      throw new Error('用户名称必须为 1–32 个有效字符');
    }
    const passwordName = operation.passwordName.trim();
    if (!passwordName || passwordName.length > 32 || /[\u0000-\u001f\u007f]/.test(passwordName)) {
      throw new Error('密码名称必须为 1–32 个有效字符');
    }
    const action = spec.actions.find((entry) => entry.name === 'edit-user-password');
    if (!action) throw new Error('这款门锁没有公开永久密码创建能力');
    const credential = encryptLockUserPassword(operation.pin, operation.did, await deviceMac(auth, operation.did));
    let userId: number;
    if (operation.userMode === 'new') {
      userId = await availableLockUserId(auth, operation);
    } else {
      if (!Number.isSafeInteger(operation.userId) || operation.userId === undefined
        || operation.userId < 0 || operation.userId > 49) {
        throw new Error('请选择有效的已有门锁用户');
      }
      const cloud = await getLockCloudPasswords(auth, operation);
      if (!cloud.users.some((user) => user.userId === operation.userId)) {
        throw new Error('所选用户已不在米家云端列表中，请重新同步后选择');
      }
      userId = operation.userId;
    }
    const outputs = await performPasswordAction(auth, operation, spec, action, {
      'password-current': credential,
      'user-id': userId,
      'password-id': 65535,
      'edit-password-type': 0,
    });
    const actionResult = passwordActionResult(outputs);
    const passwordId = Number(outputs.get('password-id'));
    if (!Number.isSafeInteger(passwordId) || passwordId < 0 || passwordId === 65535) {
      throw new Error('门锁已接收密码，但没有返回可用于设置名称的密码编号，请同步列表确认后重试');
    }
    if (actionResult.asynchronous) await new Promise((resolve) => setTimeout(resolve, 900));
    const renameOutputs = await performPasswordAction(auth, operation, spec, action, {
      // For edit type 3 the same positional string carries the password name.
      'password-current': passwordName,
      'user-id': userId,
      'password-id': passwordId,
      'edit-password-type': 3,
    });
    const renameResult = passwordActionResult(renameOutputs);
    if (renameResult.asynchronous) await new Promise((resolve) => setTimeout(resolve, 450));
    const refresh = await refreshLockUserData(auth, operation, spec);
    await syncLockCloudNames(auth, operation, {
      userId,
      passwordId,
      userName: operation.userMode === 'new' ? userName : undefined,
      passwordName,
    });
    return {
      // Xiaomi's own plugin keeps the locally selected user ID and only reads
      // the password ID from the action response.
      userId,
      userName: operation.userMode === 'new' ? userName : undefined,
      passwordId,
      passwordName,
      createdAt: Date.now(),
      asynchronous: actionResult.asynchronous || renameResult.asynchronous,
      userDataRefreshRequested: refresh.requested,
    };
  }

  if (!Number.isSafeInteger(operation.userId) || operation.userId < 0) throw new Error('无效的门锁用户编号');
  if (!Number.isSafeInteger(operation.passwordId) || operation.passwordId < 0) throw new Error('无效的门锁密码编号');
  const action = spec.actions.find((entry) => entry.name === 'edit-user-password');
  if (!action) throw new Error('这款门锁没有公开密码删除能力');
  const outputs = await performPasswordAction(auth, operation, spec, action, {
    // This field is only the credential being added or reset. Xiaomi's D100
    // protocol still requires the positional string when deleting, but its
    // value must be empty; the user/password IDs identify the target.
    'password-current': '',
    'user-id': operation.userId,
    'password-id': operation.passwordId,
    'edit-password-type': 2,
  });
  const actionResult = passwordActionResult(outputs);
  if (actionResult.asynchronous) await new Promise((resolve) => setTimeout(resolve, 450));
  const refresh = await refreshLockUserData(auth, operation, spec);
  return {
    deleted: true,
    asynchronous: actionResult.asynchronous,
    userDataRefreshRequested: refresh.requested,
  };
}
