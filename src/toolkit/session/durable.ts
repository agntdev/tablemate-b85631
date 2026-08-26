/**
 * Durable Object session storage + exact-time reminders for the Cloudflare
 * Workers runtime (docs/cloudflare/new-projects-on-cf.md §1, §10).
 *
 * One ChatDO instance per chat (addressed by idFromName("chat:<chatId>")). It
 * holds:
 *   - the grammY session (strongly consistent, serialized per chat for free);
 *   - that chat's reminders, with a single Durable Object ALARM armed to the
 *     earliest due one. The alarm fires at the wall-clock time even when nothing
 *     is running — this is what replaces per-bot cron + Redis (PoC: 0–1 ms).
 *
 * NONE of this is imported by the Node/long-poll entry or the test harness, so
 * `node:fs`, Redis, and this file's Workers-only globals never load there.
 */

import type { StorageAdapter } from "grammy";
import { now, referenceFor, type Booking, type VenueConfig } from "../../reservations.js";

// Minimal shapes so this file type-checks without pulling @cloudflare/workers-types
// into the Node build. The real bindings are provided by the Workers runtime.
export interface DOState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(entries: Record<string, unknown>): Promise<void>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
  blockConcurrencyWhile(fn: () => Promise<void>): void;
}
export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DOStub;
}
export interface DOStub {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<Response>;
}
export interface WorkerEnv {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  CHAT_DO: DONamespace;
  DB?: unknown; // D1 binding (app data); see AGENTS.md
  BOT_TELEMETRY_URL?: string;
  BOT_TELEMETRY_SECRET?: string;
  BOT_TELEMETRY_SALT?: string;
  ADMIN_CHAT_ID?: string;
}

interface Reminder {
  at: number; // epoch ms
  chatId: number | string;
  text: string;
}

/**
 * createDurableSessionStorage — a grammY StorageAdapter that routes each session
 * key to its own ChatDO instance. Pass to buildBot({ storage }) in the Worker.
 */
export function createDurableSessionStorage<T>(env: WorkerEnv): StorageAdapter<T> {
  const stub = (key: string): DOStub => {
    // A missing binding otherwise surfaces as the opaque "Cannot read
    // properties of undefined (reading 'get')" — live: canary #2 shipped with
    // the binding misnamed CHATDO and every update threw exactly that.
    if (!env.CHAT_DO) {
      throw new Error(
        "CHAT_DO Durable Object binding is missing — the deploy must bind class ChatDO as CHAT_DO (see cf.meta.json)",
      );
    }
    return env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + key));
  };
  return {
    async read(key: string): Promise<T | undefined> {
      const r = await stub(key).fetch("https://do/session", { method: "GET" });
      if (r.status === 204) return undefined;
      return (await r.json()) as T;
    },
    async write(key: string, value: T): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "PUT", body: JSON.stringify(value) });
    },
    async delete(key: string): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "DELETE" });
    },
  };
}

/**
 * remindAt — schedule a one-shot reminder DM for `chatId` at `whenEpochMs`.
 * Backed by the chat's ChatDO alarm; fires within a millisecond of the target
 * even if the Worker was idle. Call from a handler under the Workers runtime
 * (via ctx.env). No-op-safe: a scheduling failure never throws into the update.
 */
export async function remindAt(
  env: WorkerEnv,
  chatId: number | string,
  whenEpochMs: number,
  text: string,
): Promise<void> {
  try {
    const stub = env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + chatId));
    await stub.fetch("https://do/remind", {
      method: "POST",
      body: JSON.stringify({ at: whenEpochMs, chatId, text } satisfies Reminder),
    });
  } catch {
    /* best-effort: a reminder we couldn't schedule must not break the reply */
  }
}

