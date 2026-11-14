---
'zele': patch
---

`cal get`, `cal update`, `cal delete` and `cal respond` now fetch only the requested event instead of downloading the whole calendar. They read the event at its own URL first and scan the calendar only when the event is stored under another file name. A missing event now fails with `event "..." not found` instead of `API call failed`.

`cal list` and the fallback scan now get all events in one CalDAV request. Before, zele listed every event and then fetched them all again, so one broken event on the server made every read fail.

New events are saved as `<uid>.ics` so the fast lookup finds them on any CalDAV server.

Failed event writes are now reported as errors. Before, a rejected create, update, delete or RSVP response was printed as a success.
