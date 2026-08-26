# ReserveMyTable Bot — Bot specification

**Archetype:** booking

**Voice:** friendly and concise — write every user-facing message, button label, error, and empty state in this voice.

A restaurant reservation bot that shows real-time availability, lets guests book/reschedule/cancel via buttons, sends confirmation codes, and reminds guests before their sitting. Owners get a private view of bookings, capacity tracking, and no-show marking capabilities.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- restaurant guests
- restaurant owner/manager

## Success criteria

- Zero double-bookings through real-time availability checks
- 100% accurate pre-booking availability display
- All guests receive confirmation with reference code
- Owners receive no-show alerts and capacity updates

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main reservation menu
- **Make a reservation** (button, actor: user, callback: booking:start) — Initiates new reservation flow
- **My bookings** (button, actor: user, callback: booking:history) — Shows user's current and past bookings
- **Owner view** (button, actor: user, callback: owner:login) — Requests owner authentication to access admin features

## Flows

### Reservation flow
_Trigger:_ booking:start

1. Show date picker with available dates
2. Show available time slots for selected date
3. Select party size
4. Collect optional contact info
5. Confirm booking with table assignment
6. Generate reference code

_Data touched:_ booking, table_inventory

### Reschedule flow
_Trigger:_ booking:reschedule

1. Show available dates
2. Show available times for selected date
3. Confirm reschedule
4. Update booking status

_Data touched:_ booking

### Owner dashboard
_Trigger:_ owner:login

1. Verify admin credentials
2. Show today's bookings list
3. Show remaining capacity
4. Enable no-show marking interface

_Data touched:_ booking, venue_config

### Reminder system
_Trigger:_ cron:reminders

1. Check bookings within reminder window
2. Send pre-booking reminders
3. Mark no-shows if missed

_Data touched:_ booking

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Telegram chat ID for owner notifications and admin access
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **venue_config** _(retention: persistent)_ — Restaurant operating parameters
  - fields: opening_hours, sitting_duration, table_sizes, max_seats_per_sitting, timezone
- **table_inventory** _(retention: persistent)_ — Available table configuration
  - fields: table_count_by_size, total_seats
- **booking** _(retention: persistent)_ — Reservation records
  - fields: guest_name, phone, party_size, date, start_time, assigned_tables, status, reference_code
- **reminder_config** _(retention: persistent)_ — Reminder timing settings
  - fields: reminder_hours_before

## Integrations

- **Telegram** (required) — Bot API messaging
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- View all upcoming bookings
- Mark no-shows
- Check daily capacity
- Configure reminder timing
- Update venue settings

## Notifications

- Pre-booking reminders to guests
- Booking change notifications to owner
- No-show alerts to owner
- Capacity updates for owner

## Permissions & privacy

- Guest data stored privately with optional contact fields
- Owner has exclusive access to full booking list
- Reference codes only visible to guests
- No third-party data sharing

## Edge cases

- Time zone conversion for international guests
- Last-minute cancellations before reminders
- Party size exceeding available tables
- Concurrent booking attempts during peak hours

## Required tests

- End-to-end reservation flow with availability checks
- Double-booking prevention test
- Owner no-show marking workflow
- Reminder timing accuracy test

## Assumptions

- Owner will pre-configure table inventory
- Restaurant uses single fixed sitting duration
- 30-day availability window is sufficient
- Guests will use reference codes for verification
