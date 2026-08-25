export type XiaomiRegion = 'JP' | 'CN';

export type XiaomiAuth = {
  psecurity?: string;
  nonce?: string;
  ssecurity: string;
  passToken?: string;
  userId: string;
  cUserId: string;
  serviceToken: string;
  deviceId: string;
  pass_o: string;
  ua: string;
  region?: XiaomiRegion;
  expireTime?: number;
};

export type XiaomiDevice = {
  did: string;
  name: string;
  model: string;
  home_id?: string;
  home_name?: string;
  room_id?: string;
  room_name?: string;
  parent_id?: string | null;
  online?: boolean;
  localip?: string;
  fw_version?: string;
  [key: string]: unknown;
};

export type XiaomiInventory = {
  homes: Array<{
    id: string;
    name: string;
    rooms: Array<{ id: string; name: string }>;
  }>;
  devices: XiaomiDevice[];
};

export type SpecProperty = {
  name: string;
  description: string;
  type: 'bool' | 'int' | 'uint' | 'float' | 'string';
  rw: string;
  range: number[] | null;
  valueList: Array<{ value: string | number; description: string }> | null;
  siid: number;
  piid: number;
};

export type SpecAction = {
  name: string;
  description: string;
  siid: number;
  aiid: number;
  inputPiids: number[];
  outputPiids: number[];
};

export type DeviceSpec = {
  name: string;
  model: string;
  properties: SpecProperty[];
  actions: SpecAction[];
};

export type XiaomiLockCloudPassword = {
  key: string;
  name: string;
  kind: 'user' | 'visitor';
  userId: number;
  passwordId: number | null;
  createdAt: number | null;
  deletable: boolean;
};

export type XiaomiLockCloudUser = {
  userId: number;
  name: string;
  passwordCount: number;
};

export type XiaomiLockCloudPasswordList = {
  entries: XiaomiLockCloudPassword[];
  users: XiaomiLockCloudUser[];
  syncedAt: number;
  source: 'xiaomi-cloud';
};
