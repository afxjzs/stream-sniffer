# Stream Sniffer

A Chrome extension that finds the video stream a web page is playing and lets you watch it on its
own: in a clean player tab, in VLC, or on a Chromecast.

Many sites play HLS video (`.m3u8` playlists) inside a cluttered embedded player. Stream Sniffer
watches the requests a page makes, picks out the playlists, and records the headers the page sent
with them (Referer, Origin, User-Agent). Stream servers usually check those headers, so you need
them to play the stream anywhere else.

> **Use it responsibly.** Stream Sniffer replays what your own browser is already receiving. Only
> use it with streams you have the right to watch.

## Features

- **Stream capture.** Lists every `.m3u8` playlist a tab loads, including ones inside embedded
  iframes from other sites.
- **Built-in player.** Plays a captured stream in its own tab, with the original Referer and
  Origin sent on every request.
- **Copy commands.** One click copies a VLC command or a `curl` command with the captured headers.
- **Chromecast relay (beta).** Sends the stream to a Chromecast as real video, not a mirrored tab.
  See [Chromecast relay (beta)](#chromecast-relay-beta).
- **Fit to TV.** For Chrome's own Cast (Chrome menu → Cast this tab): resizes the player window
  so the tab is 16:9 and fills the TV with no black bars. In the player's ⚙ menu. Chrome's
  Cast re-encodes the tab, so the picture is softer than the relay's, but it shows both pictures.
- **Freeze log.** The player records every frozen picture, stall, error and retry, with how much
  video was buffered and when the source last offered a new segment. It's kept across reloads
  (the last 500 entries). ⚙ → **Copy log** copies it for a bug report. Stream links appear
  without their query string, which can hold a token.

## Requirements

- **Google Chrome.** Other Chromium browsers may work but haven't been tested.
- **For the relay:** [Node.js](https://nodejs.org/) 18 or later, and a Chromecast on the same
  network as your computer.
- **For the VLC command:** VLC installed. The copied command uses the macOS path
  (`/Applications/VLC.app/...`); on other systems, swap in your own `vlc` path.

## Install

1. Get the code:
   ```
   git clone https://github.com/afxjzs/stream-sniffer.git
   ```
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension`** folder inside `stream-sniffer`.
   Don't select the `stream-sniffer` folder itself, or Chrome reports "Manifest file is missing".
4. Pin the extension: open the puzzle-piece menu in the toolbar and click the pin next to
   Stream Sniffer.

To update later, run `git pull`, then click the reload icon (↻) on the extension's card in
`chrome://extensions`.

## Use

1. Open the page with the video and press play.
2. The Stream Sniffer icon shows a badge with the number of playlists it caught on that tab.
   Click the icon.
3. Each playlist in the popup shows its server and file name, and what it offers, read from the
   playlist itself: for a playlist that lists qualities, the best one's resolution and frame
   rate, its advertised bitrate, codec, and whether it's live (e.g. `3 qualities, best 1080p60 ·
   6.0 Mbps advertised · H.264 · live`). A playlist of a single quality doesn't say those, so it
   only shows whether it's live. Each playlist has these buttons:
   - **Add to player** adds the stream to the player tab you used last, as a small picture over
     the big one (or replaces the small one). With no player tab open, it opens one.
   - **Open in player** plays the stream in a new tab, sending the captured Referer and Origin.
   - **Check quality** plays the stream's best quality muted in a small preview for a few
     seconds, then reports what it measured (e.g. `Checked: 1080p60 · 6.2 Mbps measured`). It
     downloads a few seconds of video. The measured bitrate is the one to trust.

   The **⋯** button shows the full URL, the headers the page sent, and three copy buttons:
   - **Copy URL** copies the playlist address.
   - **Copy VLC command** copies a terminal command that plays the stream in VLC.
   - **Copy curl command** copies a `curl` command that repeats the browser's request with every
     header. It's useful for testing what a stream server accepts.
4. The player fills the tab with the video. With two streams, the second floats in a corner;
   click it (or press **S**) to swap the two pictures. Drag it to move it, or drag a corner to
   resize it; the player remembers where you put it. Click its **–** (or press **H**) to hide it
   while its stream keeps playing; **S** still swaps, and **Show small picture** in the bar
   brings it back. Click its **×** to remove it. The sound always follows the big picture. Each
   stream gets its own Referer and Origin, so the two can come from different sites. Problems
   (errors, buffering, failed requests the player is retrying) show as a short line over the
   video while they last; click one to copy it with its technical detail. A decoding glitch is fixed in place without reloading. If a stream stops (its server
   stopped answering or had an error, or the video couldn't be decoded twice within 30 s), the player
   tries it again by itself (after 5, 15 and 30 seconds, with a countdown and the reason) and
   says when it's back. A stopped stream also has a **Retry** button. A link the server refuses
   (403, 404) isn't retried by itself: it has most likely expired, so reopen it from its page.
   Live streams just play: if a video pauses (a media key, or Chrome itself), the player
   starts it again at once and notes it in the ⚙ menu. If frames are lost, a warning says how
   many in the last 10 seconds and where: skipped by Chrome's video player, or missing from the
   stream itself. Chrome shows each frame when its timestamp says and skips any that land late,
   so a stream with uneven frame timestamps (common in relayed re-streams) loses frames however
   fast the computer is; the warning says when that's the case. The ⚙ menu keeps the totals,
   says whether the stream's timing is uneven and whether its format can be decoded in hardware,
   and notes a frame rate that doesn't fit the display's refresh rate (e.g. 50 fps on 60 Hz),
   which shows a slight steady hitch. A switch in the menu turns these warnings off.
5. The bar at the bottom controls the big picture. It fades out when the mouse rests. From left
   to right: volume (**M** mutes), **LIVE** (grey when behind; click it to jump to live) or the
   time, what is on screen (resolution and frame rate, e.g. 1080p60, and the bitrate measured from
   the video it downloads), which opens a quality menu when the stream has more than one
   (Auto starts on the best quality and drops down only if your connection can't keep up; a
   picked quality stays), **Pop out**, and full screen.
   **Pop out** moves the big video into a small floating window that stays on top of other
   apps; click it again (or close the floating window) to bring it back. Full screen (or **F**,
   or a double-click on the video) fills the screen with the whole player, small picture
   included.
6. The ⚙ button opens the player menu: where each stream came from and its status, the relay's
   **Start casting**, and a form to play another URL on the big screen (click its title to fold
   it away). Each stream's **Details** has the full error, the frame totals, how it's decoded,
   the stream URL, and other technical facts.
7. To play a URL you already have, click **Open player** at the top of the popup. Then paste the
   stream URL, plus a Referer if the server needs one.
8. Closed the player? **Reopen last player** at the top of the popup brings back the streams it
   showed last, until Chrome quits or the extension reloads (links with a token may have
   expired by then).

The first playlist in the list is usually the master playlist. That's the one to pick. If a page
loads an ad or a decoy first, try the others.

The list resets when the tab loads a new page. The extension only sees requests made after it was
installed, so reload a page that was already open.

## Chromecast relay (beta)

The relay sends a stream to a Chromecast as real video, so the TV plays it at full quality and
your computer doesn't re-encode a tab.

It's experimental. One cause of endless buffering on the TV is fixed: segments disguised in an
image format the relay didn't decode. The relay now stops with an error for those instead. If the
TV still keeps buffering on a stream, the cause isn't known yet.

### Why it's needed

A Chromecast fetches video itself, and it can't send the Referer or Origin a stream server
expects. Some servers go further and reject anything that isn't the browser itself: in testing,
`curl` got HTTP 403 even when it sent every header the browser did.

So the relay never fetches the stream itself. The player tab does it:

1. The TV asks the relay (a small server on your computer) for a playlist or video segment.
2. The relay puts the request in a queue.
3. The Stream Sniffer player tab picks it up, fetches it through Chrome, and hands it back.
4. The relay rewrites playlists so every link points back to itself, then sends the data to the TV.

### Set up

Start the relay in a terminal from the `stream-sniffer` folder and leave it running:

```
node relay/server.mjs
```

It has no dependencies to install. When it's ready, it prints the network address the TV will use
and then `[relay] ready`.

### Cast

1. Open a stream in the player (**Open in player** in the popup).
2. Open the ⚙ menu and click **Start casting** under **Cast via relay (beta)**. With one stream
   in the player, it casts that. With two, it casts both as one channel you can swap (see
   [Swap on TV](#swap-on-tv)). The player checks the streams, then shows the cast controls below
   the button.
3. Click **Cast to TV** and choose your Chromecast.

Playback on your computer stops when the TV takes over, so the stream isn't downloaded twice.
Press **Play** to watch on the computer again.

If the device picker doesn't open from inside the player, click **Open the cast page in its own
tab** and cast from there.

### Swap on TV

With two streams in the player (say a game and a whip-around channel), **Start casting** gives
the TV one channel, and **Swap on TV** in the cast controls switches which stream it shows. The TV
shows one at a time, full screen.

- **It jumps to live.** After the relay switches streams, the cast page waits until the TV has
  picked up the new one, then moves the TV to its live edge. **After a swap, start _N_ s behind
  live** sets how far back it lands. It starts at 0; raise it if the TV buffers right after a
  swap. The setting is saved in that browser.
- **Both streams must be live MPEG-TS**, unencrypted, with sound in the same stream as the
  picture. If one isn't, casting stops and says which stream to remove (× on the small picture).
- **Only the stream on the TV is downloaded.** The other one isn't fetched until you swap to it,
  and the player tab stops both of its own videos while casting.
- Each swap is a cut, marked in the playlist so the TV resets its clock for the new stream.
### Keep in mind

- **Keep the player tab open.** It does the fetching for the TV. If you close it, the TV stops,
  and the cast controls show a warning.
- **One cast at a time.** Starting a new relay cast stops the previous one, and the old tab says
  so. (A cast can hold two streams for [Swap on TV](#swap-on-tv).)
- **Your computer must stay awake** and on the same network as the Chromecast.
- **Watch the "Relay activity" box** if the TV stalls. It shows how many requests the TV has made
  and any errors from the stream server.
- **The relay keeps live video in reserve.** Stream sources sometimes stop adding video for a
  few seconds, and the Chromecast plays only a second or two behind the newest segment, so it
  buffers. For live MPEG-TS streams, the relay holds back up to 12 seconds of the newest video
  (fetched ahead of time) and hands segments to the TV at the pace they play. When the source
  pauses, the TV keeps getting video from the reserve, which shrinks; when the source catches
  up, the reserve refills. The cost is that the TV plays up to 12 seconds further behind live.
  A stream whose playlist is short starts with less (the TV always gets at least two segments).
  The cast controls show how much is in reserve right now, or why a stream gets none
  (on-demand, fMP4, separate audio, or encrypted streams are passed through unchanged).
- **A request the stream server doesn't answer is tried again.** After 4 seconds without an
  answer, the relay asks the player tab to fetch it again, and again at 9 seconds; the first
  answer wins. The TV's own playlist requests are answered within about a second from what the
  relay already has, instead of waiting on a slow source.
- **The relay keeps each segment for 30 seconds**, because the Chromecast asks for most of them
  twice. The second request is answered from memory instead of fetched again through Chrome.
- **The relay reads a live source every second**, whether or not the TV is asking. Some TV
  apps (Jellyfin) reload the playlist only when they run low, and the reserve depends on the
  relay keeping up with the source.
- **The TV sees one continuous clock.** Two streams carry unrelated timestamps, often hours
  apart. After a swap or a new cast, the relay shifts the new stream's timestamps to continue
  where the last one stopped. Without this, players that pace themselves by timestamps
  (Jellyfin's Live TV) froze when the TV moved to a different game.

### Playing in another app on the TV

Apps like VLC can play the cast instead of a Chromecast. When the relay starts, it prints a
fixed address for them:

```
[relay] for a TV app (VLC, Fire TV), open http://192.168.1.20:8788/now.m3u8: it always plays the current cast
```

Press **Start casting** in the player, then open that address in the app. It always plays the
newest cast, so the app can keep it saved. Keep the player tab open while you watch, because
the relay fetches the stream through it. If nothing is casting, the address returns HTTP 404,
with a message telling you to press Start casting.

Unlike the stream's own URL, this address needs no headers or cookies. The relay fetches
through Chrome with the right headers and decodes disguised segments first.

If you start a new cast while the app is playing, the app moves on to it without being reopened.
This works for live casts, which the relay relists with a reserve. A cast the relay passes
through unchanged (on-demand, fMP4, separate audio, or encrypted streams) still needs the app to
reopen the address.

### Security

The relay listens on your local network so the TV can reach it. To limit what other devices can
do with it:

- Only your own computer can register streams, see their details, or open the cast page.
- Other devices can only fetch hosts that the registered stream's own playlists point to.
  Requests for any other host get HTTP 403.

### Settings

| Setting | Default | How to change it |
| --- | --- | --- |
| Relay port | `8788` | `RELAY_PORT=9000 node relay/server.mjs` |
| Address the TV uses | First IPv4 address found (`en0` first) | `RELAY_HOST=192.168.1.20 node relay/server.mjs` |
| Relay address the extension uses | `http://localhost:8788` | See below |
| Segments the relay lists to the TV for a live stream | `12` | `RELAY_CHANNEL_WINDOW=8 node relay/server.mjs` |
| Seconds of live video kept in reserve | `12` | `RELAY_HOLD_SECONDS=20 node relay/server.mjs` (`0` turns it off) |

If you change the port, tell the extension too. Open the player tab, open DevTools (⌥⌘I), and run
this in the Console:

```js
chrome.storage.local.set({ relayUrl: 'http://localhost:9000' })
```

The player shows the relay address in its status messages, so you can confirm which one it uses.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Manifest file is missing or unreadable" when loading | Select the `extension` folder, not `stream-sniffer`. |
| The popup says no streams were seen | Reload the page and press play again. The extension only sees requests made after it was loaded. |
| The player shows "HTTP 403" | The captured link has probably expired. Many servers use short-lived tokens. Reload the source page and capture it again. |
| VLC or `curl` gets 403 but the player works | The server wants more than the command sends (VLC can't send Origin or cookies), or it only accepts Chrome itself. Use the player or the relay. |
| "Relay: not running at http://localhost:8788" | Start the relay with `node relay/server.mjs`. |
| The relay exits with "is not reaching this relay" | Another program is using the port. Pick another with `RELAY_PORT` and update `relayUrl` (see [Settings](#settings)). |
| The cast controls say Google Cast is unavailable | Use Google Chrome, and check that an ad or script blocker isn't blocking `gstatic.com`. |
| "Relay: … is a … image, not video, in a disguise format Stream Sniffer can't decode" | The site hides its video in a new kind of image. [Open an issue](https://github.com/afxjzs/stream-sniffer/issues) with the full message; the bytes it shows help work out the format. |
| The TV keeps buffering | Check "Relay activity" for errors. If there are none, it's the known beta issue: [open an issue](https://github.com/afxjzs/stream-sniffer/issues) with what Relay activity shows. |

## How it works

- **Capture.** `extension/background.js` listens to Chrome's `webRequest` events for `.m3u8` URLs
  in every frame. It stores each URL per tab with all its request headers. Reading Referer and
  Origin needs the `extraHeaders` option.
- **Service workers.** Some sites fetch the stream from a service worker, and Chrome reports
  those requests without a tab. The extension credits them to the tab with a frame from the
  worker's site. Players that add a cache-buster to each refresh (`?_=1791240957421`) show up
  as one stream, not a new one every few seconds.
- **Disguised segments.** Some sites hide video segments inside images on image CDNs.
  `extension/disguise.js` decodes the two formats seen so far (video packed into a PNG's pixels,
  and video stored in a WebP's EXIF chunk), and both the player and the relay use it. Before
  casting, the relay fetches the first segment, so one in an image format it can't decode stops
  the cast with an error that says why, instead of leaving the TV buffering.
- **Headers.** Web pages can't set Referer themselves. So the player asks the background to add a
  `declarativeNetRequest` rule, scoped to the player's tab, that sets Referer and Origin on its
  requests.
- **Playback.** The player uses [hls.js](https://github.com/video-dev/hls.js) 1.7.3, bundled in
  `extension/vendor/` because Manifest V3 extensions can't load remote code.
- **Cast page.** The relay serves the cast page from `http://localhost`, because extension pages
  can't load Google's Cast SDK. The player embeds it in a frame.
- **Errors.** Failures appear on screen. The player shows a short line over the video, and the
  full hls.js error and HTTP status in the stream's Details. Before casting, the relay fetches
  the stream's playlists and first segment through the player tab, so a rejected stream or a
  segment the TV can't play shows an error instead of a black or buffering TV.

## Project layout

```
extension/        The Chrome extension (load this folder unpacked)
  background.js   Captures playlists and headers; manages header rules
  popup.*         Toolbar popup listing captured streams, with what each offers and its quality check
  player.*        Player tab (big and small picture, control bar, ⚙ menu) and the relay fetch loop
  shared.js       hls.js loader (header hosts, disguised segments) used by the player and popup
  disguise.js     Decodes segments disguised as images
  vendor/         hls.js and its license
relay/
  server.mjs      The Chromecast relay (Node, no dependencies)
  cast.html       Cast controls page, served by the relay
test/
  e2e.mjs         End-to-end test
  fixtures/       Fake stream site used by the test
```

## Tests

There's one end-to-end test. It loads the extension into your installed Google Chrome and runs it
against a fake site on your machine. It uses that Chrome, not the Chrome for Testing build
Puppeteer downloads, because the installed one keeps itself updated. Puppeteer's build only moves
when Puppeteer is upgraded, and it had fallen two major versions behind. The test prints the
Chrome version it ran on. The site mimics a real one with three parts: a page, an embedded player
from another origin, and a stream server that returns 403 without the right Referer and token.

It checks what a user would see:

- The popup lists the captured playlist.
- The VLC and `curl` commands carry headers the stream server accepts.
- The player plays the stream.
- Two streams that need different Referers play side by side in one player tab (the fake site has
  a second stream server for this), swap picture and sound on a click, and both come back after a
  reload.
- A live stream whose segment URLs change on every playlist refresh keeps playing, and the player
  says what hls.js skipped. A "playlist" that's really an HTML error page fails with what the
  server sent. A playlist refresh that fails once shows while it's retried and clears when the
  next one works. A pause is undone at once and noted.
- The relay serves playlists and video to a client that sends no special headers, as a Chromecast
  would.
- The relay refuses hosts outside the stream.
- Segments disguised as PNG or WebP images play in the player and reach the TV as plain
  MPEG-TS. A segment in an image format nobody decodes stops the cast with a reason.
- Two live streams cast as one channel. Swap on TV switches it to the other stream and back, and
  the TV's playlist stays consistent through swaps: segment numbers only move forward and never
  change meaning, including when a swap scrolls off the top. (The jump to live needs a real
  Chromecast, so the test can't cover it.)
- A live stream whose source stops adding segments for 7 seconds: the TV's playlist never goes
  more than 5 seconds without a new segment, and the cast controls say how much is in reserve.
- The same stream's server leaving one playlist request unanswered: again, never more than 5
  seconds without a new segment for the TV.
- After a newer cast replaces an older one, the relay drops the older cast's unfinished fetches
  instead of printing false "keep the player tab open" errors about it.
- Failures, such as a 403 or a relay that isn't running, show up on screen.

To run it you need Google Chrome installed and `ffmpeg` on your PATH. The first run uses it to generate a short test stream.

```
cd test
npm install
npm test            # headless
HEADFUL=1 npm test  # watch it run
```

The test starts its own relay on port 8789, so it doesn't conflict with one you're running on 8788.
Screenshots are saved to `test/artifacts/`.

## License

[Apache License 2.0](LICENSE). Bundled hls.js is also Apache-2.0
([its license](extension/vendor/LICENSE-hls.js)).
