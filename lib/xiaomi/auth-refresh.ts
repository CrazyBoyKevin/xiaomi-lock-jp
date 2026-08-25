import type { XiaomiAuth } from './types';

const XSSI = '&&&START&&&';

function parseXiaomiJson(text: string) {
  return JSON.parse(text.replace(XSSI, '').trim()) as Record<string, unknown>;
}

function cookieValues(headers: Headers) {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (values?.length) return values;
  const combined = headers.get('set-cookie');
  return combined ? combined.split(/,(?=[^;,]+=)/) : [];
}

function updateCookieJar(jar: Record<string, string>, headers: Headers) {
  for (const value of cookieValues(headers)) {
    const first = value.split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator > 0) jar[first.slice(0, separator)] = first.slice(separator + 1);
  }
}

function serializeCookies(jar: Record<string, string>) {
  return Object.entries(jar).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join('; ');
}

async function followLocation(location: string, auth: XiaomiAuth, jar: Record<string, string>) {
  let url = location;
  for (let redirects = 0; redirects < 8; redirects += 1) {
    const response = await fetch(url, {
      headers: { 'user-agent': auth.ua, cookie: serializeCookies(jar) },
      redirect: 'manual',
    });
    updateCookieJar(jar, response.headers);
    const next = response.headers.get('location');
    if (!next) return;
    url = new URL(next, url).toString();
  }
}

/** Exchange the QR/pass token for a fresh token accepted by Xiaomi Home cloud. */
export async function refreshXiaomiAuth(auth: XiaomiAuth): Promise<XiaomiAuth> {
  const jar: Record<string, string> = {
    deviceId: auth.deviceId,
    pass_o: auth.pass_o,
    passToken: auth.passToken || '',
    userId: auth.userId,
    cUserId: auth.cUserId,
    serviceToken: auth.serviceToken,
    yetAnotherServiceToken: auth.serviceToken,
    uLocale: 'zh_CN',
  };
  const response = await fetch('https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=xiaomiio&_locale=zh_CN', {
    headers: { 'user-agent': auth.ua, cookie: serializeCookies(jar) },
  });
  if (!response.ok) throw new Error(`米家会话刷新失败（HTTP ${response.status}）`);
  updateCookieJar(jar, response.headers);
  const data = parseXiaomiJson(await response.text());
  const code = Number(data.code ?? -1);
  const location = data.location;
  if (code !== 0 || !location) {
    throw new Error(String(data.description || data.desc || '米家会话已失效，请重新扫码登录'));
  }
  await followLocation(String(location), auth, jar);
  const serviceToken = jar.serviceToken || jar.yetAnotherServiceToken;
  const ssecurity = data.ssecurity || auth.ssecurity;
  if (!serviceToken || !ssecurity) throw new Error('米家会话刷新后仍缺少云端认证令牌，请重新扫码登录');
  return {
    ...auth,
    ssecurity: String(ssecurity),
    psecurity: data.psecurity ? String(data.psecurity) : auth.psecurity,
    nonce: data.nonce ? String(data.nonce) : auth.nonce,
    passToken: jar.passToken || auth.passToken,
    userId: jar.userId || auth.userId,
    cUserId: jar.cUserId || auth.cUserId,
    serviceToken,
    expireTime: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
}
