import { assertLocalRequest } from '@/lib/local-only';
import { passwordLogin, XiaomiPasswordLoginError } from '@/lib/xiaomi/password-login';
import type { XiaomiRegion } from '@/lib/xiaomi/types';

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = await request.json() as { username?: string; password?: string; region?: XiaomiRegion };
    if (!body.username?.trim() || !body.password) return Response.json({ error: '请输入账号和密码' }, { status: 400 });
    return Response.json({ auth: await passwordLogin(body.username.trim(), body.password, body.region === 'CN' ? 'CN' : 'JP') });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof XiaomiPasswordLoginError) {
      return Response.json({ error: error.message, code: error.code, captchaUrl: error.captchaUrl, notificationUrl: error.notificationUrl }, { status: 401 });
    }
    return Response.json({ error: error instanceof Error ? error.message : '小米账号登录失败' }, { status: 500 });
  }
}
