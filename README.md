# Stream Sniffer

A Chrome extension that catches the HLS (`.m3u8`) streams a page plays, plus the
`Referer`/`Origin`/`User-Agent` headers it sent. You can then replay a stream in VLC, or in a
player page bundled with the extension that sends those same headers.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Pin the extension so its icon stays in the toolbar.

## Use

1. Open the page and start the video.
2. The icon badge counts the playlists seen on that tab. Click the icon.
3. For each playlist the popup offers:
   - **Open in player**: opens `player.html` in a new tab and plays the stream there, with the
     captured Referer/Origin rewritten onto its requests.
   - **Copy VLC command**: a ready-to-paste terminal command with `--http-referrer` and
     `--http-user-agent` set.
   - **Copy curl**: replays the browser's exact request, with every header. Handy for
     figuring out which header a stubborn CDN wants.
   - **Copy URL**.
4. **Open player** (top right) opens the player empty. Paste in a URL and Referer by hand.

The list resets when the tab loads a new page.

## Casting to a Chromecast

The player page has two buttons:

- **Cast via Chrome** asks Chrome to cast the video element. Chrome decides whether it can
  send the video itself or falls back to mirroring the tab.
- **Cast via relay** sends the stream straight to the TV. Some stream servers answer only
  Chrome itself (curl and VLC get 403 even with identical headers), so the **player tab does
  all the fetching**. A small relay on this Mac queues the URLs the TV asks for. The player tab
  fetches each one through Chrome and hands it back, and the relay serves it to the TV on your
  network. **Keep the player tab open while casting.** Playback on the laptop stops when the
  TV takes over; press Play to watch there again. The relay serves one stream at a time.
  Start it first and leave it running while you watch:

  ```
  node relay/server.mjs
  ```

  It needs Node 18 or later and has no dependencies. It listens on port 8788 and prints the
  network address the TV will use. Set `RELAY_PORT` or `RELAY_HOST` to override them.
  Clicking the button opens a cast page; click **Cast to TV** and pick the Chromecast. The page
  shows how many requests the TV is making and any errors from the stream server.

  Only this Mac can register streams. Other devices on the network can fetch only the hosts
  the registered stream's own playlists point to.

## How it works

- `background.js` listens to `webRequest.onSendHeaders` for `.m3u8` URLs in every frame,
  including cross-origin embed iframes. It stores them per tab in `chrome.storage.session`.
  Reading Referer and Origin requires the `extraHeaders` option.
- A web page can't set `Referer` itself, so the player asks the background to install a
  `declarativeNetRequest` session rule scoped to the player's tab. That rule sets
  Referer/Origin on the stream requests. Extension pages with host permissions aren't subject
  to CORS, so the CDN's CORS policy doesn't block the player.
- Playback uses [hls.js](https://github.com/video-dev/hls.js) 1.7.3, vendored in
  `extension/vendor/` because MV3 extensions can't load remote scripts.
- Errors aren't swallowed. A failed load shows the hls.js error type, the HTTP status and the
  URL on the player page.

## Limits

- **Expiring URLs.** Many CDNs sign playlist URLs with short-lived tokens. If a copied
  command or player tab stops working, reload the source page and capture it again.
- **HLS only.** DASH (`.mpd`), WebRTC and WebSocket streams aren't captured.
- **Disguised segments.** Some CDNs serve segments as `.png`/`.jpg`. hls.js usually copes, and
  VLC sometimes doesn't.
- **Decoys.** Some pages load an ad or fake playlist first. Every playlist is listed, so try
  each one.
- **The VLC command doesn't send `Origin`.** VLC has no flag for it. If a CDN checks Origin,
  use the built-in player.

## Tests

One end-to-end test loads the unpacked extension into Chrome for Testing. It runs against a
fake site with three origins: a page, a cross-origin embed iframe running hls.js, and a CDN
that returns 403 unless it gets the embed's Referer and a token. The test checks that:

- the popup lists the captured playlist
- the VLC command's Referer is accepted by the CDN
- **Open in player** plays the stream
- manual mode plays the stream
- manual mode without a Referer shows the 403 to the user

```
cd test
npm install
npm test            # headless
HEADFUL=1 npm test  # watch it run
```

The first run generates a 20-second test stream with `ffmpeg`, which must be on PATH.
Screenshots are written to `test/artifacts/`.
