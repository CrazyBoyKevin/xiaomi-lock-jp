import { createHash } from 'node:crypto';
import type { XiaomiAuth, XiaomiRegion } from './types';

const XSSI = '&&&START&&&';

function parseXiaomiJson(text: string) {
  const trimmed = text.trim();
  return JSON.parse((trimmed.startsWith(XSSI) ? trimmed.slice(XSSI.length) : trimmed).trim());
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

function randomChars(length: number, alphabet: string) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
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
    if (separator <= 0) continue;
    const key = first.slice(0, separator).trim();
    const cookieValue = first.slice(separator + 1);
    const deleted = cookieValue === 'EXPIRED'
      || /(?:^|;)\s*max-age\s*=\s*0(?:\s*;|$)/i.test(value);
    if (deleted) delete jar[key];
    else jar[key] = cookieValue;
  }
}

function serializeCookies(jar: Record<string, string>) {
  return Object.entries(jar).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join('; ');
}

function clientSign(nonce: string, ssecurity: string) {
  return createHash('sha1').update(`nonce=${nonce}&${ssecurity}`).digest('base64');
}

async function followLoginLocation(location: string, ua: string, jar: Record<string, string>, nonce?: string, ssecurity?: string) {
  const firstUrl = new URL(location);
  if (nonce && ssecurity) {
    firstUrl.searchParams.set('clientSign', clientSign(nonce, ssecurity));
    firstUrl.searchParams.set('_userIdNeedEncrypt', 'true');
  }
  let url = firstUrl.toString();
  for (let redirects = 0; redirects < 8; redirects += 1) {
    const response = await fetch(url, {
      headers: { 'user-agent': ua, cookie: serializeCookies(jar) },
      redirect: 'manual',
    });
    updateCookieJar(jar, response.headers);
    const next = response.headers.get('location');
    if (!next) break;
    url = new URL(next, url).toString();
  }
}

export class XiaomiPasswordLoginError extends Error {
  code: number;
  captchaUrl?: string;
  notificationUrl?: string;

  constructor(code: number, message: string, captchaUrl?: string, notificationUrl?: string) {
    super(message);
    this.code = code;
    this.captchaUrl = captchaUrl;
    this.notificationUrl = notificationUrl;
  }
}

