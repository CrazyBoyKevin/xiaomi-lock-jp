import { assertLocalRequest } from '@/lib/local-only';
import { waitForQrLogin } from '@/lib/xiaomi/qr-login';

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const id = new URL(request.url).searchParams.get('id');
    const session = id ? await waitForQrLogin(id) : undefined;
    if (!session) return Response.json({ error: '登录会话不存在或已过期' }, { status: 404 });
    return Response.json({ status: session.status, auth: session.auth, error: session.error });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: '无法检查登录状态' }, { status: 500 });
  }
}
