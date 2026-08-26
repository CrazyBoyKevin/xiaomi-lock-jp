'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  XiaomiLockOneTimePassword,
  XiaomiLockOperationLog,
  XiaomiLockOperationLogList,
  XiaomiRegion,
} from '@/lib/xiaomi/types';

const AUTH_KEY = 'mi-lock-console.jp.auth.v1';
const LEGACY_PASSWORD_META_PREFIX = 'mi-lock-console.passwords.v1';
const STATUS_PROP = /lock-state|door-lock-state|^door-state$|contact-state|battery-level|^lock-mah$|^keypad-mah$|battery-percent|electric-power|wifi-status|ble-state|ble-signal|keypad-state|close-door-lock|unlock-auto-lock/i;
const OVERVIEW_STATUS_PROP = /lock-state|door-lock-state|^door-state$|contact-state|battery-level|^lock-mah$|^keypad-mah$|battery-percent|electric-power|wifi-status|ble-state|ble-signal|keypad-state/i;
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
const ChevronDownIcon = () => <svg className="chevron-down-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="m6 9 6 6 6-6" />
</svg>;
const HistoryIcon = () => <svg className="history-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
  <path d="M3 3v5h5M12 7v5l3 2" />
</svg>;
const CalendarIcon = () => <svg className="calendar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></svg>;
const WifiIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3.5 9a13 13 0 0 1 17 0M6.5 12.5a8.4 8.4 0 0 1 11 0M9.7 16a3.5 3.5 0 0 1 4.6 0" /><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" /></svg>;
const BluetoothIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 7 10 10-5 4V3l5 4L7 17" /></svg>;
const DoorStatusIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M4 21h16" /><circle cx="14.5" cy="12" r=".8" fill="currentColor" stroke="none" /></svg>;
const KeypadStatusIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="2.5" width="14" height="19" rx="3" /><path d="M9 7h.01M12 7h.01M15 7h.01M9 11h.01M12 11h.01M15 11h.01M9 15h.01M12 15h.01M15 15h.01M12 18h.01" /></svg>;
const batteryPercent = (value: string) => {
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Math.min(100, Math.max(0, Number(match[1]))) : null;
};
const batteryLevel = (value: string) => {
  const percent = batteryPercent(value);
  if (percent === null) return 'unknown';
  if (percent <= 20) return 'low';
  if (percent <= 60) return 'medium';
  return 'high';
};
const BatteryStatusIcon = ({ value }: { value: string }) => {
  const percent = batteryPercent(value);
  const chargeWidth = percent === null || percent === 0 ? 0 : Math.max(.8, 13 * percent / 100);
  return <svg className="battery-status-icon" data-level={batteryLevel(value)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="6" width="17" height="12" rx="2" />
    <path d="M22 10v4" />
    <rect x="5" y="8.5" width={chargeWidth} height="7" rx="1" fill="currentColor" stroke="none" />
  </svg>;
};
type CustomSelectOption<T extends string> = { value: T; label: string; disabled?: boolean };
type CustomSelectProps<T extends string> = {
  value: T;
  options: CustomSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  leading?: ReactNode;
  disabled?: boolean;
  required?: boolean;
};

function CustomSelect<T extends string>({ value, options, onChange, ariaLabel, placeholder = '请选择', className = '', leading, disabled = false, required = false }: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const firstEnabledIndex = () => Math.max(0, options.findIndex((option) => !option.disabled));
  const lastEnabledIndex = () => {
    for (let index = options.length - 1; index >= 0; index -= 1) if (!options[index].disabled) return index;
    return 0;
  };
  const moveToEnabled = (from: number, direction: 1 | -1) => {
    if (!options.length) return 0;
    let index = from;
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      index = (index + direction + options.length) % options.length;
      if (!options[index].disabled) return index;
    }
    return from;
  };
  const openMenu = (direction: 1 | -1 = 1) => {
    if (disabled || !options.length) return;
    const nextIndex = selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex
      : direction === 1 ? firstEnabledIndex() : lastEnabledIndex();
    setActiveIndex(nextIndex);
    setOpen(true);
  };
  const selectOption = (option: CustomSelectOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowDown' ? 1 : -1);
    }
  };
  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(moveToEnabled(index, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? firstEnabledIndex() : lastEnabledIndex());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === 'Tab') setOpen(false);
  };

  return <div className={`custom-select ${className}${open ? ' is-open' : ''}`} ref={rootRef}>
    <button ref={triggerRef} className="custom-select-trigger" type="button" aria-label={ariaLabel} aria-required={required || undefined} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => open ? setOpen(false) : openMenu()} onKeyDown={handleTriggerKeyDown}>
      {leading}
      <span className={`custom-select-value${selectedOption ? '' : ' is-placeholder'}`}>{selectedOption?.label || placeholder}</span>
      <span className="custom-select-chevron" aria-hidden="true"><ChevronDownIcon /></span>
    </button>
    {open && <div className="custom-select-menu" role="listbox" aria-label={ariaLabel}>
      {options.map((option, index) => <button ref={(node) => { optionRefs.current[index] = node; }} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} tabIndex={index === activeIndex ? 0 : -1} className={`custom-select-option${option.value === value ? ' is-selected' : ''}`} key={option.value} onClick={() => selectOption(option)} onKeyDown={(event) => handleOptionKeyDown(event, index)}>
        <span>{option.label}</span>{option.value === value && <b aria-hidden="true">✓</b>}
      </button>)}
    </div>}
  </div>;
}

const RequiredLabel = ({ children }: { children: ReactNode }) => <span className="required-field-label">{children}<i aria-hidden="true">*</i></span>;

function DateTimeField({ label, value, onChange, ariaLabel }: { label: string; value: string; onChange: (value: string) => void; ariaLabel: string }) {
  return <label className="formatted-datetime-label">
    <RequiredLabel>{label}</RequiredLabel>
    <div className="formatted-datetime-field">
      <strong className={value ? '' : 'is-placeholder'}>{value ? value.replace('T', ' ') : '请选择日期和时间'}</strong>
      <CalendarIcon />
      <input className="datetime-picker-proxy" type="datetime-local" value={value} onClick={(event) => event.currentTarget.showPicker?.()} onChange={(event) => onChange(event.target.value)} aria-label={`${ariaLabel}，必填`} required />
    </div>
  </label>;
}
type RoomGroup = { key: string; homeId: string; homeName: string; roomId: string; roomName: string; devices: XiaomiDevice[] };
type Building = { id: string; name: string; rooms: RoomGroup[] };
type HomeCatalog = XiaomiInventory['homes'];
type RoomSnapshot = { lockState: string; battery: string; keypadBattery: string; doorState: string; wifiStatus: string; bluetoothStatus: string; keypadState: string; updatedAt: number; error?: string };
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