export async function passwordLogin(username: string, password: string, region: XiaomiRegion = 'JP'): Promise<XiaomiAuth> {
  const serviceId = 'xiaomiio';
  const pass_o = randomChars(16, '0123456789abcdef');
  const deviceId = randomChars(16, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-');
  const uaId = randomChars(40, '0123456789ABCDEF');
  const ua = `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${uaId}-${region}-${randomChars(32, '0123456789ABCDEF')}-${randomChars(32, '0123456789ABCDEF')}-SmartHome-MI_APP_STORE-${uaId}|${randomChars(40, '0123456789ABCDEF')}|${pass_o}-64`;
  // The Xiaomi Account SDK obtains an account-bound _sign by sending the
  // login name as userId during the metadata request.
  const jar: Record<string, string> = { deviceId, pass_o, userId: username, uLocale: 'zh_CN' };
  const serviceResponse = await fetch(`https://account.xiaomi.com/pass/serviceLogin?sid=${serviceId}&_json=true&_locale=zh_CN`, {
    headers: { 'user-agent': ua, cookie: serializeCookies(jar) },
  });
  if (!serviceResponse.ok) throw new XiaomiPasswordLoginError(serviceResponse.status, `无法初始化小米登录（HTTP ${serviceResponse.status}）`);
  updateCookieJar(jar, serviceResponse.headers);
  const serviceData = parseXiaomiJson(await serviceResponse.text()) as Record<string, unknown>;
  const locationParams = serviceData.location ? Object.fromEntries(new URL(String(serviceData.location)).searchParams) : {};
  const loginContext = { ...locationParams, ...serviceData } as Record<string, unknown>;
  const callback = String(loginContext.callback || '');
  const qs = String(loginContext.qs || '');
  const sign = String(loginContext._sign || '');
  if (!callback || !qs || !sign) {
    throw new XiaomiPasswordLoginError(-1, '小米登录初始化响应缺少必要参数，请稍后重试。');
  }

  const form = new URLSearchParams({
    user: username,
    hash: createHash('md5').update(password).digest('hex').toUpperCase(),
    sid: serviceId,
    cc: region === 'CN' ? '86' : '81',
    _json: 'true',
    _locale: 'zh_CN',
    callback,
    qs,
    _sign: sign,
  });
  const loginResponse = await fetch('https://account.xiaomi.com/pass/serviceLoginAuth2', {
    method: 'POST',
    headers: {
      'user-agent': ua,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: serializeCookies(jar),
    },
    body: form,
  });
  if (!loginResponse.ok) throw new XiaomiPasswordLoginError(loginResponse.status, `小米账号验证请求失败（HTTP ${loginResponse.status}）`);
  updateCookieJar(jar, loginResponse.headers);
  const loginData = parseXiaomiJson(await loginResponse.text()) as Record<string, unknown>;
  const extensionData = parseExtensionPragma(loginResponse.headers);
  const loginCode = Number(recordValue(loginData, 'code') ?? -1);
  if (loginCode !== 0) {
    const description = loginCode === 70016
      ? `账号或密码不正确（70016）。请确认${region === 'CN' ? '中国' : '日本'}区账号、国家代码和密码中的反斜杠数量。`
      : String(recordValue(loginData, 'description') || recordValue(loginData, 'desc') || `小米登录失败（${loginCode}）`);
    throw new XiaomiPasswordLoginError(loginCode, description, String(recordValue(loginData, 'captchaUrl') || ''), String(recordValue(loginData, 'notificationUrl') || ''));
  }

  const securityStatus = Number(recordValue(loginData, 'securityStatus') ?? 0);
  const notificationUrl = String(recordValue(loginData, 'notificationUrl') || '');
  if (securityStatus !== 0) {
    throw new XiaomiPasswordLoginError(70001, '账号密码已验证，但小米要求进一步安全确认。请使用二维码授权完成登录。', undefined, notificationUrl);
  }

  for (const key of ['passToken', 'userId', 'cUserId']) {
    const value = recordValue(loginData, key);
    if (value) jar[key] = String(value);
  }
  const ssecurity = recordValue(loginData, 'ssecurity') || extensionData.ssecurity;
  const psecurity = recordValue(loginData, 'psecurity') || extensionData.psecurity;
  const nonce = recordValue(loginData, 'nonce') || extensionData.nonce;
  const location = recordValue(loginData, 'location');
  if (!location) {
    throw new XiaomiPasswordLoginError(-1, '账号密码验证成功，但小米未返回云端换票地址。请重试或改用二维码授权。');
  }
  await followLoginLocation(
    String(location),
    ua,
    jar,
    nonce === undefined || nonce === null ? undefined : String(nonce),
    ssecurity ? String(ssecurity) : undefined,
  );

  const passToken = recordValue(loginData, 'passToken') || jar.passToken;
  const userId = recordValue(loginData, 'userId') || jar.userId;
  const cUserId = recordValue(loginData, 'cUserId') || jar.cUserId;
  const serviceToken = jar.serviceToken
    || jar.yetAnotherServiceToken
    || jar[`${serviceId}_serviceToken`]
    || jar.mijia_serviceToken
    || recordValue(loginData, 'serviceToken');
  if (!serviceToken) {
    throw new XiaomiPasswordLoginError(
      -1,
      '账号密码验证成功，但小米未返回米家会话令牌。请重试；如果仍然失败，请改用二维码授权。',
      String(recordValue(loginData, 'captchaUrl') || ''),
      notificationUrl,
    );
  }
  const missing = [!ssecurity && 'ssecurity', !userId && 'userId', !cUserId && 'cUserId'].filter(Boolean);
  if (missing.length) {
    throw new XiaomiPasswordLoginError(-1, `账号验证成功，但米家会话缺少：${missing.join('、')}。请重试或改用二维码授权。`);
  }

  return {
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
}
