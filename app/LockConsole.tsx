'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import type {
  DeviceSpec,
  SpecAction,
  SpecProperty,
  XiaomiAuth,
  XiaomiDevice,
  XiaomiInventory,
  XiaomiLockCloudPassword,
  XiaomiLockCloudPasswordList,
  XiaomiLockCloudUser,
  XiaomiRegion,
} from '@/lib/xiaomi/types';

const AUTH_KEY = 'mi-lock-console.jp.auth.v1';
const LEGACY_PASSWORD_META_PREFIX = 'mi-lock-console.passwords.v1';
const STATUS_PROP = /lock-state|door-lock-state|^door-state$|contact-state|battery-level|^lock-mah$|^keypad-mah$|battery-percent|electric-power|wifi-status|ble-state|ble-signal|keypad-state|close-door-lock|unlock-auto-lock/i;
const OVERVIEW_STATUS_PROP = /lock-state|door-lock-state|^door-state$|contact-state|battery-level|^lock-mah$|^keypad-mah$|battery-percent|electric-power/i;
const CLEAR_STATE_LABELS: Record<string, Record<string, string>> = {
  'door-state': { '0': '门已打开', '1': '门已关闭', '2': '未检测到门状态' },
  'keypad-state': { '0': '键盘未绑定', '1': '已绑定（正常）', '2': '已拆卸（异常）' },
  'lock-state': { '0': '门锁已上锁', '1': '门锁已解锁', '2': '锁舌已伸出', '3': '门锁状态异常' },
  'ble-signal': { '0': '信号弱', '1': '信号一般', '2': '信号强' },
};

const LockIcon = ({ open = false }: { open?: boolean }) => <svg className="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect width="18" height="11" x="3" y="11" rx="2" />
  {open ? <path d="M7 11V7a5 5 0 0 1 9.9-1" /> : <path d="M7 11V7a5 5 0 0 1 10 0v4" />}
</svg>;
const UnconfiguredLockIcon = () => <svg className="unconfigured-lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect width="13" height="10" x="3" y="11" rx="2" />
  <path d="M6.5 11V7.5a3 3 0 0 1 6 0V9" />
  <path d="M19 7v6M16 10h6" />
</svg>;
const PlusIcon = () => <svg className="plus-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
  <path d="M12 5v14M5 12h14" />
</svg>;
type RoomGroup = { key: string; homeId: string; homeName: string; roomId: string; roomName: string; devices: XiaomiDevice[] };
type Building = { id: string; name: string; rooms: RoomGroup[] };
type HomeCatalog = XiaomiInventory['homes'];
type RoomSnapshot = { lockState: string; battery: string; keypadBattery: string; doorState: string; updatedAt: number; error?: string };
type PropertyReadResult = { siid: number; piid: number; value?: unknown; code?: number };
type ConsoleRoute = { region: XiaomiRegion; homeId?: string; roomId?: string; lockDid?: string };