function toTokyoDateTimeInput(milliseconds: number) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(milliseconds));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function fromTokyoDateTimeInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}:00+09:00`);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function generatedTemporaryPin() {
  const values = new Uint32Array(1);
  const unbiasedLimit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(values);
    if (values[0] >= unbiasedLimit) continue;
    const pin = String(values[0] % 1_000_000).padStart(6, '0');
    const digits = [...pin].map(Number);
    const allSame = digits.every((digit) => digit === digits[0]);
    const ascending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] + 1);
    const descending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] - 1);
    if (!allSame && !ascending && !descending) return pin;
  }
}

function temporaryPinIsTooSimple(pin: string) {
  if (!/^\d{6}$/.test(pin)) return false;
  const digits = [...pin].map(Number);
  return digits.every((digit) => digit === digits[0])
    || digits.every((digit, index) => index === 0 || digit === digits[index - 1] + 1)
    || digits.every((digit, index) => index === 0 || digit === digits[index - 1] - 1);
}

function formatTokyoDateTime(milliseconds: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(milliseconds));
}

function temporaryPasswordStatus(entry: XiaomiLockCloudPassword) {
  const now = Date.now();
  if (entry.endsAt && entry.endsAt <= now) return '已失效';
  if (entry.startsAt && entry.startsAt > now) return '待生效';
  return entry.startsAt || entry.endsAt ? '生效中' : '时间待同步';
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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [qr, setQr] = useState<{ id: string; qrUrl: string; loginUrl: string; expiresAt: number } | null>(null);
  const [qrState, setQrState] = useState('');
  const [confirmAction, setConfirmAction] = useState<SpecAction | null>(null);
  const [actionDetailsOpen, setActionDetailsOpen] = useState(false);
  const [confirmError, setConfirmError] = useState('');
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
  const [oneTimePasswords, setOneTimePasswords] = useState<XiaomiLockOneTimePassword[]>([]);
  const [passwordSection, setPasswordSection] = useState<'permanent' | 'temporary'>('temporary');
  const [passwordSyncing, setPasswordSyncing] = useState(false);
  const [passwordSyncedAt, setPasswordSyncedAt] = useState<number | null>(null);
  const [deletePasswordTarget, setDeletePasswordTarget] = useState<XiaomiLockCloudPassword | null>(null);
  const [deleteUserTarget, setDeleteUserTarget] = useState<XiaomiLockCloudUser | null>(null);
  const [temporaryEditorOpen, setTemporaryEditorOpen] = useState(false);
  const [temporaryEditorTarget, setTemporaryEditorTarget] = useState<XiaomiLockCloudPassword | null>(null);
  const [temporaryName, setTemporaryName] = useState('');
  const [temporaryPin, setTemporaryPin] = useState('');
  const [temporaryStartsAt, setTemporaryStartsAt] = useState('');
  const [temporaryEndsAt, setTemporaryEndsAt] = useState('');
  const [temporaryReceipt, setTemporaryReceipt] = useState<{
    name: string;
    pin: string;
    startsAt: string;
    endsAt: string;
  } | null>(null);
  const [deleteTemporaryTarget, setDeleteTemporaryTarget] = useState<XiaomiLockCloudPassword | null>(null);
  const [expandedPasswordUserId, setExpandedPasswordUserId] = useState<number | null | undefined>(undefined);
  const [operationLogsOpen, setOperationLogsOpen] = useState(false);
  const [operationLogs, setOperationLogs] = useState<XiaomiLockOperationLog[]>([]);
  const [operationLogsLoading, setOperationLogsLoading] = useState(false);
  const [operationLogsError, setOperationLogsError] = useState('');
  const [operationLogsSyncedAt, setOperationLogsSyncedAt] = useState<number | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const loadedOverviewKeys = useRef(new Set<string>());
  const passwordSyncRequest = useRef(0);
  const regionName = region === 'CN' ? '中国' : '日本';

  const buildings = useMemo(() => groupBuildings(devices, homeCatalog), [devices, homeCatalog]);
  const currentBuilding = buildings.find((building) => building.id === selectedHomeId) ?? buildings[0];
  const currentRoom = selectedRoomKey === 'all' ? undefined : currentBuilding?.rooms.find((room) => room.key === selectedRoomKey);
  const currentRoomLocks = roomLocks(currentRoom);
  const currentRoomKeypads = roomKeypads(currentRoom);
  const currentRoomUnassignedKeypads = currentRoomKeypads.filter((keypad) => !keypadParentLock(currentRoom, keypad));
  const selected = currentRoomLocks.find((lock) => lock.did === selectedLockDid);
  const selectedDid = selected?.did;
  const selectedModel = selected?.model;
  const filteredRooms = currentBuilding?.rooms.filter((room) => room.roomName.toLowerCase().includes(roomQuery.toLowerCase())) ?? [];
  const passwordUsers = managedPasswordUsers;
  const passwordUserNames = useMemo(
    () => new Map(managedPasswordUsers.map((user) => [user.userId, user.name])),
    [managedPasswordUsers],
  );
  const passwordUserGroups = useMemo(() => {
    const passwordsByUser = new Map<number, XiaomiLockCloudPassword[]>();
    managedPasswords.forEach((entry) => {
      if (entry.kind !== 'user') return;
      const entries = passwordsByUser.get(entry.userId) ?? [];
      entries.push(entry);
      passwordsByUser.set(entry.userId, entries);
    });
    return managedPasswordUsers.map((user) => ({ user, passwords: passwordsByUser.get(user.userId) ?? [] }));
  }, [managedPasswords, managedPasswordUsers]);
  const knownPasswordUserIds = useMemo(() => new Set(managedPasswordUsers.map((user) => user.userId)), [managedPasswordUsers]);
  const ungroupedPasswords = useMemo(
    () => managedPasswords.filter((entry) => entry.kind === 'user' && !knownPasswordUserIds.has(entry.userId)),
    [knownPasswordUserIds, managedPasswords],
  );
  const temporaryPasswords = useMemo(
    () => managedPasswords.filter((entry) => entry.kind === 'visitor'),
    [managedPasswords],
  );
  const activePasswordUserId = expandedPasswordUserId === null
    ? null
    : managedPasswordUsers.some((user) => user.userId === expandedPasswordUserId)
      ? expandedPasswordUserId
      : managedPasswordUsers[0]?.userId ?? null;
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
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(''), 4500);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeAccountMenu = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const closeAccountMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeAccountMenu);
    document.addEventListener('keydown', closeAccountMenuOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeAccountMenu);
      document.removeEventListener('keydown', closeAccountMenuOnEscape);
    };
  }, [accountMenuOpen]);

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

  const loadCloudPasswords = useCallback(async (did: string, model: string) => {
    const requestId = ++passwordSyncRequest.current;
    setPasswordSyncing(true);
    setPasswordError('');
    try {
      const result = await rpc<XiaomiLockCloudPasswordList>({ op: 'passwordList', did, model });
      if (requestId === passwordSyncRequest.current) {
        setManagedPasswords(result.entries);
        setManagedPasswordUsers(result.users);
        setOneTimePasswords(result.oneTimePasswords ?? []);
        setPasswordSyncedAt(result.syncedAt);
      }
      return result;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '米家云密码列表读取失败';
      if (requestId === passwordSyncRequest.current) {
        setManagedPasswords([]);
        setManagedPasswordUsers([]);
        setOneTimePasswords([]);
        setPasswordSyncedAt(null);
        setPasswordError(reason);
      }
      throw cause;
    } finally {
      if (requestId === passwordSyncRequest.current) setPasswordSyncing(false);
    }
  }, [rpc]);

  const loadOperationLogs = useCallback(async (did: string, model: string) => {
    setOperationLogsLoading(true);
    setOperationLogsError('');
    try {
      const result = await rpc<XiaomiLockOperationLogList>({ op: 'operationLogs', did, model });
      setOperationLogs(result.entries);
      setOperationLogsSyncedAt(result.syncedAt);
      return result;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '米家云门锁记录读取失败';
      setOperationLogs([]);
      setOperationLogsSyncedAt(null);
      setOperationLogsError(reason);
      throw cause;
    } finally {
      setOperationLogsLoading(false);
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
      wifiStatus: snapshotValue(/wifi-status/i),
      bluetoothStatus: snapshotValue(/ble-state|ble-signal/i),
      keypadState: snapshotValue(/keypad-state/i),
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
            lockState: '读取失败', battery: '—', keypadBattery: '—', doorState: '—', wifiStatus: '—', bluetoothStatus: '—', keypadState: '—', updatedAt: Date.now(), error: reason,
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
        wifiStatus: snapshotValue(/wifi-status/i),
        bluetoothStatus: snapshotValue(/ble-state|ble-signal/i),
        keypadState: snapshotValue(/keypad-state/i),
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
        } catch {
          localStorage.removeItem(AUTH_KEY);
          setRegion(route.region);
          setLoginOpen(true);
        }
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
      setManagedPasswordUsers([]);
      setOneTimePasswords([]);
      setPasswordSyncedAt(null);
      setPasswordPin('');
      setPasswordError('');
      setDeletePasswordTarget(null);
      setDeleteUserTarget(null);
      setTemporaryEditorOpen(false);
      setTemporaryEditorTarget(null);
      setTemporaryReceipt(null);
      setDeleteTemporaryTarget(null);
      setPasswordSection('temporary');
      setExpandedPasswordUserId(undefined);
      if (auth && selectedDid && selectedModel) void loadCloudPasswords(selectedDid, selectedModel).catch(() => undefined);
    });
  }, [auth, loadCloudPasswords, selectedDid, selectedModel]);
  useEffect(() => {
    queueMicrotask(() => {
      setOperationLogsOpen(false);
      setOperationLogs([]);
      setOperationLogsError('');
      setOperationLogsSyncedAt(null);
    });
  }, [selectedDid, selectedModel]);

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

  const beginLogin = useCallback(async () => {
    setLoading(true); setError(''); setQrState('waiting');
    try {
      setQr(await api('/api/auth/qr/start', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region }),
      }));
    }
    catch (cause) {
      setQrState('error');
      setError(cause instanceof Error ? cause.message : '无法创建二维码');
    }
    finally { setLoading(false); }
  }, [region]);

  useEffect(() => {
    if (!loginOpen || auth || qr || qrState || loading) return;
    queueMicrotask(() => void beginLogin());
  }, [auth, beginLogin, loading, loginOpen, qr, qrState]);

  const regenerateQr = () => {
    setQr(null); setQrState(''); setError('');
    void beginLogin();
  };
  const logout = () => {
    localStorage.removeItem(AUTH_KEY); loadedOverviewKeys.current.clear(); setAccountMenuOpen(false); setLogoutConfirmOpen(false); setOperationLogsOpen(false); setOperationLogs([]); setAuth(null); setDevices([]); setHomeCatalog([]); setSpec(null); setValues({}); setRoomSnapshots({}); setSnapshotLoading({}); setSelectedHomeId(''); setSelectedRoomKey('all'); setSelectedLockDid(''); setError(''); setMessage(''); setLoginOpen(true); setQr(null); setQrState('');
  };

  const switchRegion = (nextRegion: XiaomiRegion) => {
    if (nextRegion === region) return;
    const nextRegionName = nextRegion === 'CN' ? '中国' : '日本';
    updateBrowserPath(consolePath(nextRegion));
    setRegion(nextRegion);
    setQr(null); setQrState(''); setError('');
    setOperationLogsOpen(false); setOperationLogs([]); setOperationLogsError(''); setOperationLogsSyncedAt(null);
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
    if (currentRoom && selected) {
      void loadSelected();
      return;
    }
    if (currentRoom) {
      void loadOverviewSnapshots([currentRoom]);
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
      setActionDetailsOpen(false);
      if (!displayedSnapshot) {
        setError(`${currentRoom.roomName} · ${selected.name}：指令已被门锁接受，但最新状态读取失败${verification.issue ? `（${verification.issue}）` : ''}，请稍后刷新确认。`);
      } else if (!displayedStateConfirmed) {
        setError(`${currentRoom.roomName} · ${selected.name}：指令已被门锁接受，但云端最新状态仍为“${displayedSnapshot.lockState}”。页面已按真实状态更新，请稍后再次刷新。`);
      } else {
        setMessage(`${currentRoom.roomName} · ${selected.name}：${action.description}成功，最新状态为“${displayedSnapshot.lockState}”`);
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '操作失败';
      setConfirmError(reason);
    }
    finally { setLoading(false); }
  };

  const openActionConfirm = (action: SpecAction) => {
    setConfirmError('');
    setActionDetailsOpen(false);
    setConfirmAction(action);
  };

  const closeActionConfirm = () => {
    setConfirmError('');
    setActionDetailsOpen(false);
    setConfirmAction(null);
  };

  const selectBuildingOverview = () => {
    setSelectedRoomKey('all');
    setSelectedLockDid('');
    updateBrowserPath(consolePath(region, currentBuilding?.id));
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
      setPasswordManagerOpen(false); setDeletePasswordTarget(null); setDeleteUserTarget(null); setTemporaryEditorOpen(false); setTemporaryEditorTarget(null); setTemporaryReceipt(null); setDeleteTemporaryTarget(null); setConfirmAction(null); setOperationLogsOpen(false);
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
  const temporaryPasswordAction = spec?.actions.find((action) => action.name === 'edit-periodic-cipher');
  const temporaryPasswordManagementSupported = Boolean(temporaryPasswordAction);
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
    setDeleteUserTarget(null);
    setPasswordManagerOpen(true);
  };

  const openTemporaryEditor = (entry?: XiaomiLockCloudPassword) => {
    if (!temporaryPasswordManagementSupported) {
      setError('当前门锁没有公开自定义时段临时密码能力。');
      return;
    }
    const roundedStart = Math.ceil((Date.now() + 5 * 60 * 1000) / (5 * 60 * 1000)) * 5 * 60 * 1000;
    setPasswordError('');
    setTemporaryReceipt(null);
    setTemporaryEditorTarget(entry ?? null);
    setTemporaryName(entry?.name ?? '');
    setTemporaryPin(entry ? '' : generatedTemporaryPin());
    setTemporaryStartsAt(toTokyoDateTimeInput(entry?.startsAt ?? roundedStart));
    setTemporaryEndsAt(toTokyoDateTimeInput(entry?.endsAt ?? roundedStart + 24 * 60 * 60 * 1000));
    setDeleteTemporaryTarget(null);
    setTemporaryEditorOpen(true);
  };

  const copyTemporaryPasswordDetails = async () => {
    if (!temporaryReceipt) return;
    const content = [
      `名称：${temporaryReceipt.name}`,
      `临时密码：${temporaryReceipt.pin}`,
      `生效时间：${temporaryReceipt.startsAt.replace('T', ' ')}（日本标准时间 JST / UTC+9）`,
      `失效时间：${temporaryReceipt.endsAt.replace('T', ' ')}（日本标准时间 JST / UTC+9）`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(content);
      setMessage('已复制临时密码、有效时段和日本时区');
    } catch {
      setPasswordError('浏览器未允许复制，请检查剪贴板权限后重试');
    }
  };

  const saveTemporaryPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !temporaryPasswordManagementSupported) return;
    const name = temporaryName.trim();
    const startsAt = fromTokyoDateTimeInput(temporaryStartsAt);
    const endsAt = fromTokyoDateTimeInput(temporaryEndsAt);
    if (!name || name.length > 32) { setPasswordError('请输入 1–32 个字符的临时密码名称'); return; }
    if (!temporaryEditorTarget && !/^\d{6}$/.test(temporaryPin)) { setPasswordError('请输入完整的 6 位数字临时密码'); return; }
    if (!temporaryEditorTarget && temporaryPinIsTooSimple(temporaryPin)) { setPasswordError('临时密码不能全部相同，也不能使用连续递增或递减的数字'); return; }
    if (startsAt === null || endsAt === null) { setPasswordError('请选择完整的生效时间和失效时间'); return; }
    if (endsAt <= startsAt) { setPasswordError('失效时间必须晚于生效时间'); return; }
    const updating = Boolean(temporaryEditorTarget);
    setLoading(true); setPasswordError(''); setError('');
    try {
      const result = await rpc<{ visitorId: number; periodicCipherId: number; name: string; startsAt: number; endsAt: number }>({
        op: 'password',
        mode: updating ? 'update-temporary' : 'create-temporary',
        model: selected.model,
        did: selected.did,
        ...(!updating ? { pin: temporaryPin } : {}),
        name,
        startsAt: Math.floor(startsAt / 1000),
        endsAt: Math.floor(endsAt / 1000),
        visitorId: temporaryEditorTarget?.userId,
        periodicCipherId: temporaryEditorTarget?.passwordId,
      });
      let confirmed = false;
      for (const delay of [300, 700, 1200, 2000, 3200]) {
        await waitFor(delay);
        const cloud = await loadCloudPasswords(selected.did, selected.model);
        const entry = cloud.entries.find((item) => item.kind === 'visitor'
          && item.userId === result.visitorId && item.passwordId === result.periodicCipherId);
        confirmed = Boolean(entry && entry.name === result.name);
        if (confirmed) break;
      }
      if (!confirmed) throw new Error(`门锁已接收${updating ? '修改' : '创建'}请求，但米家云端尚未返回一致的临时密码记录；页面不会生成本地记录，请稍后刷新`);
      if (!updating) {
        setTemporaryReceipt({
          name,
          pin: temporaryPin,
          startsAt: temporaryStartsAt,
          endsAt: temporaryEndsAt,
        });
      }
      setTemporaryEditorOpen(false);
      setTemporaryEditorTarget(null);
      setTemporaryName('');
      setTemporaryPin('');
      setTemporaryStartsAt('');
      setTemporaryEndsAt('');
      setMessage(updating
        ? `${currentRoom?.roomName} · ${selected.name}：临时密码已修改，并已从米家云端确认`
        : `${currentRoom?.roomName} · ${selected.name}：创建已由米家云端确认，请保存生成的凭证`);
    } catch (cause) {
      setPasswordError(cause instanceof Error ? cause.message : `临时密码${updating ? '修改' : '创建'}失败`);
    } finally {
      setTemporaryPin('');
      setLoading(false);
    }
  };

  const deleteTemporaryPassword = async (entry: XiaomiLockCloudPassword) => {
    if (!selected || entry.kind !== 'visitor' || entry.passwordId === null || !entry.deletable) return;
    setLoading(true); setPasswordError(''); setError('');
    try {
      await rpc({
        op: 'password', mode: 'delete-temporary', model: selected.model, did: selected.did,
        visitorId: entry.userId, periodicCipherId: entry.passwordId,
      });
      let confirmed = false;
      let lastSyncError: unknown;
      for (const delay of [0, 500, 900, 1500, 2500, 4000, 6000, 8000]) {
        if (delay) await waitFor(delay);
        try {
          const cloud = await loadCloudPasswords(selected.did, selected.model);
          confirmed = !cloud.entries.some((item) => item.kind === 'visitor'
            && item.userId === entry.userId && item.passwordId === entry.passwordId);
          if (confirmed) break;
        } catch (cause) {
          lastSyncError = cause;
        }
      }
      if (!confirmed) {
        if (lastSyncError instanceof Error) throw lastSyncError;
        throw new Error('门锁已接收删除请求，但米家云端仍包含该临时密码；页面保留云端真实状态，请稍后刷新');
      }
      setDeleteTemporaryTarget(null);
      setMessage(`${currentRoom?.roomName} · ${selected.name}：${entry.name} 已删除，并已从米家云端确认`);
    } catch (cause) {
      setPasswordError(cause instanceof Error ? cause.message : '临时密码删除失败');
    } finally {
      setLoading(false);
    }
  };

  const createManagedPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !passwordManagementSupported) return;
    const nextUserName = passwordUserName.trim();
    const nextPasswordName = passwordName.trim();
    if (!passwordUserTarget) { setPasswordError('请选择要添加到已有用户，或新增一个用户'); return; }
    if (passwordUserTarget === 'new' && (!nextUserName || nextUserName.length > 32)) { setPasswordError('请输入 1–32 个字符的用户名称'); return; }
    if (!nextPasswordName || nextPasswordName.length > 32) { setPasswordError('请输入 1–32 个字符的密码名称'); return; }
    if (!/^\d{6}$/.test(passwordPin)) { setPasswordError('请输入完整的 6 位数字密码'); return; }
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
        const cloud = await loadCloudPasswords(selected.did, selected.model);
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
    } catch (cause) { const reason = cause instanceof Error ? cause.message : '密码创建失败'; setPasswordError(reason); }
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
          const cloud = await loadCloudPasswords(selected.did, selected.model);
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
    } catch (cause) { const reason = cause instanceof Error ? cause.message : '密码删除失败'; setPasswordError(reason); }
    finally { setLoading(false); }
  };

  const deleteManagedUser = async (user: XiaomiLockCloudUser) => {
    if (!selected || user.userId === 0) return;
    setLoading(true); setPasswordError(''); setError('');
    try {
      await rpc({
        op: 'password', mode: 'delete-user', model: selected.model, did: selected.did,
        userId: user.userId,
      });
      let confirmed = false;
      let lastSyncError: unknown;
      for (const delay of [0, 500, 900, 1500, 2500, 4000, 6000]) {
        if (delay) await waitFor(delay);
        try {
          const cloud = await loadCloudPasswords(selected.did, selected.model);
          confirmed = !cloud.users.some((entry) => entry.userId === user.userId);
          if (confirmed) break;
        } catch (cause) {
          lastSyncError = cause;
        }
      }
      if (!confirmed) {
        if (lastSyncError instanceof Error) throw lastSyncError;
        throw new Error('门锁已接收删除用户请求，但米家云端仍包含该用户；页面已保留云端真实状态，请稍后刷新');
      }
      setDeleteUserTarget(null);
      setMessage(`${currentRoom?.roomName} · ${selected.name}：用户“${user.name}”及其 ${user.passwordCount} 个永久密码已删除，并已从米家云端确认`);
    } catch (cause) { const reason = cause instanceof Error ? cause.message : '用户删除失败'; setPasswordError(reason); }
    finally { setLoading(false); }
  };

  const notificationError = error || passwordError || confirmError;
  const notificationMessage = notificationError ? '' : message;

  return (
    <main className="app-shell">
      <aside className="sidebar apartment-sidebar">
        <div className="brand"><span className="brand-mark">M</span><span>Mi Apartments</span></div>
        <div className="building-picker">
          <p className="nav-label">公寓楼</p>
          <CustomSelect className="building-select" value={currentBuilding?.id || ''} options={buildings.map((building) => ({ value: building.id, label: `${building.name} · ${building.rooms.length} 间` }))} ariaLabel="选择公寓楼" placeholder="正在同步公寓楼…" disabled={!buildings.length} onChange={(homeId) => { setSelectedHomeId(homeId); setSelectedRoomKey('all'); setSelectedLockDid(''); setRoomQuery(''); updateBrowserPath(consolePath(region, homeId)); }} />
        </div>
        <nav className="device-nav room-nav" aria-label="房间">
          <div className="room-nav-head"><p className="nav-label">房间</p><span>{currentBuilding?.rooms.length || 0}</span></div>
          <button className={`room-item overview ${selectedRoomKey === 'all' ? 'active' : ''}`} onClick={selectBuildingOverview}><span className="room-number">⌂</span><span><strong>所有房间</strong><small>查看整栋状态</small></span></button>
          <div className="room-list">
            {currentBuilding?.rooms.map((room) => {
              const locks = roomLocks(room); const externalKeypads = roomKeypads(room); const integratedKeypads = locks.filter((lock) => !roomKeypad(room, lock) && hasIntegratedKeypad(roomSnapshots[lock.did])).length; const roomKeypadCount = externalKeypads.length + integratedKeypads; const relevantDeviceCount = locks.length + roomKeypadCount; const onlineDevices = [...locks, ...externalKeypads].filter((entry) => entry.online !== false).length;
              return <button key={room.key} className={`room-item ${!relevantDeviceCount ? 'unavailable' : ''} ${selectedRoomKey === room.key ? 'active' : ''}`} onClick={() => relevantDeviceCount && selectRoom(room)} disabled={!relevantDeviceCount} title={!relevantDeviceCount ? '未配置门锁或密码键盘' : `管理 ${locks.length} 把门锁和 ${roomKeypadCount} 个键盘`}>
                <span className="room-number">{room.roomName.match(/\d+/)?.[0] || room.roomName.slice(0, 2)}</span>
                <span><strong>{room.roomName}</strong></span>
                <i className={`status-dot ${relevantDeviceCount ? onlineDevices ? '' : 'offline' : 'neutral'}`} />
              </button>;
            })}
          </div>
          {!devices.length && <p className="empty-nav">{auth ? '正在同步公寓与房间…' : '登录后显示公寓楼'}</p>}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="page-heading">
            {currentRoom ? <nav className="breadcrumbs" aria-label="当前位置">
              <button type="button" onClick={selectBuildingOverview}>{currentBuilding?.name || `${regionName}区公寓`}</button>
              {selected && <><span aria-hidden="true">›</span><button type="button" onClick={() => selectRoom(currentRoom)}>{currentRoom.roomName}</button></>}
            </nav> : <p className="eyebrow">{regionName}区 · 公寓管理</p>}
            <h1>{currentRoom ? selected ? selected.name : currentRoom.roomName : currentBuilding?.name || `连接你的${regionName}区米家账号`}</h1>
          </div>
          <div className="top-actions"><CustomSelect className="region-custom-select" value={region} options={[{ value: 'JP', label: '日本' }, { value: 'CN', label: '中国' }]} ariaLabel={`当前区域：${regionName}`} leading={<span className="region-code">{region}</span>} onChange={(nextRegion) => switchRegion(nextRegion as XiaomiRegion)} /><button className="icon-button" aria-label="刷新" onClick={refreshCurrentView} disabled={loading}>↻</button><div className="account-control" ref={accountMenuRef}><button className="avatar" onClick={() => auth ? setAccountMenuOpen((open) => !open) : setLoginOpen(true)} aria-label={auth ? '账户菜单' : '登录'} aria-haspopup={auth ? 'menu' : undefined} aria-expanded={auth ? accountMenuOpen : undefined}>{auth ? 'K' : '?'}</button>{auth && accountMenuOpen && <div className="account-menu" role="menu"><div className="account-menu-head"><span>K</span><p><strong>小米账号</strong><small>{auth.userId} · {regionName}区</small></p></div><button type="button" role="menuitem" onClick={() => { setAccountMenuOpen(false); setLogoutConfirmOpen(true); }}><span>退出登录</span><i>›</i></button></div>}</div></div>
        </header>
        {(notificationError || notificationMessage) && <aside className="notification-region" aria-live="polite"><div className={`notice ${notificationError ? 'error' : 'success'}`} role={notificationError ? 'alert' : 'status'}><span>{notificationError ? '!' : '✓'}</span><div><strong>{notificationError ? '操作未完成' : '操作完成'}</strong><p>{notificationError || notificationMessage}</p></div><button onClick={() => { setError(''); setPasswordError(''); setConfirmError(''); setMessage(''); }} aria-label="关闭通知">×</button></div></aside>}

        {selectedRoomKey === 'all' ? <section className="building-overview">
          <div className="overview-stats">
            <div><span className="summary-icon">▦</span><p><small>房间总数</small><strong>{currentBuilding?.rooms.length || 0}</strong></p></div>
            <div><span className="summary-icon live">●</span><p><small>在线门锁</small><strong>{onlineLockCount}</strong></p></div>
            <div><span className="summary-icon keypad">⌨️</span><p><small>密码键盘</small><strong>{keypadCount}</strong></p></div>
          </div>
          <div className="rooms-panel">
            <div className="rooms-toolbar"><h2>房间列表</h2><label className="room-search"><span>⌕</span><input value={roomQuery} onChange={(event) => setRoomQuery(event.target.value)} placeholder="搜索房间号" /></label></div>
            <div className="room-grid">
              {filteredRooms.map((room) => { const locks = roomLocks(room); const externalKeypads = roomKeypads(room); const integratedKeypads = locks.filter((lock) => !roomKeypad(room, lock) && hasIntegratedKeypad(roomSnapshots[lock.did])).length; const roomKeypadCount = externalKeypads.length + integratedKeypads; const onlineLocks = locks.filter((entry) => entry.online !== false).length; const onlineKeypads = externalKeypads.filter((entry) => entry.online !== false).length + locks.filter((lock) => !roomKeypad(room, lock) && hasIntegratedKeypad(roomSnapshots[lock.did]) && lock.online !== false).length; const relevantDeviceCount = locks.length + roomKeypadCount; return <article className="room-card operational room-summary-card" key={room.key}>
                <div className="room-card-head">
                  <span className={`room-door ${locks.length ? 'multi' : externalKeypads.length ? 'keypad-only' : 'generic-device'}`} role="img" aria-label={locks.length ? `${locks.length} 把门锁` : externalKeypads.length ? `${externalKeypads.length} 个密码键盘` : '未配置门锁设备'}>{locks.length ? <LockIcon /> : externalKeypads.length ? <span className="keypad-emoji" aria-hidden="true">⌨️</span> : <UnconfiguredLockIcon />}</span>
                  <div className="room-card-title"><h3>{room.roomName}</h3><p>{relevantDeviceCount ? `${onlineLocks + onlineKeypads}/${relevantDeviceCount} 个设备在线` : '暂无门锁设备'}</p></div>
                  <span className={`room-online ${!relevantDeviceCount ? 'unconfigured' : onlineLocks + onlineKeypads ? 'online' : 'offline'}`} role="img" aria-label={relevantDeviceCount ? `${onlineLocks + onlineKeypads}/${relevantDeviceCount} 个设备在线` : '未配置设备'}>{relevantDeviceCount ? <i /> : <PlusIcon />}</span>
                </div>
                <div className="room-card-toolbar">
                  <div className="room-card-statuses multi-lock-summary room-device-summary"><span aria-label={`${locks.length} 把门锁`}><b>{locks.length}</b><em>门锁</em></span><span aria-label={`${roomKeypadCount} 个键盘`}><b>{roomKeypadCount}</b><em>键盘</em></span></div>
                  <div className="room-card-actions">
                    {relevantDeviceCount > 0 && <button className="card-action detail icon-tooltip" aria-label={`管理${room.roomName}设备`} data-tooltip="进入房间" onClick={() => selectRoom(room)}>›</button>}
                  </div>
                </div>
              </article>; })}
              {!filteredRooms.length && <div className="rooms-empty"><strong>{loading ? '正在同步房间…' : '没有匹配的房间'}</strong><p>{auth ? '尝试更换公寓楼或搜索条件。' : `请先登录${regionName}区米家账号。`}</p></div>}
            </div>
          </div>
        </section> : !selected ? <section className="room-inventory-view room-device-hub">
          <section className="room-device-group lock-bundle-section">
            <div className="device-group-head"><div><span className="device-group-icon"><LockIcon /></span><p><strong>门锁设备</strong><small>连接、门状态与键盘信息集中展示</small></p></div><b>{currentRoomLocks.length}</b></div>
            <div className="lock-bundle-grid">{currentRoomLocks.map((lock) => {
              const snapshot = roomSnapshots[lock.did];
              const syncing = snapshotLoading[lock.did];
              const linkedKeypads = currentRoomKeypads.filter((keypad) => keypadParentLock(currentRoom, keypad)?.did === lock.did);
              const integrated = !linkedKeypads.length && hasIntegratedKeypad(snapshot);
              const relatedKeypadCount = linkedKeypads.length + (integrated ? 1 : 0);
              const stateText = syncing ? '正在同步' : snapshot?.error ? '状态读取失败' : snapshot?.lockState && snapshot.lockState !== '—' ? snapshot.lockState : lock.online === false ? '离线' : '等待同步';
              const wifiText = syncing ? '同步中' : snapshot?.wifiStatus && snapshot.wifiStatus !== '—' ? snapshot.wifiStatus : lock.online === false ? '离线' : '—';
              const bluetoothText = syncing ? '同步中' : snapshot?.bluetoothStatus && snapshot.bluetoothStatus !== '—' ? snapshot.bluetoothStatus : '—';
              const doorText = syncing ? '同步中' : snapshot?.doorState && snapshot.doorState !== '—' ? snapshot.doorState : '—';
              const keypadBattery = snapshot?.keypadBattery && snapshot.keypadBattery !== '—' ? snapshot.keypadBattery : '';
              const keypadText = syncing ? '同步中' : relatedKeypadCount ? `${relatedKeypadCount} 个` : '未绑定';
              const keypadBatteryText = syncing ? '同步中' : relatedKeypadCount ? keypadBattery || '—' : '未绑定';
              const batteryText = syncing ? '同步中' : snapshot?.battery || '—';
              const keypadTitle = relatedKeypadCount
                ? `${linkedKeypads.map((keypad) => keypad.name).join('、') || '内置密码键盘'} · ${snapshot?.keypadState && snapshot.keypadState !== '—' ? snapshot.keypadState : '已绑定'}`
                : '未绑定密码键盘';
              const open = /unlock|解锁|开锁/i.test(stateText);
              const statusItems = [
                { key: 'wifi', label: 'Wi-Fi', value: wifiText, icon: <WifiIcon /> },
                { key: 'bluetooth', label: '蓝牙', value: bluetoothText, icon: <BluetoothIcon /> },
                { key: 'battery', label: '门锁电量', value: batteryText, batteryLevel: batteryLevel(batteryText), icon: <BatteryStatusIcon value={batteryText} /> },
                { key: 'door', label: '门状态', value: doorText, icon: <DoorStatusIcon /> },
                { key: 'keypad', label: '键盘', value: keypadText, title: keypadTitle, icon: <KeypadStatusIcon /> },
                { key: 'keypad-battery', label: '键盘电量', value: keypadBatteryText, batteryLevel: batteryLevel(keypadBatteryText), icon: <BatteryStatusIcon value={keypadBatteryText} /> },
              ];
              return <article className={`lock-bundle ${relatedKeypadCount ? 'has-keypad' : ''}`} key={lock.did}>
                <button type="button" className="lock-bundle-primary" onClick={() => currentRoom && selectLock(currentRoom, lock)}>
                  <span className={`device-tile-icon lock-device ${open ? 'open' : ''}`}><LockIcon open={open} /></span>
                  <span className="lock-bundle-copy"><strong>{lock.name}</strong><small>{stateText}</small></span>
                  <span className="lock-bundle-action">管理 ›</span>
                </button>
                <div className="lock-bundle-statuses">{statusItems.map((item) => {
                  const inactive = /离线|未连接|未绑定|失败|异常|^—$/.test(item.value);
                  const tooltip = item.title ? `${item.label}：${item.title}` : `${item.label}：${item.value}`;
                  return <div className={`lock-bundle-status${inactive ? ' inactive' : ''}${item.batteryLevel && item.batteryLevel !== 'unknown' ? ` battery-${item.batteryLevel}` : ''}`} data-tooltip={tooltip} aria-label={tooltip} tabIndex={0} key={item.key}><span>{item.icon}</span></div>;
                })}</div>
              </article>;
            })}{!currentRoomLocks.length && <div className="device-group-empty">该房间未发现门锁</div>}</div>
          </section>
          {currentRoomUnassignedKeypads.length > 0 && <section className="room-device-group unassigned-keypad-section">
            <div className="device-group-head"><div><span className="device-group-icon keypad"><span aria-hidden="true">⌨️</span></span><p><strong>未关联键盘</strong><small>米家云端未指明这些键盘所属的门锁</small></p></div><b>{currentRoomUnassignedKeypads.length}</b></div>
            <div className="device-tile-grid room-keypad-grid">{currentRoomUnassignedKeypads.map((keypad) => <article className="device-tile keypad-device unassigned" key={keypad.did}><span className="device-tile-icon keypad-device-icon" aria-hidden="true">⌨️</span><div><strong>{keypad.name}</strong><small>等待关联门锁</small></div><i className={keypad.online === false ? 'offline' : ''}>{keypad.online === false ? '离线' : '在线'}</i></article>)}</div>
          </section>}
        </section> : <div className="dashboard-grid">
          <section className="control-card">
            <div className="card-head"><h2>门锁控制</h2><div className="lock-detail-meta"><button type="button" className="lock-log-trigger" onClick={() => { setOperationLogsOpen(true); void loadOperationLogs(selected.did, selected.model).catch(() => undefined); }}><HistoryIcon /><span>开关记录</span></button><span className="live-indicator"><i className={selected.online === false ? 'offline' : ''} />{loading ? '同步中' : selected.online === false ? '离线' : '已同步'}</span></div></div>
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
              <h2>门锁密码</h2>
              <div className="password-list-actions">
                <button className="secondary-button" aria-label="刷新密码列表" disabled={passwordSyncing || !selected} onClick={() => selected && void loadCloudPasswords(selected.did, selected.model).then(() => setMessage('已刷新米家云端密码列表')).catch(() => undefined)}>{passwordSyncing ? '刷新中…' : '↻ 刷新'}</button>
                <button className="primary-button" onClick={() => passwordSection === 'permanent' ? openPasswordManager() : openTemporaryEditor()}>＋ {passwordSection === 'permanent' ? '永久密码' : '临时密码'}</button>
              </div>
            </div>
            {passwordSyncedAt && <p className="password-list-intro">更新于 {new Date(passwordSyncedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>}
            <div className="password-section-tabs" role="tablist" aria-label="密码类型">
              <button type="button" role="tab" aria-selected={passwordSection === 'permanent'} className={passwordSection === 'permanent' ? 'active' : ''} onClick={() => setPasswordSection('permanent')}>永久密码 <span>{managedPasswords.filter((entry) => entry.kind === 'user').length}</span></button>
              <button type="button" role="tab" aria-selected={passwordSection === 'temporary'} className={passwordSection === 'temporary' ? 'active' : ''} onClick={() => setPasswordSection('temporary')}>临时密码 <span>{temporaryPasswords.length + oneTimePasswords.length}</span></button>
            </div>
            {passwordSection === 'permanent' ? <div className="managed-passwords password-page-list" role="tabpanel">
                {passwordUserGroups.map(({ user, passwords }) => <details className="password-user-accordion" key={user.userId} open={activePasswordUserId === user.userId} onToggle={(event) => { if (event.currentTarget.open) setExpandedPasswordUserId(user.userId); else setExpandedPasswordUserId((current) => current === user.userId || activePasswordUserId === user.userId ? null : current); }}>
                  <summary>
                    <span className="password-row-icon user-icon" aria-hidden="true">人</span>
                    <span className="password-row-copy"><strong>{user.name}</strong><small>用户 {user.userId} · {passwords.length ? `${passwords.length} 个永久密码` : '暂无永久密码'}</small></span>
                    {user.userId === 0 && <span className="password-row-state">主用户</span>}
                    <span className="accordion-chevron" aria-hidden="true"><ChevronDownIcon /></span>
                  </summary>
                  <div className="password-accordion-panel">
                    {passwords.map((entry) => <div className="managed-password-row" key={entry.key}>
                      <span className="password-row-icon">#</span>
                      <span className="password-row-copy"><strong>{entry.name}</strong><small>永久密码{entry.passwordId !== null ? ` · 编号 ${entry.passwordId}` : ''}{entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleDateString('zh-CN')}` : ''}</small></span>
                      <button type="button" title={entry.deletable ? '从门锁删除这个云端密码' : '米家云端未返回可用于删除的密码编号'} disabled={loading || !entry.deletable} onClick={() => { setPasswordError(''); setDeleteUserTarget(null); setDeletePasswordTarget(entry); }}>删除密码</button>
                    </div>)}
                    {!passwords.length && <div className="accordion-empty-password">该用户还没有永久密码</div>}
                    {user.userId !== 0 && <div className="password-user-danger-zone"><span><strong>用户操作</strong><small>删除用户会同时删除其名下全部永久密码</small></span><button type="button" disabled={loading} onClick={() => { setPasswordError(''); setDeletePasswordTarget(null); setDeleteUserTarget(user); }}>删除整个用户</button></div>}
                  </div>
                </details>)}
                {ungroupedPasswords.length > 0 && <section className="ungrouped-passwords"><div className="ungrouped-passwords-head"><strong>其他密码</strong><small>未归入门锁用户的云端记录</small></div>{ungroupedPasswords.map((entry) => <div className="managed-password-row" key={entry.key}>
                  <span className="password-row-icon">#</span>
                  <span className="password-row-copy"><strong>{entry.name}</strong><small>{passwordUserNames.get(entry.userId) || `用户 ${entry.userId}`} · 永久密码{entry.passwordId !== null ? ` · 编号 ${entry.passwordId}` : ''}{entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleDateString('zh-CN')}` : ''}</small></span>
                  <button type="button" title={entry.deletable ? '从门锁删除这个云端密码' : '米家云端未返回可用于删除的密码编号'} disabled={loading || !entry.deletable} onClick={() => { setPasswordError(''); setDeleteUserTarget(null); setDeletePasswordTarget(entry); }}>删除密码</button>
                </div>)}</section>}
                {!passwordUserGroups.length && !ungroupedPasswords.length && <div className="password-list-empty"><span>#</span><strong>{passwordSyncing ? '正在读取米家云端…' : '暂无永久密码'}</strong><p>米家云端尚未返回用户或永久密码记录。</p></div>}
              </div> : <div className="temporary-password-panel password-page-list" role="tabpanel">
                <section className="temporary-password-group">
                  <div className="temporary-group-head"><div><strong>自定义密码</strong><small>日本时间 · 可创建、修改和删除</small></div><span>{temporaryPasswords.length}</span></div>
                  {temporaryPasswords.map((entry) => <article className="temporary-password-row" key={entry.key}>
                    <span className="password-row-copy"><strong>{entry.name}</strong><small>{entry.startsAt && entry.endsAt ? `${formatTokyoDateTime(entry.startsAt)} — ${formatTokyoDateTime(entry.endsAt)}` : '生效时间等待米家云端同步'}{entry.passwordId !== null ? ` · 编号 ${entry.passwordId}` : ''}</small></span>
                    <span className={`temporary-state ${temporaryPasswordStatus(entry) === '生效中' ? 'active' : ''}`}>{temporaryPasswordStatus(entry)}</span>
                    <div className="temporary-row-actions"><button type="button" disabled={loading || !entry.deletable} onClick={() => openTemporaryEditor(entry)}>修改</button><button type="button" className="danger" disabled={loading || !entry.deletable} onClick={() => { setPasswordError(''); setTemporaryEditorOpen(false); setDeleteTemporaryTarget(entry); }}>删除</button></div>
                  </article>)}
                  {!temporaryPasswords.length && <div className="temporary-group-empty"><strong>{passwordSyncing ? '正在同步…' : '暂无自定义密码'}</strong><small>点击右上角“临时密码”创建。</small></div>}
                </section>
                <section className="temporary-password-group one-time-password-group">
                  <div className="temporary-group-head"><div><strong>APP一次性密码</strong><small>米家 App 云端记录 · 密码内容不在列表中保存</small></div><span>{oneTimePasswords.length}</span></div>
                  {oneTimePasswords.map((entry) => <article className="one-time-password-row" key={entry.key}>
                    <span className="password-row-copy"><strong>一次性密码</strong><small>{formatTokyoDateTime(entry.startsAt)} — {formatTokyoDateTime(entry.endsAt)}</small></span>
                    <span className="temporary-state active">有效期内</span>
                  </article>)}
                  {!oneTimePasswords.length && <div className="temporary-group-empty compact"><strong>{passwordSyncing ? '正在同步…' : '暂无有效的一次性密码'}</strong><small>这里与米家 App 的一次性密码云端列表保持一致。</small></div>}
                </section>
              </div>}
          </section>
        </div>}
      </section>

      {loginOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <section className="login-modal">
          <button className="modal-close" onClick={() => auth && setLoginOpen(false)} aria-label="关闭">×</button>
          <span className="modal-badge">{region}</span><p className="section-kicker">{regionName}区账号</p><h2 id="login-title">二维码授权登录</h2>
          <div className="login-region-select"><span>设备地区</span><CustomSelect className="login-region-dropdown" value={region} options={[{ value: 'JP', label: '日本（JP）' }, { value: 'CN', label: '中国（CN）' }]} ariaLabel="选择设备地区" onChange={(nextRegion) => switchRegion(nextRegion as XiaomiRegion)} /></div>
          <div className={`qr-frame${qr ? '' : ' is-loading'}`} aria-live="polite">
            {qr
              ? <Image unoptimized src={qr.qrUrl} alt="小米账号登录二维码" width={198} height={198} />
              : <div className="qr-placeholder"><i /><strong>{qrState === 'error' ? '二维码生成失败' : '正在生成二维码…'}</strong></div>}
          </div>
          <p className="qr-hint"><strong>{qrState === 'error' ? '请刷新二维码后重试' : '请使用米家 App 扫码确认'}</strong><span>请从 App 内的通用扫码入口进入，不要使用系统相机或“添加设备”扫码。</span></p>
          <div className="qr-lifetime"><span>约 2 分钟有效</span><small>过期后请刷新二维码</small></div>
          <button className="secondary-button wide qr-refresh" type="button" onClick={regenerateQr} disabled={loading}>{loading ? '正在生成二维码…' : '↻ 刷新二维码'}</button>
        </section>
      </div>}
      {passwordManagerOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="password-manager-title">
        <section className="confirm-modal password-manager-modal">
          <button className="modal-close" onClick={() => { setPasswordManagerOpen(false); setPasswordPin(''); setPasswordUserName(''); setPasswordName(''); setPasswordUserTarget(''); setPasswordError(''); setDeletePasswordTarget(null); }} aria-label="关闭">×</button>
          <span className="modal-badge">#</span><p className="section-kicker">{currentRoom?.roomName} · {selected?.name}</p><h2 id="password-manager-title">添加永久密码</h2>
          <p>{spec ? '选择密码所属用户；新增用户可自定义用户名称。用户名称和密码名称会写入米家云。' : '正在读取门锁的密码管理能力…'}</p>
          <form className="password-create-form" onSubmit={(event) => void createManagedPassword(event)}>
            <div className="password-create-field"><RequiredLabel>添加到</RequiredLabel><CustomSelect className="form-custom-select" value={passwordUserTarget} options={[{ value: 'new', label: '＋ 新增用户（自动分配用户编号）' }, ...passwordUsers.map((user) => ({ value: `user:${user.userId}`, label: `${user.name} · ${user.passwordCount} 个密码` }))]} placeholder="选择已有用户或新增用户" ariaLabel="密码所属用户，必填" required onChange={(target) => { setPasswordUserTarget(target); if (target !== 'new') setPasswordUserName(''); setPasswordError(''); }} /><small>新增用户会自动分配门锁用户编号，名称同步到米家 App。</small></div>
            {passwordUserTarget === 'new' && <label><RequiredLabel>用户名称</RequiredLabel><input type="text" maxLength={32} value={passwordUserName} onChange={(event) => { setPasswordUserName(event.target.value); setPasswordError(''); }} placeholder="例如：张先生、保洁人员、101 住客" autoComplete="off" aria-label="用户名称，必填" required /></label>}
            <label><RequiredLabel>密码名称</RequiredLabel><input type="text" maxLength={32} value={passwordName} onChange={(event) => { setPasswordName(event.target.value); setPasswordError(''); }} placeholder="例如：保洁、前台、长期住客" autoComplete="off" aria-label="密码名称，必填" required /></label>
            <label><RequiredLabel>6 位门锁密码</RequiredLabel><input className="password-native-input" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={passwordPin} onChange={(event) => { setPasswordPin(event.target.value.replace(/\D/g, '').slice(0, 6)); setPasswordError(''); }} placeholder="输入 6 位数字" autoComplete="new-password" aria-label="6 位门锁密码，必填" required /></label>
            <button className="primary-button wide" type="submit" disabled={loading || !passwordManagementSupported || !passwordUserTarget || (passwordUserTarget === 'new' && !passwordUserName.trim()) || !passwordName.trim() || passwordPin.length !== 6}>{loading || !spec ? '正在创建并同步…' : '确认添加'}</button>
          </form>
          <div className="password-security-note"><span>✓</span><p><strong>不在浏览器保存</strong><small>用户关系、密码名称和密码记录均以下发后米家云端重新同步的结果为准。</small></p></div>
        </section>
      </div>}
      {temporaryEditorOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="temporary-password-title">
        <section className="confirm-modal password-manager-modal temporary-password-modal">
          <button className="modal-close" onClick={() => { if (!loading) { setTemporaryEditorOpen(false); setTemporaryEditorTarget(null); setTemporaryPin(''); setPasswordError(''); } }} aria-label="关闭临时密码编辑">×</button>
          <span className="modal-badge temporary">时</span><p className="section-kicker">{currentRoom?.roomName} · {selected?.name}</p><h2 id="temporary-password-title">{temporaryEditorTarget ? '修改临时密码' : '创建临时密码'}</h2>
          <p>{temporaryEditorTarget ? '更新名称和有效时段，原数字密码保持不变；结果以米家云端重新同步为准。' : '系统自动生成仅在指定时段内有效的 6 位密码。'}</p>
          <form className="password-create-form temporary-password-form" onSubmit={(event) => void saveTemporaryPassword(event)}>
            <label><RequiredLabel>临时密码名称</RequiredLabel><input type="text" maxLength={32} value={temporaryName} onChange={(event) => { setTemporaryName(event.target.value); setPasswordError(''); }} placeholder="例如：8 月 25 日保洁" autoComplete="off" aria-label="临时密码名称，必填" required /></label>
            {!temporaryEditorTarget && <div className="temporary-generated-field">
              <RequiredLabel>6 位临时密码</RequiredLabel>
              <div className="temporary-generated-row">
                <input className="password-native-input" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={temporaryPin} onChange={(event) => { setTemporaryPin(event.target.value.replace(/\D/g, '').slice(0, 6)); setPasswordError(''); }} aria-label="6 位临时密码，必填" required />
                <button type="button" className="temporary-regenerate-button" disabled={loading} onClick={() => { setTemporaryPin(generatedTemporaryPin()); setPasswordError(''); }}>换一个</button>
              </div>
              <small>默认自动生成；可以直接手动修改，或点击“换一个”重新生成。创建并经米家云确认后才会提供一键复制。</small>
            </div>}
            {temporaryEditorTarget && <div className="temporary-edit-protocol-note"><strong>数字密码保持不变</strong><span>D100J 的编辑指令只更新名称与时段；如需更换数字密码，请删除后重新创建。</span></div>}
            <div className="temporary-timezone-note"><strong>日本标准时间</strong><span>JST / UTC+9 · 下方两个时间均按日本时区解析</span></div>
            <div className="temporary-time-grid">
              <DateTimeField label="生效时间" value={temporaryStartsAt} onChange={(value) => { setTemporaryStartsAt(value); setPasswordError(''); }} ariaLabel="临时密码生效时间" />
              <DateTimeField label="失效时间" value={temporaryEndsAt} onChange={(value) => { setTemporaryEndsAt(value); setPasswordError(''); }} ariaLabel="临时密码失效时间" />
            </div>
            <button className="primary-button wide" type="submit" disabled={loading || !temporaryPasswordManagementSupported || !temporaryName.trim() || (!temporaryEditorTarget && temporaryPin.length !== 6) || !temporaryStartsAt || !temporaryEndsAt}>{loading ? '正在下发并同步…' : temporaryEditorTarget ? '确认修改' : '确认创建'}</button>
          </form>
          <div className="password-security-note"><span>✓</span><p><strong>不在浏览器保存</strong><small>{temporaryEditorTarget ? '名称、有效时段和记录以米家云端为准。' : '密码仅保留到成功凭证关闭，不会写入浏览器存储。'}</small></p></div>
        </section>
      </div>}
      {temporaryReceipt && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="temporary-receipt-title">
        <section className="confirm-modal password-manager-modal temporary-receipt-modal">
          <button className="modal-close" onClick={() => setTemporaryReceipt(null)} aria-label="关闭临时密码凭证">×</button>
          <span className="temporary-receipt-mark">✓</span><p className="section-kicker">{currentRoom?.roomName} · {selected?.name}</p><h2 id="temporary-receipt-title">保存临时密码</h2>
          <p>以下内容仅在本次创建成功后显示。请复制并妥善发送给使用者。</p>
          <div className="temporary-receipt-card">
            <span>临时密码</span><strong>{temporaryReceipt.pin}</strong>
            <dl>
              <div><dt>名称</dt><dd>{temporaryReceipt.name}</dd></div>
              <div><dt>生效</dt><dd>{temporaryReceipt.startsAt.replace('T', ' ')}</dd></div>
              <div><dt>失效</dt><dd>{temporaryReceipt.endsAt.replace('T', ' ')}</dd></div>
              <div><dt>时区</dt><dd>日本标准时间 JST / UTC+9</dd></div>
            </dl>
          </div>
          <button type="button" className="primary-button wide temporary-receipt-copy" onClick={() => void copyTemporaryPasswordDetails()}>一键复制全部内容</button>
          <div className="password-security-note"><span>✓</span><p><strong>关闭即清空</strong><small>此凭证不会写入浏览器本地存储；关闭后只能在米家 App 管理记录，不能再次查看数字密码。</small></p></div>
        </section>
      </div>}
      {deleteTemporaryTarget && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-temporary-password-title">
        <section className="confirm-modal password-delete-modal">
          <button className="modal-close" onClick={() => { if (!loading) { setDeleteTemporaryTarget(null); setPasswordError(''); } }} aria-label="关闭临时密码删除确认">×</button>
          <span className="warning-mark">!</span><p className="section-kicker">{currentRoom?.roomName} · {selected?.name}</p><h2 id="delete-temporary-password-title">确认删除临时密码？</h2>
          <p>删除后，该密码会立即停止用于门锁验证。页面会等待门锁与米家云端同步完成。</p>
          <div className="password-delete-summary"><span>时</span><p><strong>{deleteTemporaryTarget.name}</strong><small>{deleteTemporaryTarget.startsAt && deleteTemporaryTarget.endsAt ? `${formatTokyoDateTime(deleteTemporaryTarget.startsAt)} — ${formatTokyoDateTime(deleteTemporaryTarget.endsAt)} · 日本时间` : `访客 ${deleteTemporaryTarget.userId}`}</small></p></div>
          <div className="modal-actions"><button disabled={loading} onClick={() => { setDeleteTemporaryTarget(null); setPasswordError(''); }}>取消</button><button className="danger-button" disabled={loading} onClick={() => void deleteTemporaryPassword(deleteTemporaryTarget)}>{loading ? '正在删除并同步…' : '确认删除'}</button></div>
        </section>
      </div>}
      {deletePasswordTarget && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-password-title">
        <section className="confirm-modal password-delete-modal">
          <button className="modal-close" onClick={() => { if (!loading) { setDeletePasswordTarget(null); setPasswordError(''); } }} aria-label="关闭删除确认">×</button>
          <span className="warning-mark">!</span><p className="section-kicker">{currentRoom?.roomName} · {selected?.name}</p><h2 id="delete-password-title">确认删除密码？</h2>
          <p>删除后，这个密码将立即停止用于门锁验证。页面会在接口完成后重新读取米家云端列表。</p>
          <div className="password-delete-summary"><span>#</span><p><strong>{deletePasswordTarget.name}</strong><small>{deletePasswordTarget.kind === 'visitor'
            ? `访客 ${deletePasswordTarget.userId} · 临时密码`
            : `${passwordUserNames.get(deletePasswordTarget.userId) || `用户 ${deletePasswordTarget.userId}`} · 永久密码`}{deletePasswordTarget.passwordId !== null ? ` · 编号 ${deletePasswordTarget.passwordId}` : ''}</small></p></div>
          <div className="modal-actions"><button disabled={loading} onClick={() => { setDeletePasswordTarget(null); setPasswordError(''); }}>取消</button><button className="danger-button" disabled={loading} onClick={() => void deleteManagedPassword(deletePasswordTarget)}>{loading ? '正在删除并同步…' : '确认删除'}</button></div>
        </section>
      </div>}
      {deleteUserTarget && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
        <section className="confirm-modal password-delete-modal user-delete-modal">
          <button className="modal-close" onClick={() => { if (!loading) { setDeleteUserTarget(null); setPasswordError(''); } }} aria-label="关闭删除用户确认">×</button>
          <span className="warning-mark">!</span><p className="section-kicker">高风险操作 · {currentRoom?.roomName} · {selected?.name}</p><h2 id="delete-user-title">删除整个用户？</h2>
          <p className="user-delete-impact">这不是删除单个密码：该用户及其名下全部永久密码都会立即失效。</p>
          <div className="password-delete-summary"><span>人</span><p><strong>{deleteUserTarget.name}</strong><small>用户 {deleteUserTarget.userId} · {deleteUserTarget.passwordCount} 个永久密码将一并删除</small></p></div>
          <div className="modal-actions"><button disabled={loading} onClick={() => { setDeleteUserTarget(null); setPasswordError(''); }}>取消</button><button className="danger-button" disabled={loading} onClick={() => void deleteManagedUser(deleteUserTarget)}>{loading ? '正在删除用户并同步…' : '删除用户及全部密码'}</button></div>
        </section>
      </div>}
      {operationLogsOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="operation-logs-title">
        <section className="confirm-modal operation-logs-modal">
          <button className="modal-close" onClick={() => setOperationLogsOpen(false)} aria-label="关闭开关记录">×</button>
          <div className="operation-logs-head"><span className="modal-badge"><HistoryIcon /></span><div><p className="section-kicker">{currentRoom?.roomName} · {selected?.name}</p><h2 id="operation-logs-title">门锁开关记录</h2></div></div>
          <div className="operation-logs-toolbar"><p>{operationLogsSyncedAt ? `米家云端 · 更新于 ${new Date(operationLogsSyncedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '最近 90 天 · 最多 50 条'}</p><button type="button" disabled={operationLogsLoading || !selected} onClick={() => selected && void loadOperationLogs(selected.did, selected.model).catch(() => undefined)}>{operationLogsLoading ? '同步中…' : '↻ 刷新'}</button></div>
          <div className="operation-log-list" aria-live="polite">
            {operationLogs.map((entry) => <article className={`operation-log-row ${entry.action}`} key={entry.key}>
              <span className="operation-log-icon">{entry.action === 'unlock' ? <LockIcon open /> : entry.action === 'lock' ? <LockIcon /> : entry.action === 'door' ? '▯' : entry.action === 'failure' ? '!' : '•'}</span>
              <p><strong>{entry.title}</strong><small>{entry.detail}</small></p>
              <time dateTime={new Date(entry.time).toISOString()}><strong>{new Date(entry.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</strong><small>{new Date(entry.time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</small></time>
            </article>)}
            {operationLogsLoading && !operationLogs.length && <div className="operation-logs-empty loading"><i /><strong>正在读取米家云端记录…</strong><small>记录不会保存到浏览器本地</small></div>}
            {!operationLogsLoading && operationLogsError && <div className="operation-logs-empty error"><span>!</span><strong>开关记录读取失败</strong><small>{operationLogsError}</small><button type="button" disabled={!selected} onClick={() => selected && void loadOperationLogs(selected.did, selected.model).catch(() => undefined)}>重新读取</button></div>}
            {!operationLogsLoading && !operationLogsError && !operationLogs.length && <div className="operation-logs-empty"><span><HistoryIcon /></span><strong>暂无开关记录</strong><small>米家云端最近 90 天没有返回这把门锁的开关事件</small></div>}
          </div>
          <p className="operation-logs-footnote">仅显示设备上报到米家云端的真实记录，打开弹窗或点击刷新时重新同步。</p>
        </section>
      </div>}
      {logoutConfirmOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="logout-confirm-title">
        <section className="confirm-modal logout-confirm-modal">
          <button className="modal-close" onClick={() => setLogoutConfirmOpen(false)} aria-label="关闭退出确认">×</button>
          <span className="warning-mark">!</span><p className="section-kicker">当前浏览器会话</p><h2 id="logout-confirm-title">确认退出登录？</h2>
          <p>退出后会清除当前浏览器中的米家登录信息，需要重新验证账号才能继续管理门锁。手机米家 App 不受影响。</p>
          <div className="logout-account-summary"><span>K</span><p><strong>{auth?.userId || '小米账号'}</strong><small>{regionName}区 · 当前已连接</small></p></div>
          <div className="modal-actions"><button type="button" onClick={() => setLogoutConfirmOpen(false)}>取消</button><button type="button" className="danger-button" onClick={logout}>确认退出</button></div>
        </section>
      </div>}
      {confirmAction && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="remote-action-title"><section className="confirm-modal remote-action-modal"><span className="warning-mark">!</span><p className="section-kicker">{regionName}区远程指令</p><h2 id="remote-action-title">确认操作 {currentRoom?.roomName} · {selected?.name}</h2><p>即将通过米家云远程执行“{confirmAction.description}”。请确认房门附近安全，并且这是你本人发起的请求。</p><button className="action-details-toggle" type="button" aria-expanded={actionDetailsOpen} aria-controls="remote-action-details" onClick={() => setActionDetailsOpen((open) => !open)}><span>{actionDetailsOpen ? '收起详情' : '查看详情'}</span><ChevronDownIcon /></button>{actionDetailsOpen && <div className="action-details-panel" id="remote-action-details"><div className="remote-endpoint"><span>POST</span><code>/miotspec/action</code><small>siid {confirmAction.siid} · aiid {confirmAction.aiid}</small></div>{confirmAction.inputPiids.length > 0 && <div className="automatic-secret-note"><span>✓</span><p><strong>动态密文由服务端自动处理</strong><small>通常会直接使用门锁返回的下一枚密文；首次使用或缓存失效时才重新握手。</small></p></div>}</div>}<div className="modal-actions"><button onClick={closeActionConfirm}>取消</button><button className="danger-button" onClick={() => void runAction(confirmAction)} disabled={loading}>{loading ? '正在确认真实状态…' : '确认远程下发'}</button></div></section></div>}
    </main>
  );
}
