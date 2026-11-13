# Lodge Trip Hub

A one-page phone dashboard for deciding whether a trip to the NJ Whiz Skiers lodge in Waitsfield, VT is worth the drive: a Go / Go with caution / Reconsider verdict for the drive up or the drive home (toggle), live drive time, conditions at the lodge when you arrive or leave, Waitsfield weather with the best ski day of the trip, Mad River Glen and Sugarbush conditions (trails open by difficulty, lift hours), and the Mount Mansfield snowpack compared with past seasons.

- `index.html` is the page, served by GitHub Pages. `verdict.js` holds the verdict and best-day rules, shared by the page and the trip emails.
- The data lives in Supabase and is only readable after signing in with an approved account.
- `supabase/` is a backup copy of what runs there: the `collector` function (gathers readings every 30 minutes), the `hub` function (booked trips and the drive), the `trip-alerts` function (emails on the Monday before the cancel deadline and when a trip within a week turns to Reconsider), and `setup.sql` (tables, access rules, schedule).

Nothing secret is stored in this repository. The Supabase key in `index.html` is the public "publishable" key, designed to be visible; the data behind it is locked to approved users. The Google Maps key, the calendar link and the Resend email key are stored as secrets in Supabase only.

Data sources: Sugarbush's mountain report feed, Mad River Glen's conditions page, the National Weather Service (forecasts, alerts, and the Mount Mansfield snow stake report), Matthew Parrilla's Mansfield stake history, and Google's routing service.
