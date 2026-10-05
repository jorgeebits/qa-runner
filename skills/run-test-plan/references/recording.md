# Recording

`init --record` records every case; otherwise set `"record": true` per case or in `defaults`.
Open the viewer before the agents start: frames stream to its server.

Playwright MCP's code runner has no file-system access, so `start.js` opens a CDP screencast and
streams JPEG frames to the viewer server. On `stop.js` the server stitches them with ffmpeg into
`evidence/recording-N.mp4`, using real frame timing with gaps capped at 2 s to remove dead air.
The brief gives the agent both snippet paths (`browser_run_code_unsafe` with `filename`).

It records only the active tab. Stills stay the proof; the video shows how you got there.
