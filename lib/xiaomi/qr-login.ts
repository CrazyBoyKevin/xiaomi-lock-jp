import { cleanupQrSessions, qrSessions } from './qr-store';
import type { XiaomiAuth, XiaomiRegion } from './types';

const XSSI = '&&&START&&&';

function randomChars(length: number, alphabet: string) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function parseXiaomiJson(text: string) {
  return JSON.parse(text.replace(XSSI, '').trim());
}

function cookieValues(headers: Headers) {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (values?.length) return values;
  const combined = headers.get('set-cookie');
  return combined ? combined.split(/,(?=[^;,]+=)/) : [];
}

function updateCookieJar(cookies: Record<string, string>, headers: Headers) {
  const values = cookieValues(headers);
  for (const value of values) {
    const first = value.split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator > 0) cookies[first.slice(0, separator)] = first.slice(separator + 1);
  }
}

function serializeCookies(cookies: Record<string, string>) {
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
}

function parseExtensionPragma(headers: Headers) {
  const value = headers.get('extension-pragma') || headers.get('x-xiaomi-extension-pragma');
  if (!value) return {} as Record<string, unknown>;
  try { return JSON.parse(value) as Record<string, unknown>; }
  catch { return {} as Record<string, unknown>; }
}

function recordValue(source: Record<string, unknown>, key: string) {
  const nested = source.data && typeof source.data === 'object' ? source.data as Record<string, unknown> : {};
  return source[key] ?? nested[key];
}

async function followLoginLocation(location: string, ua: string, cookies: Record<string, string>) {
  let url = location;
  for (let redirects = 0; redirects < 8; redirects += 1) {
    const response = await fetch(url, {
      headers: { 'user-agent': ua, cookie: serializeCookies(cookies) },
      redirect: 'manual',
    });
    updateCookieJar(cookies, response.headers);
    const next = response.headers.get('location');
    if (!next) return;
    url = new URL(next, url).toString();
  }
}

export async function startQrLogin(region: XiaomiRegion = 'JP') {
  cleanupQrSessions();
  const pass_o = randomChars(16, '0123456789abcdef');
  const deviceId = randomChars(16, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-');
  const uaId = randomChars(40, '0123456789ABCDEF');
  const ua = `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${uaId}-${region}-${randomChars(32, '0123456789ABCDEF')}-${randomChars(32, '0123456789ABCDEF')}-SmartHome-MI_APP_STORE-${uaId}|${randomChars(40, '0123456789ABCDEF')}|${pass_o}-64`;
  const serviceUrl = 'https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=xiaomiio&_locale=zh_CN';
  const locationResponse = await fetch(serviceUrl, {
    headers: { 'user-agent': ua, 'content-type': 'application/x-www-form-urlencoded', cookie: `deviceId=${deviceId};pass_o=${pass_o};uLocale=zh_CN` },
  });
  const locationData = parseXiaomiJson(await locationResponse.text());
  if (!locationData.location) throw new Error(locationData.description || locationData.desc || '无法创建小米登录会话');

  const location = new URL(locationData.location);
  location.searchParams.set('theme', '');
  location.searchParams.set('bizDeviceType', '');
  location.searchParams.set('_hasLogo', 'false');
  location.searchParams.set('_qrsize', '240');
  location.searchParams.set('_dc', String(Date.now()));
  const qrResponse = await fetch(`https://account.xiaomi.com/longPolling/loginUrl?${location.searchParams.toString()}`, {
    headers: { 'user-agent': ua, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const qrData = parseXiaomiJson(await qrResponse.text());
  if (!qrData.lp || !qrData.loginUrl) throw new Error(qrData.desc || '无法获取登录二维码');

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  qrSessions.set(id, {
    status: 'waiting', qrUrl: qrData.qr, loginUrl: qrData.loginUrl, pollUrl: qrData.lp,
    ua, deviceId, pass_o, region, createdAt,
  });
  return { id, qrUrl: qrData.qr, loginUrl: qrData.loginUrl, expiresAt: createdAt + 120000 };
}

async function completeQrLogin(id: string) {
  const session = qrSessions.get(id);
  if (!session) return;
  const { pollUrl, ua, deviceId, pass_o, region } = session;
  try {
    const cookies: Record<string, string> = { deviceId, pass_o, uLocale: 'zh_CN' };
    const pollResponse = await fetch(pollUrl, {
      headers: { 'user-agent': ua, cookie: serializeCookies(cookies) },
      signal: AbortSignal.timeout(125000),
    });
    updateCookieJar(cookies, pollResponse.headers);
    const loginData = parseXiaomiJson(await pollResponse.text()) as Record<string, unknown>;
    const extensionData = parseExtensionPragma(pollResponse.headers);
    const loginCode = Number(recordValue(loginData, 'code') ?? -1);
    if (loginCode !== 0) {
      const description = loginCode === 70016
        ? '手机端没有有效的米家账号会话（70016）。请使用米家 App 内的扫码入口，不要用系统相机直接打开。'
        : String(recordValue(loginData, 'description') || recordValue(loginData, 'desc') || `扫码登录未完成（${loginCode}）`);
      throw new Error(description);
    }

    for (const key of ['passToken', 'userId', 'cUserId']) {
      const value = recordValue(loginData, key);
      if (value) cookies[key] = String(value);
    }
    const location = recordValue(loginData, 'location');
    if (!location) throw new Error('扫码已确认，但小米未返回授权回调地址。');
    await followLoginLocation(String(location), ua, cookies);

    const ssecurity = recordValue(loginData, 'ssecurity') || extensionData.ssecurity;
    const psecurity = recordValue(loginData, 'psecurity') || extensionData.psecurity;
    const nonce = recordValue(loginData, 'nonce') || extensionData.nonce;
    const passToken = recordValue(loginData, 'passToken') || cookies.passToken;
    const userId = recordValue(loginData, 'userId') || cookies.userId;
    const cUserId = recordValue(loginData, 'cUserId') || cookies.cUserId;
    // The account callback may expose both a generic Xiaomi Home token and a
    // web-only mijia token. Cloud `/app` APIs authenticate with serviceToken.
    const serviceToken = cookies.serviceToken || cookies.yetAnotherServiceToken || cookies.mijia_serviceToken;
    const missing = [!ssecurity && 'ssecurity', !userId && 'userId', !cUserId && 'cUserId', !serviceToken && 'serviceToken'].filter(Boolean);
    if (missing.length) throw new Error(`扫码已确认，但米家会话缺少：${missing.join('、')}。请重新生成二维码。`);

    const auth: XiaomiAuth = {
      psecurity: psecurity ? String(psecurity) : undefined,
      nonce: nonce ? String(nonce) : undefined,
      ssecurity: String(ssecurity),
      passToken: passToken ? String(passToken) : undefined,
      userId: String(userId),
      cUserId: String(cUserId),
      serviceToken: String(serviceToken),
      deviceId,
      pass_o,
      ua,
      region,
      expireTime: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };
    qrSessions.set(id, { ...session, status: 'success', auth });
  } catch (error) {
    const message = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? '二维码授权已超时（约 2 分钟），请重新生成。'
      : error instanceof Error ? error.message : '扫码登录失败';
    qrSessions.set(id, { ...session, status: 'error', error: message });
  }
}

export async function waitForQrLogin(id: string) {
  const session = qrSessions.get(id);
  if (!session) return undefined;
  if (session.status === 'waiting') {
    session.completion ??= completeQrLogin(id);
    await session.completion;
  }
  return qrSessions.get(id);
}
