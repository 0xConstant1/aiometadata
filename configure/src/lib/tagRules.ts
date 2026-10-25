import type { TagDef } from '@/contexts/config';

export type TagRules = Partial<Pick<TagDef, 'viewingHours' | 'allowDownloads'>>;
export type ViewingHours = NonNullable<TagDef['viewingHours']>;

export const HOUR_PRESETS: Array<{ label: string; hours: ViewingHours | null }> = [
  { label: 'Daytime', hours: { start: '07:00', end: '20:00' } },
  { label: 'After school', hours: { start: '15:00', end: '20:00' } },
  { label: 'Evenings', hours: { start: '17:00', end: '22:00' } },
  { label: 'Any time', hours: null },
];

const DAY = 24 * 60;

export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

export function timeOf(minutes: number): string {
  const wrapped = ((minutes % DAY) + DAY) % DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

export function stepTime(time: string, halfHours: number): string {
  return timeOf(Math.round(minutesOf(time) / 30) * 30 + halfHours * 30);
}

export function inWindow(hours: ViewingHours, minute: number): boolean {
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function nowMinute(timeZone: string): number {
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return part('hour') * 60 + part('minute');
  };
  try {
    return read(timeZone);
  } catch {
    return read('UTC');
  }
}

export function samePreset(a: ViewingHours | null | undefined, b: ViewingHours | null): boolean {
  if (!a || !b) return !a && !b;
  return a.start === b.start && a.end === b.end;
}
