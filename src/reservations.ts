export type BookingStatus = "confirmed" | "cancelled" | "no_show" | "completed";

export interface VenueConfig {
  openingHours: string[];
  sittingDuration: number;
  tableCountBySize: Record<string, number>;
  totalSeats: number;
  timezone: string;
  reminderHoursBefore: number;
}

export interface Booking {
  id: string;
  chatId: number;
  guestName?: string;
  phone?: string;
  partySize: number;
  date: string;
  startTime: string;
  assignedTables: number[];
  status: BookingStatus;
  referenceCode: string;
  reminderSent?: boolean;
}

export interface ReservationEnv {
  CHAT_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: { method?: string; body?: string }): Promise<Response> } };
}

let clock: () => Date = () => new Date();
/** Injectable clock seam for reminder and availability tests. */
export function now(): Date { return clock(); }
export function setClockForTests(next?: () => Date): void { clock = next ?? (() => new Date()); }

function store(env: ReservationEnv | undefined) {
  const ns = env?.CHAT_DO;
  if (!ns) return undefined;
  return ns.get(ns.idFromName("reservations:v1"));
}

async function call<T>(env: ReservationEnv | undefined, action: string, body?: unknown): Promise<T | undefined> {
  const target = store(env);
  if (!target) return undefined;
  const response = await target.fetch(`https://do/reservations/${action}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) return undefined;
  return response.status === 204 ? undefined : (await response.json()) as T;
}

export const reservationStore = {
  config: (env: ReservationEnv | undefined) => call<VenueConfig>(env, "config"),
  saveConfig: (env: ReservationEnv | undefined, config: VenueConfig) => call<VenueConfig>(env, "config", config),
  byGuest: (env: ReservationEnv | undefined, chatId: number) => call<Booking[]>(env, `guest/${chatId}`),
  today: (env: ReservationEnv | undefined, date: string) => call<Booking[]>(env, `date/${date}`),
  available: (env: ReservationEnv | undefined, date: string) => call<string[]>(env, `availability/${date}`),
  reserve: (env: ReservationEnv | undefined, input: Omit<Booking, "id" | "assignedTables" | "status" | "referenceCode">) => call<{ booking?: Booking; error?: string }>(env, "reserve", input),
  update: (env: ReservationEnv | undefined, booking: Booking) => call<Booking>(env, `update/${booking.id}`, booking),
  reminders: (env: ReservationEnv | undefined) => call<{ due: Booking[]; noShows: Booking[] }>(env, "reminders"),
};

export function localDate(date = now(), timezone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (part: string) => parts.find((p) => p.type === part)?.value ?? "01";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function nextDates(timezone: string): string[] {
  const start = new Date(`${localDate(now(), timezone)}T12:00:00Z`).getTime();
  return Array.from({ length: 30 }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

export function slots(config: VenueConfig): string[] {
  return config.openingHours.filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
}

export function referenceFor(input: Pick<Booking, "chatId" | "date" | "startTime" | "partySize">): string {
  return `RMT-${input.date.replaceAll("-", "").slice(2)}-${input.startTime.replace(":", "")}-${input.chatId.toString(36).toUpperCase()}-${input.partySize}`;
}
