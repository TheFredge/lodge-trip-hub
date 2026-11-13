# Lodge Trip Hub

A one-page phone dashboard for deciding whether a trip to the NJ Whiz Skiers lodge in Waitsfield, VT is worth the drive: a Go / Go with caution / Reconsider verdict, live drive time, Waitsfield weather, Mad River Glen and Sugarbush conditions, and the Mount Mansfield snowpack.

- `index.html` is the whole page, served by GitHub Pages.
- The data lives in Supabase and is only readable after signing in with an approved account.
- `supabase/` is a backup copy of what runs there: the `collector` function (gathers readings every 30 minutes), the `hub` function (booked trips and the drive), and `setup.sql` (tables, access rules, schedule).

Nothing secret is stored in this repository. The Supabase key in `index.html` is the public "publishable" key, designed to be visible; the data behind it is locked to approved users. The Google Maps key and the calendar link are stored as secrets in Supabase only.

Data sources: Sugarbush's mountain report feed, Mad River Glen's conditions page, the National Weather Service (forecasts, alerts, and the Mount Mansfield snow stake report), Matthew Parrilla's Mansfield stake history, and Google's routing service.
