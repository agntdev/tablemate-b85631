import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
import { nextDates, reservationStore, slots, type ReservationEnv, type VenueConfig } from "../reservations.js";

// SCAFFOLD — generated from the bot blueprint BEFORE the agent runs.
// Keep a LIVE registration (.command / .callbackQuery / …) so this feature is
// never an empty stub. Replace the reply body with real logic + copy; if you
// change the user-facing text, update tests/specs to match EXACTLY.
// Do NOT rewrite src/bot.ts — buildBot() already auto-loads this module.
// Menu: wire this into /start via registerMainMenuItem({ label: "Make a reservation", data: "booking:start" }) if the toolkit exposes it.

registerMainMenuItem({ label: "Make a reservation", data: "booking:start", order: 10 });
const composer = new Composer<Ctx>();
const envOf = (ctx: Ctx) => (ctx as Ctx & { env?: ReservationEnv }).env;
async function notifyOwner(ctx: Ctx, text: string) {
  const owner = adminChatId(ctx as Ctx & { env?: Record<string, unknown> });
  if (!owner) return;
  try { await ctx.api.sendMessage(owner, text); } catch { /* a delivery failure must not undo a booking */ }
}
const menu = (rows: ReturnType<typeof inlineButton>[][]) => inlineKeyboard([...rows, [inlineButton("Back to menu", "menu:main")]]);
const dateLabel = (date: string) => new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

async function dates(ctx: Ctx, config: VenueConfig, prefix: "bookdate" | "movedate") {
  const candidates = nextDates(config.timezone);
  const availability = await Promise.all(candidates.map(async (date) => ({ date, slots: await reservationStore.available(envOf(ctx), date) })));
  const buttons = availability.filter((item) => (item.slots ?? []).length > 0).map(({ date }) => inlineButton(dateLabel(date), `${prefix}:${date}`));
  if (!buttons.length) { await ctx.editMessageText("No tables are open in the next 30 days. Please check back soon.", { reply_markup: menu([]) }); return; }
  await ctx.editMessageText("Pick the day you'd like to visit.", { reply_markup: menu(buttons.reduce<ReturnType<typeof inlineButton>[][]>((rows, button, i) => { if (i % 3 === 0) rows.push([]); rows[rows.length - 1].push(button); return rows; }, [])) });
}

composer.callbackQuery("booking:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const config = await reservationStore.config(envOf(ctx));
  if (!config) { await ctx.editMessageText("Reservations aren't set up yet. Please check back soon.", { reply_markup: menu([]) }); return; }
  ctx.session.step = "idle";
  ctx.session.draft = { mode: "new" };
  await dates(ctx, config, "bookdate");
});

composer.callbackQuery(/^bookdate:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const config = await reservationStore.config(envOf(ctx));
  if (!config) { await ctx.editMessageText("Reservations aren't set up yet."); return; }
  ctx.session.draft = { ...(ctx.session.draft ?? {}), date: ctx.match[1], mode: "new" };
  const available = await reservationStore.available(envOf(ctx), ctx.match[1]);
  await ctx.editMessageText("Choose an available arrival time.", { reply_markup: menu((available ?? slots(config)).map((time) => [inlineButton(time, `booktime:${time}`)])) });
});

composer.callbackQuery(/^booktime:(\d\d:\d\d)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.draft?.date) { await ctx.editMessageText("That choice expired. Start your reservation again."); return; }
  ctx.session.draft.time = ctx.match[1];
  await ctx.editMessageText("How many guests are joining you?", { reply_markup: menu([[1, 2, 3, 4].map((size) => inlineButton(String(size), `booksize:${size}`)), [5, 6, 7, 8].map((size) => inlineButton(String(size), `booksize:${size}`))]) });
});

composer.callbackQuery(/^booksize:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const size = Number(ctx.match[1]);
  const config = await reservationStore.config(envOf(ctx));
  if (!config || size > config.totalSeats) { await ctx.editMessageText("That party is larger than we can seat. Try a smaller group or contact the restaurant."); return; }
  ctx.session.draft = { ...(ctx.session.draft ?? {}), partySize: size };
  ctx.session.step = "contact";
  await ctx.editMessageText("Share a name and phone number, or continue without them.", { reply_markup: inlineKeyboard([[inlineButton("Add contact", "booking:contact"), inlineButton("Skip", "booking:skip")], [inlineButton("Back to menu", "menu:main")]]) });
});

composer.callbackQuery("booking:contact", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "contact";
  await ctx.editMessageText("Send your name and phone number on one line.", { reply_markup: inlineKeyboard([[inlineButton("Skip", "booking:skip")]]) });
});

async function confirm(ctx: Ctx) {
  const draft = ctx.session.draft;
  if (!draft?.date || !draft.time || !draft.partySize) { await ctx.reply("That reservation expired. Tap Make a reservation to start again."); return; }
  await ctx.reply(`Ready to reserve for ${draft.partySize} on ${draft.date} at ${draft.time}.`, { reply_markup: inlineKeyboard([[inlineButton("Confirm reservation", "booking:confirm"), inlineButton("Cancel", "booking:cancel-flow")]]) });
}
composer.callbackQuery("booking:skip", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "idle"; await confirm(ctx); });
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "contact") return next();
  const [name, ...phone] = ctx.message.text.trim().split(/\s+/);
  if (!name || phone.join(" ").length < 5) { await ctx.reply("Send a name and phone number, or tap Skip."); return; }
  ctx.session.contact = { name, phone: phone.join(" ") };
  ctx.session.step = "idle";
  await confirm(ctx);
});

composer.callbackQuery("booking:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.draft;
  if (!draft?.date || !draft.time || !draft.partySize) { await ctx.editMessageText("That reservation expired. Tap Make a reservation to start again."); return; }
  const result = await reservationStore.reserve(envOf(ctx), { chatId: ctx.chat!.id, guestName: ctx.session.contact?.name, phone: ctx.session.contact?.phone, partySize: draft.partySize, date: draft.date, startTime: draft.time, reminderSent: false });
  if (!result?.booking) { await ctx.editMessageText(result?.error === "full" ? "That time just filled up. Pick another time and we'll check it again." : "Couldn't save your reservation right now. Please try again."); return; }
  ctx.session.draft = undefined; ctx.session.contact = undefined;
  await notifyOwner(ctx, `New booking: ${result.booking.partySize} guests on ${result.booking.date} at ${result.booking.startTime}.`);
  await ctx.editMessageText(`You're booked for ${result.booking.partySize} on ${result.booking.date} at ${result.booking.startTime}. Your confirmation code is ${result.booking.referenceCode}.`, { reply_markup: inlineKeyboard([[inlineButton("My bookings", "booking:history")], [inlineButton("Back to menu", "menu:main")]]) });
});
composer.callbackQuery("booking:cancel-flow", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.draft = undefined; ctx.session.contact = undefined; ctx.session.step = "idle"; await ctx.editMessageText("No reservation was made.", { reply_markup: menu([]) }); });

export default composer;