function decodePathPart(value: string | undefined) {
  if (!value) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function parseConsoleRoute(pathname: string, fallbackRegion: XiaomiRegion = 'JP'): ConsoleRoute {
  const parts = pathname.split('/').filter(Boolean);
  const region: XiaomiRegion = parts[0]?.toLowerCase() === 'cn' ? 'CN' : parts[0]?.toLowerCase() === 'jp' ? 'JP' : fallbackRegion;
  const apartmentIndex = parts.indexOf('apartments');
  const roomIndex = parts.indexOf('rooms');
  const lockIndex = parts.indexOf('locks');
  return {
    region,
    homeId: apartmentIndex >= 0 ? decodePathPart(parts[apartmentIndex + 1]) : undefined,
    roomId: roomIndex >= 0 ? decodePathPart(parts[roomIndex + 1]) : undefined,
    lockDid: lockIndex >= 0 ? decodePathPart(parts[lockIndex + 1]) : undefined,
  };
}

function consolePath(region: XiaomiRegion, homeId?: string, roomId?: string, lockDid?: string) {
  let path = `/${region.toLowerCase()}`;
  if (!homeId) return path;
  path += `/apartments/${encodeURIComponent(homeId)}`;
  if (!roomId) return path;
  path += `/rooms/${encodeURIComponent(roomId)}`;
  if (lockDid) path += `/locks/${encodeURIComponent(lockDid)}`;
  return path;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

function propertyLabel(property: SpecProperty) {
  const labels: Record<string, string> = {
    'lock-state': '门锁状态', 'door-state': '门状态', 'battery-level': '电量', 'auto-lock': '自动上锁',
    'lock-mah': '门锁电量', 'keypad-mah': '键盘电量', 'wifi-status': 'Wi-Fi 状态', 'ble-state': '蓝牙状态',
    'ble-signal': '蓝牙信号', 'keypad-state': '键盘状态', 'close-door-lock': '关门自动上锁',
    'unlock-auto-lock': '解锁后自动上锁', 'lock-key-state': '锁定键', 'forbidden-keypad-s': '禁用键盘',
    'close-door-enable': '关门检测', 'voice-unlock': '语音解锁', backlight: '键盘背光',
    'away-mode': '离家模式', 'child-lock': '童锁', volume: '操作提示音', alert: '异常提醒',
  };
  return labels[property.name] || property.description || property.name;
}

function readableValue(property: SpecProperty | undefined, value: unknown) {
  if (value === undefined || value === null) return '—';
  const clearLabel = property && CLEAR_STATE_LABELS[property.name]?.[String(value)];
  if (clearLabel) return clearLabel;
  const mapped = property?.valueList?.find((entry) => String(entry.value) === String(value));
  if (mapped) return mapped.description;
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (property && /battery|mah|electric-power/i.test(property.name)) return `${value}%`;
  return String(value);
}

function getProp(spec: DeviceSpec | null, pattern: RegExp) {
  return spec?.properties.find((property) => pattern.test(property.name));
}

function propertyRows(result: unknown): PropertyReadResult[] {
  if (Array.isArray(result)) return result as PropertyReadResult[];
  if (!result || typeof result !== 'object') return [];
  const object = result as { list?: unknown; properties?: unknown };
  if (Array.isArray(object.list)) return object.list as PropertyReadResult[];
  if (Array.isArray(object.properties)) return object.properties as PropertyReadResult[];
  return [];
}

function actionOutput(result: unknown, action: SpecAction, piid: number) {
  const reply = Array.isArray(result) ? result[0] : result;
  if (!reply || typeof reply !== 'object') return undefined;
  const out = (reply as { out?: unknown[] }).out ?? [];
  for (const [index, item] of out.entries()) {
    const object = item && typeof item === 'object' ? item as { piid?: number; value?: unknown } : undefined;
    if ((object?.piid ?? action.outputPiids[index]) === piid) return object && 'value' in object ? object.value : item;
  }
  return undefined;
}

function waitFor(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function groupBuildings(devices: XiaomiDevice[], catalog: HomeCatalog = []): Building[] {
  const homes = new Map<string, { name: string; rooms: Map<string, RoomGroup> }>();
  for (const home of catalog) {
    const rooms = new Map<string, RoomGroup>();
    for (const room of home.rooms) {
      const key = `${home.id}:${room.id}`;
      rooms.set(key, { key, homeId: home.id, homeName: home.name, roomId: room.id, roomName: room.name, devices: [] });
    }
    homes.set(home.id, { name: home.name, rooms });
  }
  for (const device of devices) {
    const homeId = device.home_id || 'unknown-home';
    const roomId = device.room_id || 'unassigned';
    if (!homes.has(homeId)) homes.set(homeId, { name: device.home_name || `公寓楼 ${homeId}`, rooms: new Map() });
    const home = homes.get(homeId)!;
    const roomKey = `${homeId}:${roomId}`;
    if (!home.rooms.has(roomKey)) home.rooms.set(roomKey, {
      key: roomKey, homeId, homeName: home.name, roomId, roomName: device.room_name || `房间 ${roomId}`, devices: [],
    });
    home.rooms.get(roomKey)!.devices.push(device);
  }
  return Array.from(homes, ([id, home]) => ({ id, name: home.name, rooms: Array.from(home.rooms.values()).sort((a, b) => a.roomName.localeCompare(b.roomName, 'zh-CN', { numeric: true })) }));
}

function isLockDevice(device: XiaomiDevice) {
  return /lock|door|门锁|ロック/i.test(`${device.model} ${device.name}`);
}

function roomLocks(room: RoomGroup | undefined) {
  return room?.devices.filter(isLockDevice) ?? [];
}

function isKeypadDevice(device: XiaomiDevice) {
  return /keypad|keyboard|键盘|キーパッド/i.test(`${device.model} ${device.name}`);
}

function roomKeypads(room: RoomGroup | undefined) {
  return room?.devices.filter((device) => !isLockDevice(device) && isKeypadDevice(device)) ?? [];
}

function roomKeypad(room: RoomGroup | undefined, lock?: XiaomiDevice) {
  const keypads = roomKeypads(room);
  if (!lock) return keypads[0];
  return keypads.find((device) => device.parent_id === lock.did)
    ?? (roomLocks(room).length === 1 ? keypads[0] : undefined);
}

function keypadParentLock(room: RoomGroup | undefined, keypad: XiaomiDevice) {
  const locks = roomLocks(room);
  return locks.find((lock) => keypad.parent_id === lock.did)
    ?? (locks.length === 1 ? locks[0] : undefined);
}

function hasIntegratedKeypad(snapshot: RoomSnapshot | undefined) {
  return Boolean(snapshot && snapshot.keypadBattery !== '—' && !snapshot.error);
}

export default function LockConsole() {
  const [auth, setAuth] = useState<XiaomiAuth | null>(null);
  const [region, setRegion] = useState<XiaomiRegion>('JP');
  const [devices, setDevices] = useState<XiaomiDevice[]>([]);
  const [homeCatalog, setHomeCatalog] = useState<HomeCatalog>([]);
  const [selectedHomeId, setSelectedHomeId] = useState('');
  const [selectedRoomKey, setSelectedRoomKey] = useState('all');
  const [selectedLockDid, setSelectedLockDid] = useState('');
  const [roomQuery, setRoomQuery] = useState('');
  const [spec, setSpec] = useState<DeviceSpec | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [readFailures, setReadFailures] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginMode, setLoginMode] = useState<'password' | 'qr'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginProgress, setLoginProgress] = useState('');
  const [qr, setQr] = useState<{ id: string; qrUrl: string; loginUrl: string; expiresAt: number } | null>(null);
  const [qrState, setQrState] = useState('');
  const [confirmAction, setConfirmAction] = useState<SpecAction | null>(null);
  const [, setConfirmError] = useState('');
  const [roomSnapshots, setRoomSnapshots] = useState<Record<string, RoomSnapshot>>({});
  const [snapshotLoading, setSnapshotLoading] = useState<Record<string, boolean>>({});
  const [passwordManagerOpen, setPasswordManagerOpen] = useState(false);
  const [passwordPin, setPasswordPin] = useState('');
  const [passwordUserName, setPasswordUserName] = useState('');
  const [passwordName, setPasswordName] = useState('');
  const [passwordUserTarget, setPasswordUserTarget] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [managedPasswords, setManagedPasswords] = useState<XiaomiLockCloudPassword[]>([]);
  const [managedPasswordUsers, setManagedPasswordUsers] = useState<XiaomiLockCloudUser[]>([]);
  const [passwordSyncing, setPasswordSyncing] = useState(false);
  const [passwordSyncedAt, setPasswordSyncedAt] = useState<number | null>(null);
  const [deletePasswordTarget, setDeletePasswordTarget] = useState<XiaomiLockCloudPassword | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedOverviewKeys = useRef(new Set<string>());
  const passwordSyncRequest = useRef(0);
  const regionName = region === 'CN' ? '中国' : '日本';

  const buildings = useMemo(() => groupBuildings(devices, homeCatalog), [devices, homeCatalog]);
  const currentBuilding = buildings.find((building) => building.id === selectedHomeId) ?? buildings[0];
  const currentRoom = selectedRoomKey === 'all' ? undefined : currentBuilding?.rooms.find((room) => room.key === selectedRoomKey);
  const currentRoomLocks = roomLocks(currentRoom);
  const currentRoomKeypads = roomKeypads(currentRoom);
  const currentRoomIntegratedKeypadLocks = currentRoomLocks.filter((lock) => !roomKeypad(currentRoom, lock) && hasIntegratedKeypad(roomSnapshots[lock.did]));
  const currentRoomKeypadCount = currentRoomKeypads.length + currentRoomIntegratedKeypadLocks.length;
  const selected = currentRoomLocks.find((lock) => lock.did === selectedLockDid);
  const selectedDid = selected?.did;
  const selectedModel = selected?.model;
  const filteredRooms = currentBuilding?.rooms.filter((room) => room.roomName.toLowerCase().includes(roomQuery.toLowerCase())) ?? [];
  const passwordUsers = managedPasswordUsers;
  const currentBuildingStatusKey = currentBuilding
    ? `${currentBuilding.id}:${currentBuilding.rooms.flatMap(roomLocks).map((lock) => lock.did).join(',')}`
    : '';

  const applyConsoleRoute = useCallback((route: ConsoleRoute, sourceBuildings: Building[]) => {
    const building = sourceBuildings.find((entry) => entry.id === route.homeId) ?? sourceBuildings[0];
    const room = route.roomId ? building?.rooms.find((entry) => entry.roomId === route.roomId) : undefined;
    const locks = roomLocks(room);
    const lock = route.lockDid ? locks.find((entry) => entry.did === route.lockDid) : undefined;
    setSelectedHomeId(building?.id || '');
    setSelectedRoomKey(room?.key || 'all');
    setSelectedLockDid(lock?.did || '');
    return { building, room, lock };
  }, []);

  const updateBrowserPath = useCallback((path: string, mode: 'push' | 'replace' = 'push') => {
    if (window.location.pathname === path) return;
    window.history[mode === 'replace' ? 'replaceState' : 'pushState']({ miLockConsole: true }, '', path);
  }, []);

  useEffect(() => {
    if (!error && !message) return;
    const timeout = window.setTimeout(() => { setError(''); setMessage(''); }, error ? 8000 : 4500);
    return () => window.clearTimeout(timeout);
  }, [error, message]);

  const rpc = useCallback(async <T,>(payload: Record<string, unknown>) => {
    if (!auth) throw new Error('请先登录');
    const response = await api<{ result: T; auth?: XiaomiAuth }>('/api/mi/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auth, ...payload }),
    });
    if (response.auth) {
      localStorage.setItem(AUTH_KEY, JSON.stringify(response.auth));
      setAuth(response.auth);
    }
    return response.result;
  }, [auth]);

  const loadCloudPasswords = useCallback(async (did: string, model: string, notifyOnError = true) => {
    const requestId = ++passwordSyncRequest.current;
    setPasswordSyncing(true);
    setPasswordError('');
    try {
      const result = await rpc<XiaomiLockCloudPasswordList>({ op: 'passwordList', did, model });
      if (requestId === passwordSyncRequest.current) {
        setManagedPasswords(result.entries);
        setManagedPasswordUsers(result.users);
        setPasswordSyncedAt(result.syncedAt);
      }
      return result;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '米家云密码列表读取失败';
      if (requestId === passwordSyncRequest.current) {
        setManagedPasswords([]);
        setManagedPasswordUsers([]);
        setPasswordSyncedAt(null);
        setPasswordError(reason);
        if (notifyOnError) setError(reason);
      }
      throw cause;
    } finally {
      if (requestId === passwordSyncRequest.current) setPasswordSyncing(false);
    }
  }, [rpc]);

  const readLockSnapshot = useCallback(async (lock: XiaomiDevice): Promise<RoomSnapshot> => {
    const nextSpec = await rpc<DeviceSpec>({ op: 'spec', model: lock.model, did: lock.did });
    const readable = nextSpec.properties.filter((property) => property.rw.includes('r') && OVERVIEW_STATUS_PROP.test(property.name));
    const nextValues: Record<string, unknown> = {};

    if (readable.length) {
      const result = await rpc<unknown>({
        op: 'properties', model: lock.model,
        params: readable.map((property) => ({ did: lock.did, siid: property.siid, piid: property.piid })),
      });
      for (const row of propertyRows(result)) {
        if (row.code === undefined || row.code === 0) nextValues[`${row.siid}.${row.piid}`] = row.value;
      }
    }

    const batteryProperties = nextSpec.properties.filter((property) => /battery-level|^lock-mah$|^keypad-mah$|battery-percent|electric-power/i.test(property.name));
    for (const batteryProperty of batteryProperties) {
      const batteryKey = `${batteryProperty.siid}.${batteryProperty.piid}`;
      if (nextValues[batteryKey] === undefined && (batteryProperty.name === 'lock-mah' || batteryProperty.name === 'keypad-mah')) {
        const actionName = batteryProperty.name === 'lock-mah' ? 'check-lock-mah' : 'check-keypad-mah';
        const batteryAction = nextSpec.actions.find((action) => action.siid === batteryProperty.siid && action.name === actionName);
        if (batteryAction) {
          const batteryResult = await rpc<unknown>({
            op: 'action', model: lock.model, did: lock.did, siid: batteryAction.siid, aiid: batteryAction.aiid, values: [],
          });
          const batteryValue = actionOutput(batteryResult, batteryAction, batteryProperty.piid);
          if (batteryValue !== undefined) nextValues[batteryKey] = batteryValue;
        }
      }
    }

    const snapshotValue = (pattern: RegExp) => {
      const property = nextSpec.properties.find((entry) => pattern.test(entry.name));
      return property ? readableValue(property, nextValues[`${property.siid}.${property.piid}`]) : '—';
    };
    return {
      lockState: snapshotValue(/lock-state|door-lock-state/i),
      battery: snapshotValue(/battery-level|^lock-mah$|battery-percent|electric-power/i),
      keypadBattery: snapshotValue(/^keypad-mah$/i),
      doorState: snapshotValue(/^door-state$|contact-state/i),
      updatedAt: Date.now(),
    };
  }, [rpc]);

  const loadOverviewSnapshots = useCallback(async (rooms: RoomGroup[]) => {
    const targets = rooms.flatMap(roomLocks);
    if (!targets.length) return;
    setSnapshotLoading((current) => ({ ...current, ...Object.fromEntries(targets.map((lock) => [lock.did, true])) }));
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < targets.length) {
        const lock = targets[nextIndex++];
        try {
          const snapshot = await readLockSnapshot(lock);
          setRoomSnapshots((current) => ({ ...current, [lock.did]: snapshot }));
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : '状态读取失败';
          setRoomSnapshots((current) => ({ ...current, [lock.did]: {
            lockState: '读取失败', battery: '—', keypadBattery: '—', doorState: '—', updatedAt: Date.now(), error: reason,
          } }));
        } finally {
          setSnapshotLoading((current) => {
            const next = { ...current };
            delete next[lock.did];
            return next;
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
  }, [readLockSnapshot]);

  const loadDevices = useCallback(async () => {
    if (!auth) return;
    setLoading(true); setError('');
    try {
      const result = await rpc<XiaomiInventory>({ op: 'devices' });
      const grouped = groupBuildings(result.devices, result.homes);
      setDevices(result.devices); setHomeCatalog(result.homes);
      const route = parseConsoleRoute(window.location.pathname, region);
      const resolved = applyConsoleRoute(route, grouped);
      updateBrowserPath(consolePath(region, resolved.building?.id, resolved.room?.roomId, resolved.lock?.did), 'replace');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '设备同步失败'); }
    finally { setLoading(false); }
  }, [applyConsoleRoute, auth, region, rpc, updateBrowserPath]);

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const loadSelected = useCallback(async (): Promise<RoomSnapshot | undefined> => {
    if (!selectedDid || !selectedModel || !auth) { setSpec(null); setValues({}); setReadFailures({}); return; }
    setLoading(true); setError('');
    try {
      const nextSpec = await rpc<DeviceSpec>({ op: 'spec', model: selectedModel, did: selectedDid });
      setSpec(nextSpec);
      // Warm the one-time lock token while visible status is being read. The
      // control buttons become available only after both tasks have settled.
      void rpc({ op: 'prepareAction', model: selectedModel, did: selectedDid }).catch(() => undefined);
      const readable = nextSpec.properties.filter((property) => property.rw.includes('r') && STATUS_PROP.test(property.name));
      if (!readable.length) { setValues({}); setReadFailures({}); return; }
      const result = await rpc<unknown>({
        op: 'properties', model: selectedModel,
        params: readable.map((property) => ({ did: selectedDid, siid: property.siid, piid: property.piid })),
      });
      const rows = propertyRows(result);
      const nextValues = Object.fromEntries(rows.filter((item) => item.code === undefined || item.code === 0).map((item) => [`${item.siid}.${item.piid}`, item.value]));
      const failures: Record<string, string> = {};
      for (const property of readable) {
        const key = `${property.siid}.${property.piid}`;
        const row = rows.find((item) => item.siid === property.siid && item.piid === property.piid);
        if (!row) failures[key] = '米家云未返回此属性';
        else if (typeof row.code === 'number' && row.code !== 0) failures[key] = `MIoT ${row.code}`;
      }

      const batteryProperties = nextSpec.properties.filter((property) => property.name === 'lock-mah' || property.name === 'keypad-mah');
      for (const batteryProperty of batteryProperties) {
        const batteryKey = `${batteryProperty.siid}.${batteryProperty.piid}`;
        if (nextValues[batteryKey] !== undefined) continue;
        const actionName = batteryProperty.name === 'lock-mah' ? 'check-lock-mah' : 'check-keypad-mah';
        const batteryAction = nextSpec.actions.find((action) => action.siid === batteryProperty.siid && action.name === actionName);
        if (batteryAction) {
          try {
            const batteryResult = await rpc<unknown>({
              op: 'action', model: selectedModel, did: selectedDid, siid: batteryAction.siid, aiid: batteryAction.aiid, values: [],
            });
            const batteryValue = actionOutput(batteryResult, batteryAction, batteryProperty.piid);
            if (batteryValue !== undefined) {
              nextValues[batteryKey] = batteryValue;
              delete failures[batteryKey];
            }
          } catch (cause) {
            failures[batteryKey] = cause instanceof Error ? cause.message : '电量刷新失败';
          }
        }
      }
      const snapshotValue = (pattern: RegExp) => {
        const property = nextSpec.properties.find((entry) => pattern.test(entry.name));
        return property ? readableValue(property, nextValues[`${property.siid}.${property.piid}`]) : '—';
      };
      const nextSnapshot: RoomSnapshot = {
        lockState: snapshotValue(/lock-state|door-lock-state/i),
        battery: snapshotValue(/battery-level|^lock-mah$|battery-percent|electric-power/i),
        keypadBattery: snapshotValue(/^keypad-mah$/i),
        doorState: snapshotValue(/^door-state$|contact-state/i),
        updatedAt: Date.now(),
      };
      setRoomSnapshots((current) => ({ ...current, [selectedDid]: nextSnapshot }));
      setValues(nextValues);
      setReadFailures(failures);
      const coreIssues = nextSpec.properties
        .filter((property) => STATUS_PROP.test(property.name))
        .map((property) => ({ property, reason: failures[`${property.siid}.${property.piid}`] }))
        .filter((entry) => entry.reason);
      if (coreIssues.length) {
        setError(`部分门锁状态读取失败：${coreIssues.map(({ property, reason }) => `${propertyLabel(property)}（${reason}）`).join('、')}`);
      }
      return nextSnapshot;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '设备状态读取失败';
      setError(reason); setValues({}); setReadFailures({ request: reason });
      return undefined;
    }
    finally { setLoading(false); }
  }, [auth, rpc, selectedDid, selectedModel]);
  /* eslint-enable react-hooks/preserve-manual-memoization */

  useEffect(() => {
    queueMicrotask(() => {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key === LEGACY_PASSWORD_META_PREFIX || key?.startsWith(`${LEGACY_PASSWORD_META_PREFIX}.`)) {
          localStorage.removeItem(key);
        }
      }
      const route = parseConsoleRoute(window.location.pathname, region);
      const stored = localStorage.getItem(AUTH_KEY);
      if (stored) {
        try {
          const saved = JSON.parse(stored) as XiaomiAuth;
          const savedRegion: XiaomiRegion = saved.region === 'CN' ? 'CN' : 'JP';
          const initialRegion = /^\/(cn|jp)(\/|$)/i.test(window.location.pathname) ? route.region : savedRegion;
          setRegion(initialRegion);
          setAuth({ ...saved, region: initialRegion });
        } catch { localStorage.removeItem(AUTH_KEY); }
      }
      else { setRegion(route.region); setLoginOpen(true); }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (auth) queueMicrotask(() => void loadDevices()); }, [auth, loadDevices]);
  useEffect(() => {
    if (!auth || !currentBuilding || !currentBuildingStatusKey || loadedOverviewKeys.current.has(currentBuildingStatusKey)) return;
    loadedOverviewKeys.current.add(currentBuildingStatusKey);
    const rooms = currentBuilding.rooms;
    queueMicrotask(() => void loadOverviewSnapshots(rooms));
  }, [auth, currentBuilding, currentBuildingStatusKey, loadOverviewSnapshots]);
  useEffect(() => { queueMicrotask(() => void loadSelected()); }, [selected?.did]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selectedLockDid && currentRoom && !currentRoomLocks.some((lock) => lock.did === selectedLockDid)) {
      queueMicrotask(() => setSelectedLockDid(''));
    }
  }, [currentRoom, currentRoomLocks, selectedLockDid]);
  useEffect(() => {
    queueMicrotask(() => {
      passwordSyncRequest.current += 1;
      setManagedPasswords([]);
      setPasswordSyncedAt(null);
      setPasswordPin('');
      setPasswordError('');
      setDeletePasswordTarget(null);
      if (auth && selectedDid && selectedModel) void loadCloudPasswords(selectedDid, selectedModel).catch(() => undefined);
    });
  }, [auth, loadCloudPasswords, selectedDid, selectedModel]);

  useEffect(() => {
    if (!qr?.id || qrState === 'success' || qrState === 'error') return;
    const controller = new AbortController();
    void (async () => {
      try {
        const state = await api<{ status: string; auth?: XiaomiAuth; error?: string }>(`/api/auth/qr/status?id=${encodeURIComponent(qr.id)}`, { signal: controller.signal });
        setQrState(state.status);
        if (state.status === 'success' && state.auth) {
          const nextAuth = { ...state.auth, region };
          localStorage.setItem(AUTH_KEY, JSON.stringify(nextAuth));
          setAuth(nextAuth); setLoginOpen(false); setQr(null); setMessage(`${regionName}区账号登录成功`);
        } else if (state.status === 'error') setError(state.error || '扫码登录失败');
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '登录状态读取失败');
      }
    })();
    return () => controller.abort();
  }, [qr, qrState, region, regionName]);

  const beginLogin = async () => {
    setLoading(true); setError(''); setLoginProgress('正在创建小米账号授权…'); setQrState('waiting');
    try {
      setQr(await api('/api/auth/qr/start', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region }),
      }));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法创建二维码'); }
    finally { setLoading(false); setLoginProgress(''); }
  };
  const regenerateQr = () => {
    setQr(null); setQrState('waiting'); setError('');
    void beginLogin();
  };
  const loginWithPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true); setError(''); setMessage(''); setLoginProgress(`正在验证账号并建立${regionName}区米家会话…`);
    try {
      const result = await api<{ auth: XiaomiAuth }>('/api/auth/password', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, region }),
      });
      const nextAuth = { ...result.auth, region };
      localStorage.setItem(AUTH_KEY, JSON.stringify(nextAuth));
      setPassword(''); setAuth(nextAuth); setLoginOpen(false); setMessage(`${regionName}区账号登录成功，正在同步设备…`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '账号登录失败'); }
    finally { setLoading(false); setLoginProgress(''); }
  };
  const logout = () => {
    localStorage.removeItem(AUTH_KEY); loadedOverviewKeys.current.clear(); setAuth(null); setDevices([]); setHomeCatalog([]); setSpec(null); setValues({}); setRoomSnapshots({}); setSnapshotLoading({}); setSelectedHomeId(''); setSelectedRoomKey('all'); setSelectedLockDid(''); setLoginOpen(true); setQr(null);
  };

  const switchRegion = (nextRegion: XiaomiRegion) => {
    if (nextRegion === region) return;
    const nextRegionName = nextRegion === 'CN' ? '中国' : '日本';
    updateBrowserPath(consolePath(nextRegion));
    setRegion(nextRegion);
    setQr(null); setQrState(''); setError('');
    loadedOverviewKeys.current.clear();
    setDevices([]); setHomeCatalog([]); setSpec(null); setValues({}); setReadFailures({});
    setRoomSnapshots({}); setSnapshotLoading({}); setSelectedHomeId(''); setSelectedRoomKey('all'); setSelectedLockDid('');
    if (auth) {
      const nextAuth = { ...auth, region: nextRegion };
      localStorage.setItem(AUTH_KEY, JSON.stringify(nextAuth));
      setAuth(nextAuth);
      setMessage(`已切换到${nextRegionName}区，正在重新同步设备…`);
    }
  };

  const refreshCurrentView = () => {
    if (currentRoom) {
      void loadSelected();
      return;
    }
    if (currentBuilding && currentBuildingStatusKey) {
      loadedOverviewKeys.current.add(currentBuildingStatusKey);
      void loadOverviewSnapshots(currentBuilding.rooms);
    }
    void loadDevices();
  };

  const runAction = async (action: SpecAction) => {
    if (!selected || !currentRoom) return;
    setLoading(true); setError(''); setConfirmError('');
    try {
      const result = await rpc<{ code?: number; out?: unknown[] } | Array<{ code?: number; out?: unknown[] }>>({
        op: 'action', model: selected.model, did: selected.did, siid: action.siid, aiid: action.aiid,
      });
      const response = Array.isArray(result) ? result[0] : result;
      if (typeof response?.code === 'number' && response.code !== 0) {
        throw new Error(`门锁拒绝了远程指令（MIoT ${response.code}）`);
      }

      const actionText = `${action.name} ${action.description}`;
      const expectsUnlocked = /unlock|open-door|remote-open|解锁|开锁/i.test(actionText);
      const expectsLocked = !expectsUnlocked && /remote-lock|lock-door|close-lock|(^|\W)lock($|\W)|上锁|锁定/i.test(actionText);
      const verificationDelays = [300, 900, 1800];
      const verifyLatestState = async (attempt: number, previousSnapshot?: RoomSnapshot, previousIssue = ''): Promise<{ snapshot?: RoomSnapshot; confirmed: boolean; issue: string }> => {
        await waitFor(verificationDelays[attempt]);
        try {
          const snapshot = await readLockSnapshot(selected);
          setRoomSnapshots((current) => ({ ...current, [selected.did]: snapshot }));
          const latestUnlocked = /unlock|解锁|开锁/i.test(snapshot.lockState);
          const latestLocked = /上锁|锁舌已伸出|locked/i.test(snapshot.lockState);
          const confirmed = expectsUnlocked ? latestUnlocked : expectsLocked ? latestLocked : true;
          if (confirmed || attempt === verificationDelays.length - 1) return { snapshot, confirmed, issue: '' };
          return verifyLatestState(attempt + 1, snapshot);
        } catch (cause) {
          const issue = cause instanceof Error ? cause.message : '最新状态读取失败';
          if (attempt === verificationDelays.length - 1) return { snapshot: previousSnapshot, confirmed: false, issue };
          return verifyLatestState(attempt + 1, previousSnapshot, issue || previousIssue);
        }
      };
      const verification = await verifyLatestState(0);

      // Refresh the full detail state after the lightweight verification so
      // both the detail panel and overview snapshot reflect the same cloud data.
      const detailSnapshot = await loadSelected();
      const displayedSnapshot = detailSnapshot ?? verification.snapshot;
      const displayedUnlocked = displayedSnapshot ? /unlock|解锁|开锁/i.test(displayedSnapshot.lockState) : false;
      const displayedLocked = displayedSnapshot ? /上锁|锁舌已伸出|locked/i.test(displayedSnapshot.lockState) : false;
      const displayedStateConfirmed = expectsUnlocked ? displayedUnlocked : expectsLocked ? displayedLocked : Boolean(displayedSnapshot);
      setConfirmAction(null);
      if (!displayedSnapshot) {
        setError(`${currentRoom.roomName} · ${selected.name}：指令已被门锁接受，但最新状态读取失败${verification.issue ? `（${verification.issue}）` : ''}，请稍后刷新确认。`);
      } else if (!displayedStateConfirmed) {
        setError(`${currentRoom.roomName} · ${selected.name}：指令已被门锁接受，但云端最新状态仍为“${displayedSnapshot.lockState}”。页面已按真实状态更新，请稍后再次刷新。`);
      } else {
        setMessage(`${currentRoom.roomName} · ${selected.name}：${action.description}成功，最新状态为“${displayedSnapshot.lockState}”`);
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '操作失败';
      setConfirmError(reason); setError(reason);
    }
    finally { setLoading(false); }
  };

  const openActionConfirm = (action: SpecAction) => {
    setConfirmError('');
    setConfirmAction(action);
  };

  const closeActionConfirm = () => {
    setConfirmError('');
    setConfirmAction(null);
  };

  const selectRoom = (room: RoomGroup) => {
    setSelectedRoomKey(room.key);
    setSelectedLockDid('');
    updateBrowserPath(consolePath(region, room.homeId, room.roomId));
  };

  const selectLock = (room: RoomGroup, lock: XiaomiDevice) => {
    setSelectedRoomKey(room.key);
    setSelectedLockDid(lock.did);
    updateBrowserPath(consolePath(region, room.homeId, room.roomId, lock.did));
  };

  useEffect(() => {
    const handleBrowserNavigation = () => {
      const route = parseConsoleRoute(window.location.pathname, region);
      setPasswordManagerOpen(false); setDeletePasswordTarget(null); setConfirmAction(null);
      if (route.region !== region) {
        setRegion(route.region);
        loadedOverviewKeys.current.clear();
        setDevices([]); setHomeCatalog([]); setSpec(null); setValues({}); setReadFailures({});
        setRoomSnapshots({}); setSnapshotLoading({}); setSelectedHomeId(''); setSelectedRoomKey('all'); setSelectedLockDid('');
        if (auth) {
          const nextAuth = { ...auth, region: route.region };
          localStorage.setItem(AUTH_KEY, JSON.stringify(nextAuth));
          setAuth(nextAuth);
        }
        return;
      }
      const resolved = applyConsoleRoute(route, buildings);
      if (resolved.building) updateBrowserPath(consolePath(region, resolved.building.id, resolved.room?.roomId, resolved.lock?.did), 'replace');
    };
    window.addEventListener('popstate', handleBrowserNavigation);
    return () => window.removeEventListener('popstate', handleBrowserNavigation);
  }, [applyConsoleRoute, auth, buildings, region, updateBrowserPath]);

  const unlockAction = spec?.actions.find((action) => /unlock|open-door|remote-open/i.test(action.name));
  const lockAction = spec?.actions.find((action) => !/unlock/i.test(action.name) && /remote-lock|lock-door|close-lock|^lock$/i.test(action.name));
  const createPasswordAction = spec?.actions.find((action) => action.name === 'edit-user-password');
  const passwordManagementSupported = Boolean(createPasswordAction);
  const lockStateProp = getProp(spec, /lock-state|door-lock-state/i);
  const doorStateProp = getProp(spec, /^door-state$|contact-state/i);
  const batteryProp = getProp(spec, /battery-level|^lock-mah$|battery-percent|electric-power/i);
  const keypadBatteryProp = getProp(spec, /^keypad-mah$/i);
  const wifiStatusProp = getProp(spec, /^wifi-status$/i);
  const bleStateProp = getProp(spec, /^ble-state$/i);
  const bleSignalProp = getProp(spec, /^ble-signal$/i);
  const keypadStateProp = getProp(spec, /^keypad-state$/i);
  const closeDoorLockProp = getProp(spec, /^close-door-lock$/i);
  const unlockAutoLockProp = getProp(spec, /^unlock-auto-lock$/i);

  const propertyStatus = (property: SpecProperty | undefined, trueText = '开启', falseText = '关闭') => {
    if (!property) return { value: '不支持', reason: '' };
    const key = `${property.siid}.${property.piid}`;
    const value = values[key];
    if (value === undefined) return { value: readFailures[key] ? '读取失败' : '—', reason: readFailures[key] || '' };
    if (typeof value === 'boolean') return { value: value ? trueText : falseText, reason: '' };
    return { value: readableValue(property, value), reason: '' };
  };

  const lockStatus = propertyStatus(lockStateProp);
  const doorStatus = propertyStatus(doorStateProp);
  const lockBatteryStatus = propertyStatus(batteryProp);
  const keypadBatteryStatus = propertyStatus(keypadBatteryProp);
  const wifiStatus = propertyStatus(wifiStatusProp, '已连接', '未连接');
  const bleStatus = propertyStatus(bleStateProp, '已连接', '未连接');
  const bleSignalStatus = propertyStatus(bleSignalProp);
  const keypadStatus = propertyStatus(keypadStateProp);
  const closeDoorStatus = propertyStatus(closeDoorLockProp);
  const unlockAutoStatus = propertyStatus(unlockAutoLockProp);
  const autoLockValue = closeDoorLockProp && unlockAutoLockProp
    ? `${closeDoorStatus.value === '开启' ? '关门后' : ''}${closeDoorStatus.value === '开启' && unlockAutoStatus.value === '开启' ? '、' : ''}${unlockAutoStatus.value === '开启' ? '解锁后' : ''}` || '已关闭'
    : closeDoorStatus.value !== '不支持' ? closeDoorStatus.value : unlockAutoStatus.value;
  const autoLockReason = closeDoorStatus.reason || unlockAutoStatus.reason;
  const lockState = lockStateProp ? lockStatus.value : selected ? '无状态属性' : '—';
  const statusItems = [
    { key: 'lock', property: lockStateProp, icon: '▣', label: '门锁状态', value: lockStatus.value, reason: lockStatus.reason },
    { key: 'door', property: doorStateProp, icon: '▯', label: '门状态', value: doorStatus.value, reason: doorStatus.reason },
    { key: 'wifi', property: wifiStatusProp, icon: 'Wi', label: 'Wi-Fi 状态', value: wifiStatus.value, reason: wifiStatus.reason },
    { key: 'ble', property: bleStateProp, icon: 'B', label: '键盘蓝牙', value: `${bleStatus.value}${bleSignalStatus.value !== '不支持' && bleSignalStatus.value !== '—' ? ` · ${bleSignalStatus.value}` : ''}`, reason: bleStatus.reason || bleSignalStatus.reason },
    { key: 'lock-battery', property: batteryProp, icon: '🔋', label: '门锁电量', value: lockBatteryStatus.value, reason: lockBatteryStatus.reason },
    { key: 'keypad-battery', property: keypadBatteryProp, icon: '🔋', label: '键盘电量', value: keypadBatteryStatus.value, reason: keypadBatteryStatus.reason },
    { key: 'keypad', property: keypadStateProp, icon: '⌨️', label: '键盘状态', value: keypadStatus.value, reason: keypadStatus.reason },
    { key: 'auto-lock', property: closeDoorLockProp ?? unlockAutoLockProp, icon: '↻', label: '自动上锁', value: autoLockValue, reason: autoLockReason },
  ].filter((item) => item.property);
  const isUnlocked = /unlock|开|解锁/i.test(lockState);
  const startHold = () => {
    if (!unlockAction) { setError('该设备规格未公开远程解锁动作。'); return; }
    holdTimer.current = setTimeout(() => openActionConfirm(unlockAction), 1600);
  };
  const cancelHold = () => { if (holdTimer.current) clearTimeout(holdTimer.current); holdTimer.current = null; };
  const buildingLocks = currentBuilding?.rooms.flatMap(roomLocks) ?? [];
  const onlineLockCount = buildingLocks.filter((lock) => lock.online !== false).length;
  const currentDeviceCount = currentBuilding?.rooms.reduce((sum, room) => sum + room.devices.length, 0) ?? 0;
  const lockCount = buildingLocks.length;
  const keypadCount = currentBuilding?.rooms.reduce((sum, room) => {
    const externalKeypads = roomKeypads(room);
    const integratedKeypads = roomLocks(room).filter((lock) => !roomKeypad(room, lock) && hasIntegratedKeypad(roomSnapshots[lock.did])).length;
    return sum + externalKeypads.length + integratedKeypads;
  }, 0) ?? 0;

  const openPasswordManager = () => {
    if (!passwordManagementSupported) {
      setError('当前门锁没有公开用户永久密码管理能力。');
      return;
    }
    setPasswordError('');
    setPasswordPin('');
    setPasswordUserName('');
    setPasswordName('');
    setPasswordUserTarget('');
    setDeletePasswordTarget(null);
    setPasswordManagerOpen(true);
  };

  const createManagedPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !passwordManagementSupported) return;
    const nextUserName = passwordUserName.trim();
    const nextPasswordName = passwordName.trim();
    if (!passwordUserTarget) { setPasswordError('请选择要添加到已有用户，或新增一个用户'); setError('请选择密码所属用户'); return; }
    if (passwordUserTarget === 'new' && (!nextUserName || nextUserName.length > 32)) { setPasswordError('请输入 1–32 个字符的用户名称'); setError('请输入有效的用户名称'); return; }
    if (!nextPasswordName || nextPasswordName.length > 32) { setPasswordError('请输入 1–32 个字符的密码名称'); setError('请输入有效的密码名称'); return; }
    if (!/^\d{6}$/.test(passwordPin)) { setPasswordError('请输入完整的 6 位数字密码'); setError('请输入完整的 6 位数字密码'); return; }
    setLoading(true); setPasswordError(''); setError('');
    try {
      const addingNewUser = passwordUserTarget === 'new';
      const selectedUserId = addingNewUser ? undefined : Number(passwordUserTarget.replace('user:', ''));
      const result = await rpc<{ userId: number; userName?: string; passwordId: number; passwordName: string; createdAt: number }>({
        op: 'password', mode: 'create', model: selected.model, did: selected.did, pin: passwordPin,
        userName: addingNewUser ? nextUserName : '',
        passwordName: nextPasswordName,
        userMode: addingNewUser ? 'new' : 'existing',
        userId: selectedUserId,
      });
      setPasswordPin('');
      let confirmed = false;
      for (const delay of [400, 800, 1400, 2200, 3000]) {
        await waitFor(delay);
        const cloud = await loadCloudPasswords(selected.did, selected.model, false);
        const passwordConfirmed = cloud.entries.some((entry) => entry.userId === result.userId
          && entry.passwordId === result.passwordId && entry.name === result.passwordName);
        const userConfirmed = !addingNewUser || cloud.users.some((user) => user.userId === result.userId && user.name === result.userName);
        confirmed = passwordConfirmed && userConfirmed;
        if (confirmed) break;
      }
      if (!confirmed) throw new Error('门锁已接收创建和命名请求，但米家云端尚未返回完全一致的记录；页面不会生成本地记录，请稍后重新同步');
      setPasswordUserName('');
      setPasswordName('');
      setPasswordUserTarget('');
      setPasswordManagerOpen(false);
      setMessage(`${currentRoom?.roomName} · ${selected.name}：永久密码已创建，并已从米家云端确认`);
    } catch (cause) { const reason = cause instanceof Error ? cause.message : '密码创建失败'; setPasswordError(reason); setError(reason); }
    finally { setPasswordPin(''); setLoading(false); }
  };

  const deleteManagedPassword = async (entry: XiaomiLockCloudPassword) => {
    if (!selected || entry.passwordId === null || !entry.deletable) return;
    setLoading(true); setPasswordError(''); setError('');
    try {
      await rpc({
        op: 'password', mode: 'delete', model: selected.model, did: selected.did,
        userId: entry.userId, passwordId: entry.passwordId,
      });
      let confirmed = false;
      let lastSyncError: unknown;
      // D100 password mutations commonly return "asynchronous success". The
      // server asks the lock to publish fresh user data after the mutation;
      // keep reading the cloud-authoritative list until that publish arrives.
      for (const delay of [0, 500, 900, 1500, 2500, 4000, 6000, 8000]) {
        if (delay) await waitFor(delay);
        try {
          const cloud = await loadCloudPasswords(selected.did, selected.model, false);
          confirmed = !cloud.entries.some((item) => item.key === entry.key);
          if (confirmed) break;
        } catch (cause) {
          lastSyncError = cause;
        }
      }
      if (!confirmed) {
        if (lastSyncError instanceof Error) throw lastSyncError;
        throw new Error('设备已接收删除，但尚未发布新的用户数据同步事件；页面未伪造删除结果，请稍后点击刷新确认');
      }
      setDeletePasswordTarget(null);
      setMessage(`${currentRoom?.roomName} · ${selected.name}：${entry.name} 已删除，并已从米家云端确认`);
    } catch (cause) { const reason = cause instanceof Error ? cause.message : '密码删除失败'; setPasswordError(reason); setError(reason); }
    finally { setLoading(false); }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar apartment-sidebar">
        <div className="brand"><span className="brand-mark">M</span><span>Mi Apartments</span></div>
        <div className="building-picker">
          <p className="nav-label">公寓楼</p>
          <select value={currentBuilding?.id || ''} onChange={(event) => { const homeId = event.target.value; setSelectedHomeId(homeId); setSelectedRoomKey('all'); setSelectedLockDid(''); setRoomQuery(''); updateBrowserPath(consolePath(region, homeId)); }} aria-label="选择公寓楼">
            {buildings.map((building) => <option key={building.id} value={building.id}>{building.name} · {building.rooms.length} 间</option>)}
          </select>
        </div>
        <nav className="device-nav room-nav" aria-label="房间">
          <div className="room-nav-head"><p className="nav-label">房间</p><span>{currentBuilding?.rooms.length || 0}</span></div>
          <button className={`room-item overview ${selectedRoomKey === 'all' ? 'active' : ''}`} onClick={() => { setSelectedRoomKey('all'); setSelectedLockDid(''); updateBrowserPath(consolePath(region, currentBuilding?.id)); }}><span className="room-number">⌂</span><span><strong>所有房间</strong><small>查看整栋状态</small></span></button>
          <div className="room-list">
            {currentBuilding?.rooms.map((room) => {
              const locks = roomLocks(room); const externalKeypads = roomKeypads(room); const integratedKeypads = locks.filter((lock) => !roomKeypad(room, lock) && hasIntegratedKeypad(roomSnapshots[lock.did])).length; const roomKeypadCount = externalKeypads.length + integratedKeypads; const relevantDeviceCount = locks.length + roomKeypadCount; const onlineDevices = [...locks, ...externalKeypads].filter((entry) => entry.online !== false).length;
              return <button key={room.key} className={`room-item ${!relevantDeviceCount ? 'unavailable' : ''} ${selectedRoomKey === room.key ? 'active' : ''}`} onClick={() => relevantDeviceCount && selectRoom(room)} disabled={!relevantDeviceCount} title={!relevantDeviceCount ? '未配置门锁或密码键盘' : `管理 ${locks.length} 把门锁和 ${roomKeypadCount} 个键盘`}>
                <span className="room-number">{room.roomName.match(/\d+/)?.[0] || room.roomName.slice(0, 2)}</span>
                <span><strong>{room.roomName}</strong><small>{relevantDeviceCount ? `${locks.length} 门锁 · ${roomKeypadCount} 键盘` : '暂无门锁设备'}</small></span>
                <i className={`status-dot ${relevantDeviceCount ? onlineDevices ? '' : 'offline' : 'neutral'}`} />
              </button>;
            })}
          </div>
          {!devices.length && <p className="empty-nav">{auth ? '正在同步公寓与房间…' : '登录后显示公寓楼'}</p>}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">{currentRoom ? `${currentBuilding?.name || `${regionName}区公寓`} · ${currentRoom.roomName}` : `${regionName}区 · 公寓管理`}</p><h1>{currentRoom ? selected ? `${selected.name} · ${lockState}` : `${currentRoom.roomName} · 设备管理` : currentBuilding?.name || `连接你的${regionName}区米家账号`}</h1></div>
          <div className="top-actions"><label className="region-pill region-select" aria-label={`当前区域：${regionName}`}><span>{region}</span><select value={region} onChange={(event) => switchRegion(event.target.value as XiaomiRegion)}><option value="JP">日本</option><option value="CN">中国</option></select></label><button className="icon-button" aria-label="刷新" onClick={refreshCurrentView} disabled={loading}>↻</button><button className="avatar" onClick={() => auth ? logout() : setLoginOpen(true)} aria-label={auth ? '退出登录' : '登录'}>{auth ? 'K' : '?'}</button></div>
        </header>
        {(error || message) && <aside className="notification-region" aria-live="polite"><div className={`notice ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}><span>{error ? '!' : '✓'}</span><div><strong>{error ? '操作未完成' : '操作完成'}</strong><p>{error || message}</p></div><button onClick={() => { setError(''); setMessage(''); }} aria-label="关闭通知">×</button></div></aside>}

        {selectedRoomKey === 'all' ? <section className="building-overview">
          <div className="overview-stats">
            <div><span className="summary-icon">▦</span><p><small>房间总数</small><strong>{currentBuilding?.rooms.length || 0}</strong></p></div>
            <div><span className="summary-icon">⌁</span><p><small>全部设备</small><strong>{currentDeviceCount}</strong></p></div>
            <div><span className="summary-icon live">●</span><p><small>门锁 / 在线</small><strong>{lockCount} / {onlineLockCount}</strong></p></div>
            <div><span className="summary-icon keypad">⌨️</span><p><small>密码键盘</small><strong>{keypadCount}</strong></p></div>
          </div>
          <div className="rooms-panel">
            <div className="rooms-toolbar"><h2>房间列表</h2><label className="room-search"><span>⌕</span><input value={roomQuery} onChange={(event) => setRoomQuery(event.target.value)} placeholder="搜索房间号" /></label></div>
            <div className="room-grid">
              {filteredRooms.map((room) => { const locks = roomLocks(room); const externalKeypads = roomKeypads(room); const integratedKeypads = locks.filter((lock) => !roomKeypad(room, lock) && hasIntegratedKeypad(roomSnapshots[lock.did])).length; const roomKeypadCount = externalKeypads.length + integratedKeypads; const onlineLocks = locks.filter((entry) => entry.online !== false).length; const onlineKeypads = externalKeypads.filter((entry) => entry.online !== false).length + locks.filter((lock) => !roomKeypad(room, lock) && hasIntegratedKeypad(roomSnapshots[lock.did]) && lock.online !== false).length; const relevantDeviceCount = locks.length + roomKeypadCount; return <article className="room-card operational room-summary-card" key={room.key}>
                <div className="room-card-head">
                  <span className={`room-door ${locks.length ? 'multi' : externalKeypads.length ? 'keypad-only' : 'generic-device'}`} role="img" aria-label={locks.length ? `${locks.length} 把门锁` : externalKeypads.length ? `${externalKeypads.length} 个密码键盘` : '未配置门锁设备'}>{locks.length ? <LockIcon /> : externalKeypads.length ? <span className="keypad-emoji" aria-hidden="true">⌨️</span> : <UnconfiguredLockIcon />}</span>
                  <div className="room-card-title"><h3>{room.roomName}</h3><p>{relevantDeviceCount ? `${locks.length} 把门锁 · ${roomKeypadCount} 个键盘` : '暂无门锁设备'}</p></div>
                  <span className={`room-online ${!relevantDeviceCount ? 'unconfigured' : onlineLocks + onlineKeypads ? 'online' : 'offline'}`} role="img" aria-label={`${onlineLocks + onlineKeypads}/${relevantDeviceCount} 个设备在线`}>{relevantDeviceCount ? <i /> : <PlusIcon />}</span>
                </div>
                <div className="room-card-toolbar">
                  <div className="room-card-statuses multi-lock-summary room-device-summary"><span aria-label={`${onlineLocks}/${locks.length} 把门锁在线`}><b>{onlineLocks}/{locks.length}</b><em>门锁在线</em></span><span aria-label={`${onlineKeypads}/${roomKeypadCount} 个键盘在线`}><b>{onlineKeypads}/{roomKeypadCount}</b><em>键盘在线</em></span></div>
                  <div className="room-card-actions">
                    {relevantDeviceCount > 0 && <button className="card-action detail icon-tooltip" aria-label={`管理${room.roomName}设备`} data-tooltip="进入房间" onClick={() => selectRoom(room)}>›</button>}
                  </div>
                </div>
              </article>; })}
              {!filteredRooms.length && <div className="rooms-empty"><strong>{loading ? '正在同步房间…' : '没有匹配的房间'}</strong><p>{auth ? '尝试更换公寓楼或搜索条件。' : `请先登录${regionName}区米家账号。`}</p></div>}
            </div>
          </div>
        </section> : !selected ? <section className="room-inventory-view room-device-hub">
          <div className="inventory-head"><div><p className="section-kicker">{currentBuilding?.name} · {currentRoom?.roomName}</p><h2>房间设备</h2><p>先选择具体门锁，再进入控制和密码管理；键盘归属以米家云端关系为准。</p></div><span>{currentRoomLocks.length} 门锁 · {currentRoomKeypadCount} 键盘</span></div>
          <section className="room-device-group">
            <div className="device-group-head"><div><span className="device-group-icon"><LockIcon /></span><p><strong>门锁</strong><small>状态、远程操作和密码分别管理</small></p></div><b>{currentRoomLocks.length}</b></div>
            <div className="device-tile-grid room-lock-grid">{currentRoomLocks.map((lock) => { const snapshot = roomSnapshots[lock.did]; const linkedKeypads = currentRoomKeypads.filter((keypad) => keypadParentLock(currentRoom, keypad)?.did === lock.did); const integrated = !linkedKeypads.length && hasIntegratedKeypad(snapshot); const relatedKeypadCount = linkedKeypads.length + (integrated ? 1 : 0); const stateText = snapshotLoading[lock.did] ? '正在同步' : snapshot?.error ? '状态读取失败' : snapshot?.lockState && snapshot.lockState !== '—' ? snapshot.lockState : lock.online === false ? '离线' : '等待同步'; const open = /unlock|解锁|开锁/i.test(stateText); return <button type="button" className="device-tile selectable-lock room-lock-tile" key={lock.did} onClick={() => currentRoom && selectLock(currentRoom, lock)}><span className={`device-tile-icon lock-device ${open ? 'open' : ''}`}><LockIcon open={open} /></span><div><strong>{lock.name}</strong><small>{stateText} · {relatedKeypadCount ? `${relatedKeypadCount} 个键盘` : '未关联键盘'}</small></div><i className={lock.online === false ? 'offline' : ''}>{lock.online === false ? '离线' : '管理 ›'}</i></button>; })}{!currentRoomLocks.length && <div className="device-group-empty">该房间未发现门锁</div>}</div>
          </section>
          <section className="room-device-group">
            <div className="device-group-head"><div><span className="device-group-icon keypad"><span aria-hidden="true">⌨️</span></span><p><strong>密码键盘</strong><small>展示在线状态及关联门锁</small></p></div><b>{currentRoomKeypadCount}</b></div>
            <div className="device-tile-grid room-keypad-grid">{currentRoomKeypads.map((keypad) => { const parentLock = keypadParentLock(currentRoom, keypad); return <article className={`device-tile keypad-device ${parentLock ? '' : 'unassigned'}`} key={keypad.did}><span className="device-tile-icon keypad-device-icon" aria-hidden="true">⌨️</span><div><strong>{keypad.name}</strong><small>{parentLock ? `关联：${parentLock.name}` : '未关联到具体门锁'}</small></div><i className={keypad.online === false ? 'offline' : ''}>{keypad.online === false ? '离线' : '在线'}</i></article>; })}{currentRoomIntegratedKeypadLocks.map((lock) => <article className="device-tile keypad-device" key={`integrated:${lock.did}`}><span className="device-tile-icon keypad-device-icon" aria-hidden="true">⌨️</span><div><strong>门锁内置键盘</strong><small>关联：{lock.name} · 电量 {roomSnapshots[lock.did]?.keypadBattery || '—'}</small></div><i className={lock.online === false ? 'offline' : ''}>{lock.online === false ? '离线' : '在线'}</i></article>)}{!currentRoomKeypadCount && <div className="device-group-empty">该房间未发现密码键盘</div>}</div>
          </section>
        </section> : <div className="dashboard-grid">
          <section className="control-card">
            <div className="card-head"><div><p className="section-kicker">{currentRoom?.roomName} · {selected.name}</p><h2>{lockState}</h2></div><div className="lock-detail-meta">{currentRoom && <button type="button" onClick={() => selectRoom(currentRoom)}>房间设备</button>}<span className="live-indicator"><i className={selected.online === false ? 'offline' : ''} />{loading ? '同步中' : selected.online === false ? '离线' : '已同步'}</span></div></div>
            <div className="lock-control-wrap"><div className="lock-controls">
              <button className={`lock-control unlock-command ${isUnlocked ? 'current' : 'secondary'}`} aria-label="长按解锁" onPointerDown={startHold} onPointerUp={cancelHold} onPointerLeave={cancelHold} onPointerCancel={cancelHold} disabled={!auth || loading || !selected || !unlockAction}><span className="lock-ring"><LockIcon open /></span><strong>{unlockAction ? '长按解锁' : '不可解锁'}</strong><small>{unlockAction ? '按住约 2 秒' : '设备未公开动作'}</small></button>
              <button className={`lock-control lock-command ${!isUnlocked ? 'current' : 'secondary'}`} aria-label="上锁" onClick={() => lockAction && openActionConfirm(lockAction)} disabled={!auth || loading || !selected || !lockAction}><span className="lock-ring"><LockIcon /></span><strong>{lockAction ? '上锁' : '不可上锁'}</strong><small>{lockAction ? '点击后确认' : '设备未公开动作'}</small></button>
            </div></div>
            <div className="status-strip device-status-grid">
              {statusItems.map((item) => <div className={item.reason ? 'read-failed' : ''} title={item.reason} key={item.key}>
                <span className={`status-icon ${item.key === 'keypad' || item.key.includes('battery') ? 'emoji' : ''}`}>{item.icon}</span><p><small>{item.label}</small><strong>{item.value}</strong>{item.reason && <em>{item.reason}</em>}</p>
              </div>)}
            </div>
          </section>
          <section className="password-list-card">
            <div className="password-list-head">
              <div><p className="section-kicker">门锁密码</p><h2>密码列表</h2></div>
              <div className="password-list-actions">
                <button className="secondary-button" aria-label="刷新密码列表" disabled={passwordSyncing || !selected} onClick={() => selected && void loadCloudPasswords(selected.did, selected.model).then(() => setMessage('已刷新米家云端密码列表')).catch(() => undefined)}>{passwordSyncing ? '刷新中…' : '↻ 刷新'}</button>
                <button className="primary-button" onClick={openPasswordManager}>＋ 添加密码</button>
              </div>
            </div>
            <p className="password-list-intro">米家云端密码{passwordSyncedAt ? ` · 更新于 ${new Date(passwordSyncedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
            {passwordError && <p className="password-list-feedback" role="alert">{passwordError}</p>}
            <div className="managed-passwords password-page-list">
              {managedPasswords.map((entry) => <div className="managed-password-row" key={entry.key}>
                <span className="password-row-icon">#</span>
                <span className="password-row-copy"><strong>{entry.name}</strong><small>{entry.kind === 'visitor' ? '访客密码' : '用户永久密码'}{entry.passwordId !== null ? ` · 编号 ${entry.passwordId}` : ''}{entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleDateString('zh-CN')}` : ''}</small></span>
                <button type="button" title={entry.deletable ? '从门锁删除这个云端密码' : '米家云端未返回可用于删除的密码编号'} disabled={loading || !entry.deletable} onClick={() => { setPasswordError(''); setDeletePasswordTarget(entry); }}>删除</button>
              </div>)}
              {!managedPasswords.length && <div className="password-list-empty"><span>#</span><strong>{passwordSyncing ? '正在读取米家云端…' : passwordError ? '云端列表读取失败' : '米家云端暂无密码'}</strong><p>{passwordError ? '不会使用浏览器本地记录代替，请稍后重新同步。' : '页面仅展示米家云实际返回的用户和密码记录。'}</p></div>}
            </div>
          </section>
        </div>}
      </section>

      {loginOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <section className="login-modal">
          <button className="modal-close" onClick={() => auth && setLoginOpen(false)} aria-label="关闭">×</button>
          <span className="modal-badge">{region}</span><p className="section-kicker">{regionName}区账号</p><h2 id="login-title">连接 Xiaomi Home</h2>
          <label className="login-region-select"><span>设备地区</span><select value={region} onChange={(event) => switchRegion(event.target.value as XiaomiRegion)}><option value="JP">日本（JP）</option><option value="CN">中国（CN）</option></select></label>
          {loginProgress && <div className="login-progress" role="status"><i /><div><strong>正在连接 Xiaomi Home</strong><p>{loginProgress}</p></div></div>}
          <div className="login-tabs"><button type="button" className={loginMode === 'password' ? 'active' : ''} onClick={() => { setLoginMode('password'); setError(''); }}>账号密码</button><button type="button" className={loginMode === 'qr' ? 'active' : ''} onClick={() => { setLoginMode('qr'); setError(''); }}>二维码授权</button></div>
          {loginMode === 'password' ? <form className="login-form" onSubmit={(event) => void loginWithPassword(event)}>
            <label><span>小米账号</span><input type="text" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="手机号、邮箱或小米 ID" autoComplete="username" required /></label>
            <label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入小米账号密码" autoComplete="current-password" required /></label>
            <p>密码仅用于本次登录请求，不会写入项目或浏览器存储。</p>
            <button className="primary-button wide" type="submit" disabled={loading}>{loading ? `正在验证${regionName}区账号…` : `登录${regionName}区账号`}</button>
          </form> : !qr ? <>
              <div className="qr-guide"><strong>请用米家 App 完成账号授权</strong><ol><li><b>1</b><span>确认米家 App 已登录目标账号，地区为{regionName}。</span></li><li><b>2</b><span>使用 App 内的通用扫码入口，不是“添加设备”里的扫码。</span></li><li><b>3</b><span>不要用系统相机直接打开，否则会看到 <code>70016</code> 原始数据。</span></li></ol></div>
              <button className="primary-button wide" onClick={() => void beginLogin()} disabled={loading}>{loading ? '正在创建授权…' : '生成二维码授权'}</button>
            </> : <>
              <div className="qr-frame"><Image unoptimized src={qr.qrUrl} alt="小米账号登录二维码" width={198} height={198} /></div>
              <p className="qr-hint"><strong>{qrState === 'error' ? '授权已失效，请重新生成' : '等待米家 App 扫码确认…'}</strong><br /><em>系统相机打开后显示 70016 是无效流程，请直接关闭手机页面。</em></p>
              <div className="qr-lifetime"><span>约 2 分钟有效</span><small>一旦打开过或提示过期，请换新码</small></div>
              <button className="secondary-button wide qr-refresh" onClick={regenerateQr} disabled={loading}>{loading ? '正在换新二维码…' : '↻ 立即换新二维码'}</button>
            </>}
          <div className="security-note"><span>✓</span><p><strong>这是账号授权，不是添加设备</strong><small>当前选择{regionName}区，账号密码不会写入项目。</small></p></div>
        </section>
      </div>}
      {passwordManagerOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="password-manager-title">
        <section className="confirm-modal password-manager-modal">
          <button className="modal-close" onClick={() => { setPasswordManagerOpen(false); setPasswordPin(''); setPasswordUserName(''); setPasswordName(''); setPasswordUserTarget(''); setPasswordError(''); setDeletePasswordTarget(null); }} aria-label="关闭">×</button>
          <span className="modal-badge">#</span><p className="section-kicker">{currentRoom?.roomName} · {selected?.name}</p><h2 id="password-manager-title">添加永久密码</h2>
          <p>{spec ? '选择密码所属用户；新增用户可自定义用户名称。用户名称和密码名称会写入米家云。' : '正在读取门锁的密码管理能力…'}</p>
          <form className="password-create-form" onSubmit={(event) => void createManagedPassword(event)}>
            <label><span>添加到</span><select value={passwordUserTarget} onChange={(event) => { setPasswordUserTarget(event.target.value); if (event.target.value !== 'new') setPasswordUserName(''); setPasswordError(''); }} aria-label="密码所属用户" required>
              <option value="" disabled>选择已有用户或新增用户</option>
              <option value="new">＋ 新增用户（自动分配用户编号）</option>
              {passwordUsers.map((user) => <option value={`user:${user.userId}`} key={user.userId}>{user.name}（用户 {user.userId}）· {user.passwordCount} 个密码</option>)}
            </select><small>新增用户会自动分配门锁用户编号，名称同步到米家 App。</small></label>
            {passwordUserTarget === 'new' && <label><span>用户名称</span><input type="text" maxLength={32} value={passwordUserName} onChange={(event) => { setPasswordUserName(event.target.value); setPasswordError(''); }} placeholder="例如：张先生、保洁人员、101 住客" autoComplete="off" aria-label="用户名称" required /></label>}
            <label><span>密码名称</span><input type="text" maxLength={32} value={passwordName} onChange={(event) => { setPasswordName(event.target.value); setPasswordError(''); }} placeholder="例如：保洁、前台、长期住客" autoComplete="off" aria-label="密码名称" /></label>
            <label><span>6 位门锁密码</span><input className="password-native-input" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={passwordPin} onChange={(event) => { setPasswordPin(event.target.value.replace(/\D/g, '').slice(0, 6)); setPasswordError(''); }} placeholder="输入 6 位数字" autoComplete="new-password" aria-label="6 位门锁密码" /></label>
            <button className="primary-button wide" type="submit" disabled={loading || !passwordManagementSupported || !passwordUserTarget || (passwordUserTarget === 'new' && !passwordUserName.trim()) || !passwordName.trim() || passwordPin.length !== 6}>{loading || !spec ? '正在创建并同步…' : '确认添加'}</button>
          </form>
          {passwordError && <p className="password-list-feedback" role="alert">{passwordError}</p>}
          <div className="password-security-note"><span>✓</span><p><strong>不在浏览器保存</strong><small>用户关系、密码名称和密码记录均以下发后米家云端重新同步的结果为准。</small></p></div>
        </section>
      </div>}
      {deletePasswordTarget && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-password-title">
        <section className="confirm-modal password-delete-modal">
          <button className="modal-close" onClick={() => { if (!loading) { setDeletePasswordTarget(null); setPasswordError(''); } }} aria-label="关闭删除确认">×</button>
          <span className="warning-mark">!</span><p className="section-kicker">{currentRoom?.roomName} · {selected?.name}</p><h2 id="delete-password-title">确认删除密码？</h2>
          <p>删除后，这个密码将立即停止用于门锁验证。页面会在接口完成后重新读取米家云端列表。</p>
          <div className="password-delete-summary"><span>#</span><p><strong>{deletePasswordTarget.name}</strong><small>{deletePasswordTarget.kind === 'visitor' ? '访客密码' : '用户永久密码'} · 用户 {deletePasswordTarget.userId}{deletePasswordTarget.passwordId !== null ? ` · 密码 ${deletePasswordTarget.passwordId}` : ''}</small></p></div>
          {passwordError && <p className="password-list-feedback" role="alert">{passwordError}</p>}
          <div className="modal-actions"><button disabled={loading} onClick={() => { setDeletePasswordTarget(null); setPasswordError(''); }}>取消</button><button className="danger-button" disabled={loading} onClick={() => void deleteManagedPassword(deletePasswordTarget)}>{loading ? '正在删除并同步…' : '确认删除'}</button></div>
        </section>
      </div>}
      {confirmAction && <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="confirm-modal remote-action-modal"><span className="warning-mark">!</span><p className="section-kicker">{regionName}区远程指令</p><h2>确认操作 {currentRoom?.roomName} · {selected?.name}</h2><p>即将通过米家云远程执行“{confirmAction.description}”。请确认房门附近安全，并且这是你本人发起的请求。</p><div className="remote-endpoint"><span>POST</span><code>/miotspec/action</code><small>siid {confirmAction.siid} · aiid {confirmAction.aiid}</small></div>{confirmAction.inputPiids.length > 0 && <div className="automatic-secret-note"><span>✓</span><p><strong>动态密文由服务端自动处理</strong><small>通常会直接使用门锁返回的下一枚密文；首次使用或缓存失效时才重新握手。</small></p></div>}<div className="modal-actions"><button onClick={closeActionConfirm}>取消</button><button className="danger-button" onClick={() => void runAction(confirmAction)} disabled={loading}>{loading ? '正在确认真实状态…' : '确认远程下发'}</button></div></section></div>}
    </main>
  );
}
