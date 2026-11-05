# Speaker booking platform

A small, self-hosted site where students, colleges and organisations can see your
availability and book you for a talk — with a landing page, a live calendar,
booking requests, a status page and an admin dashboard.

No dependencies: just Node.js 22+.

## Run it

```bash
npm start
```

Then open:

| Page | URL | Who |
| --- | --- | --- |
| Landing page | http://localhost:3000/ | everyone |
| Book a session | http://localhost:3000/book | organisers |
| Booking status | http://localhost:3000/status | organisers (ref + email) |
| Admin dashboard | http://localhost:3000/admin | you |

On first start a random admin password is generated and saved to
`data/.admin-password`. To choose your own, copy `.env.example` to `.env` and set
`ADMIN_PASSWORD`.

## Make it yours — `config.json`

Everything on the landing page comes from `config.json` (changes apply on page
refresh, no restart needed):

- `name`, `initials`, `title`, `tagline`, `bio`, `location`, `contactEmail`, `socials`
- `photo` — put an image in `public/img/` and set e.g. `"/img/me.jpg"` (otherwise your initials are shown)
- `stats`, `topics`, `formats` (these become the "Event type" options), `testimonials`, `faqs`
- `availability`:
  - `timezone` / `timezoneLabel` — all dates and times are in this zone
  - `weeklyHours` — the hours you're bookable each weekday, e.g. `"sat": ["09:00-13:00", "14:00-19:00"]`; `[]` = not bookable
  - `durations` — session lengths (minutes) people can pick
  - `slotStepMinutes` — how often a start time is offered
  - `bufferMinutes` — gap kept free before/after every booking
  - `minNoticeDays`, `maxAdvanceDays` — booking window
  - `maxBookingsPerDay` — cap on talks per day (remove to disable)

## How booking works

1. A visitor picks a length, a date (green = open, amber = some slots taken, red = full) and a start time.
2. They fill in the event details — name, email, organisation, event type, topic, format, venue, audience.
3. The request is saved as **pending** and immediately holds the slot so nobody else can take it.
4. They get a reference like `BK-7K3QX9` to check the status at `/status`.
5. In `/admin` you confirm / decline, reschedule, leave a message for the requester, choose
   whether the talk appears in the public "Upcoming talks" list, block days or hours off,
   and export everything as CSV.

Declined and cancelled bookings free up their slot again.

## Data

Bookings and blocked time are stored in `data/db.json`. Back this file up — it is your
booking history. `data/` is git-ignored.

## Deploying

Any host that runs Node works (a small VPS, Render, Railway, Fly.io…). Set
`HOST=0.0.0.0`, `PORT`, and `ADMIN_PASSWORD`, and make sure `data/` is on persistent
storage. Put it behind HTTPS (most hosts do this for you).

Not included yet: email notifications — new requests show up in the admin dashboard
and the server log.