async function tg(token: string, method: string, payload: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * ChatDO — the per-chat Durable Object. Its class name is referenced in
 * cf.meta.json (new_sqlite_classes) so the deployer registers the migration.
 * Constructed by the runtime with (state, env).
 */
export class ChatDO {
  constructor(
    private readonly state: DOState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Session storage (routed here by createDurableSessionStorage).
    if (url.pathname === "/session") {
      if (request.method === "GET") {
        const v = await this.state.storage.get<unknown>("session");
        if (v === undefined) return new Response(null, { status: 204 });
        return Response.json(v);
      }
      if (request.method === "PUT") {
        await this.state.storage.put("session", await request.json());
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        await this.state.storage.delete("session");
        return new Response(null, { status: 204 });
      }
    }

    // Schedule a reminder + (re)arm the alarm to the earliest due one.
    if (url.pathname === "/remind" && request.method === "POST") {
      const rem = (await request.json()) as Reminder;
      const list = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
      list.push(rem);
      await this.state.storage.put("reminders", list);
      await this.rearm(list);
      return new Response(null, { status: 204 });
    }

    if (url.pathname.startsWith("/reservations/")) {
      return this.reservations(url.pathname.slice("/reservations/".length), request);
    }

    return new Response("not found", { status: 404 });
  }

  private async reservations(action: string, request: Request): Promise<Response> {
    const read = <T>(key: string) => this.state.storage.get<T>(key);
    const configKey = "venue:config";
    if (action === "config") {
      if (request.method === "GET") {
        const config = await read<VenueConfig>(configKey);
        return config ? Response.json(config) : new Response(null, { status: 204 });
      }
      const config = await request.json() as VenueConfig;
      await this.state.storage.put(configKey, config);
      return Response.json(config);
    }
    if (action.startsWith("guest/") || action.startsWith("date/")) {
      const key = action.startsWith("guest/") ? `booking:guest:${action.slice(6)}` : `booking:date:${action.slice(5)}`;
      const ids = (await read<string[]>(key)) ?? [];
      const bookings: Booking[] = [];
      for (const id of ids) { const booking = await read<Booking>(`booking:${id}`); if (booking) bookings.push(booking); }
      return Response.json(bookings);
    }
    if (action.startsWith("availability/")) {
      const config = await read<VenueConfig>(configKey);
      if (!config) return Response.json([]);
      const date = action.slice("availability/".length);
      const ids = (await read<string[]>(`booking:date:${date}`)) ?? [];
      const bookings: Booking[] = [];
      for (const id of ids) { const booking = await read<Booking>(`booking:${id}`); if (booking?.status === "confirmed") bookings.push(booking); }
      const available = config.openingHours.filter((time) => assignTables(config, 1, bookings.filter((booking) => booking.startTime === time).flatMap((booking) => booking.assignedTables)).length > 0);
      return Response.json(available);
    }
    if (action === "reserve" && request.method === "POST") {
      const input = await request.json() as Omit<Booking, "id" | "assignedTables" | "status" | "referenceCode">;
      const config = await read<VenueConfig>(configKey);
      if (!config) return Response.json({ error: "not_configured" });
      const dateKey = `booking:date:${input.date}`;
      const ids = (await read<string[]>(dateKey)) ?? [];
      const concurrent: Booking[] = [];
      for (const id of ids) { const booking = await read<Booking>(`booking:${id}`); if (booking?.status === "confirmed" && booking.startTime === input.startTime) concurrent.push(booking); }
      const used = concurrent.reduce((sum, booking) => sum + booking.partySize, 0);
      if (used + input.partySize > config.totalSeats) return Response.json({ error: "full" });
      const tables = assignTables(config, input.partySize, concurrent.flatMap((booking) => booking.assignedTables));
      const capacity = tables.length;
      if (capacity === 0) return Response.json({ error: "full" });
      const id = `${input.chatId}-${input.date.replaceAll("-", "")}-${input.startTime.replace(":", "")}-${input.partySize}`;
      const booking: Booking = { ...input, id, assignedTables: tables, status: "confirmed", referenceCode: referenceFor(input) };
      await this.state.storage.put(`booking:${id}`, booking);
      if (!ids.includes(id)) await this.state.storage.put(dateKey, [...ids, id]);
      const guestKey = `booking:guest:${input.chatId}`;
      const guestIds = (await read<string[]>(guestKey)) ?? [];
      if (!guestIds.includes(id)) await this.state.storage.put(guestKey, [...guestIds, id]);
      const dates = (await read<string[]>("booking:dates")) ?? [];
      if (!dates.includes(input.date)) await this.state.storage.put("booking:dates", [...dates, input.date]);
      return Response.json({ booking });
    }
    if (action.startsWith("update/") && request.method === "POST") {
      const id = action.slice(7); const next = await request.json() as Booking;
      const previous = await read<Booking>(`booking:${id}`);
      if (!previous || previous.chatId !== next.chatId) return new Response(null, { status: 404 });
      if (previous.date !== next.date || previous.startTime !== next.startTime) {
        const config = await read<VenueConfig>(configKey);
        const ids = (await read<string[]>(`booking:date:${next.date}`)) ?? [];
        const concurrent: Booking[] = [];
        for (const candidateId of ids) { const candidate = await read<Booking>(`booking:${candidateId}`); if (candidate && candidate.id !== id && candidate.status === "confirmed" && candidate.startTime === next.startTime) concurrent.push(candidate); }
        if (!config || !assignTables(config, next.partySize, concurrent.flatMap((booking) => booking.assignedTables)).length) return new Response(null, { status: 409 });
        next.assignedTables = assignTables(config, next.partySize, concurrent.flatMap((booking) => booking.assignedTables));
        const oldIds = (await read<string[]>(`booking:date:${previous.date}`)) ?? [];
        await this.state.storage.put(`booking:date:${previous.date}`, oldIds.filter((candidate) => candidate !== id));
        if (!ids.includes(id)) await this.state.storage.put(`booking:date:${next.date}`, [...ids, id]);
        const dates = (await read<string[]>("booking:dates")) ?? [];
        if (!dates.includes(next.date)) await this.state.storage.put("booking:dates", [...dates, next.date]);
      }
      await this.state.storage.put(`booking:${id}`, next);
      return Response.json(next);
    }
    if (action === "reminders") {
      const config = await read<VenueConfig>(configKey);
      if (!config) return Response.json([]);
      const dates = (await read<string[]>("booking:dates")) ?? [];
      const current = now().getTime(); const due: Booking[] = []; const noShows: Booking[] = [];
      for (const date of dates) for (const id of (await read<string[]>(`booking:date:${date}`)) ?? []) {
        const booking = await read<Booking>(`booking:${id}`);
        if (!booking || booking.status !== "confirmed") continue;
        const startsAt = zonedEpoch(booking.date, booking.startTime, config.timezone);
        if (startsAt <= current) { booking.status = "no_show"; await this.state.storage.put(`booking:${id}`, booking); noShows.push(booking); continue; }
        if (!booking.reminderSent && startsAt - config.reminderHoursBefore * 3_600_000 <= current) { booking.reminderSent = true; await this.state.storage.put(`booking:${id}`, booking); due.push(booking); }
      }
      return Response.json({ due, noShows });
    }
    return new Response("not found", { status: 404 });
  }

  // Fires at the earliest reminder's wall-clock time. Sends every due reminder,
  // drops them, and re-arms for whatever remains.
  async alarm(): Promise<void> {
    const now = Date.now();
    const list = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
    const due = list.filter((r) => r.at <= now);
    const rest = list.filter((r) => r.at > now);
    for (const r of due) {
      await tg(this.env.BOT_TOKEN, "sendMessage", { chat_id: r.chatId, text: r.text });
    }
    await this.state.storage.put("reminders", rest);
    await this.rearm(rest);
  }

  private async rearm(list: Reminder[]): Promise<void> {
    if (list.length === 0) return;
    const next = Math.min(...list.map((r) => r.at));
    const current = await this.state.storage.getAlarm();
    if (current === null || next < current) {
      await this.state.storage.setAlarm(next);
    }
  }
}

function assignTables(config: VenueConfig, partySize: number, occupied: number[]): number[] {
  const taken = new Set(occupied); const tables: number[] = []; let capacity = 0; let tableNo = 1;
  for (const [sizeText, count] of Object.entries(config.tableCountBySize).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    for (let i = 0; i < count; i += 1) { if (!taken.has(tableNo) && capacity < partySize) { tables.push(tableNo); capacity += Number(sizeText); } tableNo += 1; }
    if (capacity >= partySize) return tables;
  }
  return [];
}

function zonedEpoch(date: string, time: string, timezone: string): number {
  const [year, month, day] = date.split("-").map(Number); const [hour, minute] = time.split(":").map(Number);
  let epoch = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(epoch));
    const part = (kind: string) => Number(parts.find((p) => p.type === kind)?.value ?? 0);
    const shown = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    epoch += Date.UTC(year, month - 1, day, hour, minute) - shown;
  }
  return epoch;
}
