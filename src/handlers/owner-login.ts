import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";
import { localDate, reservationStore, type ReservationEnv, type VenueConfig } from "../reservations.js";

// SCAFFOLD — generated from the bot blueprint BEFORE the agent runs.
// Keep a LIVE registration (.command / .callbackQuery / …) so this feature is
// never an empty stub. Replace the reply body with real logic + copy; if you
// change the user-facing text, update tests/specs to match EXACTLY.
// Do NOT rewrite src/bot.ts — buildBot() already auto-loads this module.
// Menu: wire this into /start via registerMainMenuItem({ label: "Owner view", data: "owner:login" }) if the toolkit exposes it.

registerMainMenuItem({ label: "Owner view", data: "owner:login", order: 30 });
const composer = new Composer<Ctx>();
const envOf = (ctx: Ctx) => (ctx as Ctx & { env?: ReservationEnv }).env;

function ownerMenu() {
  return inlineKeyboard([[inlineButton("Today's bookings", "owner:today"), inlineButton("Mark no-show", "owner:noshow")], [inlineButton("Venue settings", "owner:settings"), inlineButton("Reminder timing", "owner:reminders")], [inlineButton("Back to menu", "menu:main")]]);
}

async function dashboard(ctx: Ctx) {
  const config = await reservationStore.config(envOf(ctx));
  if (!config) { await ctx.editMessageText("Set up your tables before taking reservations.", { reply_markup: inlineKeyboard([[inlineButton("Set up venue", "owner:settings")], [inlineButton("Back to menu", "menu:main")]]) }); return; }
  const date = localDate(undefined, config.timezone);
  const bookings = await reservationStore.today(envOf(ctx), date);
  const confirmed = bookings?.filter((b) => b.status === "confirmed") ?? [];
  const used = confirmed.reduce((sum, booking) => sum + booking.partySize, 0);
  await ctx.editMessageText(`Today has ${confirmed.length} booking${confirmed.length === 1 ? "" : "s"}. ${Math.max(0, config.totalSeats - used)} seats remain.`, { reply_markup: ownerMenu() });
}

composer.callbackQuery("owner:login", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx))) return;
  await dashboard(ctx);
});

composer.callbackQuery("owner:today", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const config = await reservationStore.config(envOf(ctx)); if (!config) { await dashboard(ctx); return; } const bookings = await reservationStore.today(envOf(ctx), localDate(undefined, config.timezone)); const visible = (bookings ?? []).filter((b) => b.status === "confirmed"); await ctx.editMessageText(visible.length ? `Today's bookings:\n${visible.map((b) => `${b.startTime} — ${b.partySize} guests`).join("\n")}` : "No bookings today — your dining room is clear.", { reply_markup: ownerMenu() }); });
composer.callbackQuery("owner:noshow", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const config = await reservationStore.config(envOf(ctx)); if (!config) { await dashboard(ctx); return; } const bookings = (await reservationStore.today(envOf(ctx), localDate(undefined, config.timezone)))?.filter((b) => b.status === "confirmed") ?? []; if (!bookings.length) { await ctx.editMessageText("No confirmed bookings to mark today.", { reply_markup: ownerMenu() }); return; } await ctx.editMessageText("Choose a booking that didn't arrive.", { reply_markup: inlineKeyboard([...bookings.map((b) => [inlineButton(`${b.startTime} — ${b.partySize} guests`, `owner:noshow:${b.id}`)]), [inlineButton("Back", "owner:login")]]) }); });
composer.callbackQuery(/^owner:noshow:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const config = await reservationStore.config(envOf(ctx)); const bookings = config ? await reservationStore.today(envOf(ctx), localDate(undefined, config.timezone)) : undefined; const booking = bookings?.find((b) => b.id === ctx.match[1] && b.status === "confirmed"); if (!booking) { await ctx.editMessageText("That booking is no longer available to mark."); return; } booking.status = "no_show"; await reservationStore.update(envOf(ctx), booking); const owner = adminChatId(ctx as Ctx & { env?: Record<string, unknown> }); if (owner) { try { await ctx.api.sendMessage(owner, `A ${booking.partySize}-guest booking was marked as a no-show.`); } catch { /* a blocked owner notification must not undo the status */ } } await ctx.editMessageText("Marked as a no-show.", { reply_markup: ownerMenu() }); });
composer.callbackQuery("owner:settings", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; ctx.session.step = "owner-config"; await ctx.editMessageText("Send opening times, duration, tables, seats, and timezone like:\n11:00,13:00,18:00 | 90 | 2x2,3x4 | 16 | Europe/London"); });
composer.callbackQuery("owner:reminders", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; ctx.session.step = "owner-config"; await ctx.reply("Send the reminder lead time in hours, for example 3."); (ctx.session as Ctx["session"] & { configMode?: "reminder" }).configMode = "reminder"; });
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "owner-config") return next();
  if (!(await requireOwner(ctx))) return;
  const state = ctx.session as Ctx["session"] & { configMode?: "reminder" };
  const existing = await reservationStore.config(envOf(ctx));
  if (state.configMode === "reminder") {
    const hours = Number(ctx.message.text.trim());
    if (!existing || !Number.isFinite(hours) || hours < 0 || hours > 72) { await ctx.reply("Send a whole number from 0 to 72."); return; }
    await reservationStore.saveConfig(envOf(ctx), { ...existing, reminderHoursBefore: Math.floor(hours) });
    state.configMode = undefined; ctx.session.step = "idle"; await ctx.reply("Reminder timing is updated."); return;
  }
  const parts = ctx.message.text.split("|").map((part) => part.trim());
  const duration = Number(parts[1]); const seats = Number(parts[3]);
  const tableCountBySize: Record<string, number> = {};
  for (const piece of (parts[2] ?? "").split(",")) { const match = piece.trim().match(/^(\d+)x(\d+)$/); if (match) tableCountBySize[match[2]] = (tableCountBySize[match[2]] ?? 0) + Number(match[1]); }
  try { Intl.DateTimeFormat("en", { timeZone: parts[4] }); } catch { await ctx.reply("That timezone isn't recognised. Try a name like Europe/London."); return; }
  const openingHours = (parts[0] ?? "").split(",").map((value) => value.trim()).filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
  if (!openingHours.length || !Number.isFinite(duration) || duration < 30 || !Object.keys(tableCountBySize).length || !Number.isFinite(seats) || seats < 1 || !parts[4]) { await ctx.reply("Use valid times, a duration of at least 30, tables like 2x2, seats, and an IANA timezone."); return; }
  const config: VenueConfig = { openingHours, sittingDuration: Math.floor(duration), tableCountBySize, totalSeats: Math.floor(seats), timezone: parts[4], reminderHoursBefore: existing?.reminderHoursBefore ?? 3 };
  await reservationStore.saveConfig(envOf(ctx), config); ctx.session.step = "idle"; await ctx.reply("Your venue is ready for reservations.");
});

export default composer;
