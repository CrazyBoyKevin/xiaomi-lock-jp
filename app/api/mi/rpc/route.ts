import { assertLocalRequest } from '@/lib/local-only';
import { getAccountInventory, getDeviceSpec, getLockCloudPasswords, manageLockPassword, miRequest, prepareSecureDeviceAction, runDeviceAction } from '@/lib/xiaomi/client';
import type { XiaomiAuth } from '@/lib/xiaomi/types';

type RpcBody = {
  auth: XiaomiAuth;
  op: 'devices' | 'spec' | 'properties' | 'setProperty' | 'action' | 'prepareAction' | 'passwordList' | 'password';
  model?: string;
  did?: string;
  params?: unknown;
  siid?: number;
  piid?: number;
  aiid?: number;
  value?: unknown;
  values?: unknown[];
  mode?: 'create' | 'delete';
  pin?: string;
  userName?: string;
  passwordName?: string;
  userMode?: 'existing' | 'new';
  userId?: number;
  passwordId?: number;
};

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = await request.json() as RpcBody;
    if (!body.auth?.serviceToken || !body.auth?.ssecurity) return Response.json({ error: '登录信息不完整' }, { status: 401 });
    const originalServiceToken = body.auth.serviceToken;

    let result: unknown;
    if (body.op === 'devices') {
      result = await getAccountInventory(body.auth);
    }
    else if (body.op === 'spec' && body.model) {
      result = await getDeviceSpec(body.model);
    }
    else if (body.op === 'properties') result = await miRequest(body.auth, '/miotspec/prop/get', { params: body.params, datasource: 1 }, body.model);
    else if (body.op === 'setProperty' && body.did && body.siid && body.piid) {
      result = await miRequest(body.auth, '/miotspec/prop/set', { params: [{ did: body.did, siid: body.siid, piid: body.piid, value: body.value }] }, body.model);
    } else if (body.op === 'prepareAction' && body.did && body.model) {
      result = await prepareSecureDeviceAction(body.auth, { did: body.did, model: body.model });
    } else if (body.op === 'action' && body.did && body.model && body.siid && body.aiid) {
      result = await runDeviceAction(body.auth, {
        did: body.did, model: body.model, siid: body.siid, aiid: body.aiid, values: body.values,
      });
    } else if (body.op === 'passwordList' && body.did && body.model) {
      result = await getLockCloudPasswords(body.auth, { did: body.did, model: body.model });
    } else if (body.op === 'password' && body.did && body.model && body.mode === 'create'
      && typeof body.pin === 'string' && typeof body.userName === 'string' && typeof body.passwordName === 'string'
      && (body.userMode === 'existing' || body.userMode === 'new')) {
      result = await manageLockPassword(body.auth, {
        mode: 'create', did: body.did, model: body.model, pin: body.pin,
        userName: body.userName, passwordName: body.passwordName, userMode: body.userMode, userId: body.userId,
      });
    } else if (body.op === 'password' && body.did && body.model && body.mode === 'delete'
      && typeof body.userId === 'number' && typeof body.passwordId === 'number') {
      result = await manageLockPassword(body.auth, {
        mode: 'delete', did: body.did, model: body.model,
        userId: body.userId, passwordId: body.passwordId,
      });
    } else return Response.json({ error: '不支持或缺少参数的操作' }, { status: 400 });

    return Response.json({ result, auth: body.auth.serviceToken !== originalServiceToken ? body.auth : undefined });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : '米家操作失败' }, { status: 500 });
  }
}
