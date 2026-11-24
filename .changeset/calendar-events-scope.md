---
'zele': minor
---

zele's own Google client (`ZELE_GOOGLE_CLIENT=zele`) now asks for the narrower `calendar.events` and `calendar.calendarlist.readonly` scopes instead of full `calendar`, and `zele cal` uses the Google Calendar REST API for those accounts. With it, `cal create --meet` adds a real Google Meet link, `--reminder`, `--color` and `--recurrence` are applied, `cal events` expands recurring events, and event output includes the Google Calendar link. Accounts on the default Thunderbird client keep using CalDAV. Accounts already signed in with the zele client must run `ZELE_GOOGLE_CLIENT=zele zele login --method google` again to switch.
