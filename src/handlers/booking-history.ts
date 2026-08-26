import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
import { reservationStore, type ReservationEnv } from "../reservations.js";

// SCAFFOLD — generated from the bot blueprint BEFORE the agent runs.
// Keep a LIVE registration (.command / .callbackQuery / …) so this feature is
// never an empty stub. Replace the reply body with real logic + copy; if you
// change the user-facing text, update tests/specs to match EXACTLY.
// Do NOT rewrite src/bot.ts — buildBot() already auto-loads this module.
// Menu: wire this into /start via registerMainMenuItem({ label: "My bookings", data: "booking:history" }) if the toolkit exposes it.

registerMainMenuItem({ label: "My bookings", data: "booking:history", order: 20 });
const composer = new Composer<Ctx>();
const envOf = (ctx: Ctx) => (ctx as Ctx & { env?: ReservationEnv }).env;
async function notifyOwner(ctx: Ctx, text: string) { const owner = adminChatId(ctx as Ctx & { env?: Record<string, unknown> }); if (!owner) return; try { await ctx.api.sendMessage(owner, text); } catch { /* notification delivery is best effort */ } }

composer.callbackQuery("booking:history", async (ctx) => {
  await ctx.answerCallbackQuery();
  const bookings = await reservationStore.byGuest(envOf(ctx), ctx.chat!.id);
  if (!bookings) { await ctx.editMessageText("Bookings aren't available right now. Please try again shortly."); return; }
  if (bookings.length === 0) { await ctx.editMessageText("No bookings yet — tap Make a reservation to create one.", { reply_markup: inlineKeyboard([[inlineButton("Make a reservation", "booking:start")], [inlineButton("Back to menu", "menu:main")]]) }); return; }
  const lines = bookings.map((booking) => `${booking.date} at ${booking.startTime} for ${booking.partySize} — ${booking.status === "confirmed" ? "confirmed" : booking.status}`);
  const actions = bookings.filter((b) => b.status === "confirmed").flatMap((b) => [[inlineButton(`Change ${b.date}`, `booking:reschedule:${b.id}`)], [inlineButton(`Cancel ${b.date}`, `booking:cancel:${b.id}`)]]);
  await ctx.editMessageText(`Your bookings:\n${lines.join("\n")}`, { reply_markup: inlineKeyboard([...actions, [inlineButton("Back to menu", "menu:main")]]) });
});

composer.callbackQuery(/^booking:cancel:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const all = await reservationStore.byGuest(envOf(ctx), ctx.chat!.id); const booking = all?.find((b) => b.id === ctx.match[1]); if (!booking || booking.status !== "confirmed") { await ctx.editMessageText("That booking can't be changed anymore."); return; } booking.status = "cancelled"; await reservationStore.update(envOf(ctx), booking); await notifyOwner(ctx, `A ${booking.partySize}-guest booking on ${booking.date} at ${booking.startTime} was cancelled.`); await ctx.editMessageText("Your reservation is cancelled.", { reply_markup: inlineKeyboard([[inlineButton("My bookings", "booking:history")]]) }); });
composer.callbackQuery(/^booking:reschedule:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const all = await reservationStore.byGuest(envOf(ctx), ctx.chat!.id); const booking = all?.find((b) => b.id === ctx.match[1]); const config = await reservationStore.config(envOf(ctx)); if (!booking || !config) { await ctx.editMessageText("That booking can't be changed right now."); return; } ctx.session.draft = { bookingId: booking.id, mode: "move" }; const rows = (await import("../reservations.js")).nextDates(config.timezone).slice(0, 12).reduce<ReturnType<typeof inlineButton>[][]>((out, date, i) => { if (i % 3 === 0) out.push([]); out[out.length - 1].push(inlineButton(date.slice(5), `movedate:${date}`)); return out; }, []); await ctx.editMessageText("Pick a new day.", { reply_markup: inlineKeyboard(rows) }); });
composer.callbackQuery(/^movedate:(\d{4}-\d{2}-\d{2})$/, async (ctx) => { await ctx.answerCallbackQuery(); const config = await reservationStore.config(envOf(ctx)); if (!config || !ctx.session.draft?.bookingId) { await ctx.editMessageText("That change expired. Open My bookings and try again."); return; } ctx.session.draft.date = ctx.match[1]; const available = await reservationStore.available(envOf(ctx), ctx.match[1]); await ctx.editMessageText("Pick a new arrival time.", { reply_markup: inlineKeyboard((available ?? (await import("../reservations.js")).slots(config)).map((time) => [inlineButton(time, `movetime:${time}`)])) }); });
composer.callbackQuery(/^movetime:(\d\d:\d\d)$/, async (ctx) => { await ctx.answerCallbackQuery(); const draft = ctx.session.draft; const all = await reservationStore.byGuest(envOf(ctx), ctx.chat!.id); const booking = all?.find((b) => b.id === draft?.bookingId); if (!draft?.date || !booking) { await ctx.editMessageText("That change expired. Open My bookings and try again."); return; } booking.date = draft.date; booking.startTime = ctx.match[1]; const updated = await reservationStore.update(envOf(ctx), booking); if (!updated) { await ctx.editMessageText("That time just filled up. Pick another time."); return; } ctx.session.draft = undefined; await notifyOwner(ctx, `A booking moved to ${updated.date} at ${updated.startTime}.`); await ctx.editMessageText(`Your reservation is now ${updated.date} at ${updated.startTime}.`, { reply_markup: inlineKeyboard([[inlineButton("My bookings", "booking:history")]]) }); });

export default composer;
