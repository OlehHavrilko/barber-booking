export const BARBERS = [
  { id: 'maks', name: 'Максим', role: 'Старший барбер', initials: 'МК', color: '#d5decc' },
  { id: 'artem', name: 'Артем', role: 'Барбер', initials: 'АР', color: '#e4d5c5' },
  { id: 'dan', name: 'Данило', role: 'Барбер', initials: 'ДН', color: '#d4dae0' },
];
export const DEFAULT_CONFIG = {
  open: 600, close: 1200, weekdays: [1, 2, 3, 4, 5, 6, 0],
  services: [
    { id: 'cut', name: 'Чоловіча стрижка', description: 'Консультація, стрижка та укладка', duration: 60, price: 650, tag: 'Вибір клієнтів' },
    { id: 'beard', name: 'Борода та контур', description: 'Моделювання бороди й чіткі лінії', duration: 30, price: 400 },
    { id: 'combo', name: 'Стрижка + борода', description: 'Повне оновлення твого образу', duration: 90, price: 950, tag: 'Комплекс' },
    { id: 'buzz', name: 'Стрижка машинкою', description: 'Одна довжина, чиста форма', duration: 30, price: 350 },
  ],
};
export const money = n => new Intl.NumberFormat('uk-UA').format(n) + ' ₴';
export const time = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export function kyivNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export function addDays(date, days) {
  const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function dateLabel(date, options = { day: 'numeric', month: 'long' }) {
  return new Intl.DateTimeFormat('uk-UA', { ...options, timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
}
export function validDate(date, today) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && addDays(date, 0) === date && date >= today && date <= addDays(today, 30);
}
export function availableSlots(config, date, barber, duration, bookings, now = kyivNow()) {
  if (!validDate(date, now.date) || !config.weekdays.includes(new Date(date + 'T12:00:00Z').getUTCDay())) return [];
  const busy = bookings.filter(b => b.date === date && b.barber === barber && b.status !== 'cancelled');
  const slots = [];
  for (let start = config.open; start + duration <= config.close; start += 15) {
    if (date === now.date && start <= now.minute + 15) continue;
    if (!busy.some(b => start < b.start + b.duration && start + duration > b.start)) slots.push(start);
  }
  return slots;
}
export function validateConfig(c) {
  if (!c || !Number.isInteger(c.open) || !Number.isInteger(c.close) || c.open < 0 || c.close > 1440 || c.close - c.open < 90 || c.open % 15 || c.close % 15 || !Array.isArray(c.weekdays) || !c.weekdays.length || c.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6) || !Array.isArray(c.services) || c.services.length !== DEFAULT_CONFIG.services.length) return false;
  const ids = new Set();
  for (const s of c.services) {
    if (!s || !DEFAULT_CONFIG.services.some(d => d.id === s.id) || ids.has(s.id) || typeof s.name !== 'string' || s.name.trim().length < 2 || s.name.length > 80 || typeof s.description !== 'string' || s.description.length > 180 || !Number.isInteger(s.price) || s.price < 0 || s.price > 20000 || !Number.isInteger(s.duration) || s.duration < 15 || s.duration > 180 || s.duration % 15) return false;
    ids.add(s.id);
  }
  return true;
}
