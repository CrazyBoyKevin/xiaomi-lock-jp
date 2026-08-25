import { assertLocalRequest } from '@/lib/local-only';
import { startQrLogin } from '@/lib/xiaomi/qr-login';
import type { XiaomiRegion } from '@/lib/xiaomi/types';

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = await request.json().catch(() => ({})) as { region?: XiaomiRegion };
    return Response.json(await startQrLogin(body.region === 'CN' ? 'CN' : 'JP'));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : '无法开始扫码登录' }, { status: 500 });
  }
}
