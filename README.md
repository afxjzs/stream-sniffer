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
3. Each playlist in the popup has these buttons:
   - **Open in player** plays the stream in a new tab, sending the captured Referer and Origin.
   - **Copy VLC command** copies a terminal command that plays the stream in VLC.
   - **Copy curl** copies a `curl` command that repeats the browser's request with every header.
     It's useful for testing what a stream server accepts.
   - **Copy URL** copies the playlist address.
4. To play a URL you already have, click **Open player** at the top of the popup. Then paste the
   stream URL, plus a Referer if the server needs one.

The first playlist in the list is usually the master playlist. That's the one to pick. If a page
loads an ad or a decoy first, try the others.

The list resets when the tab loads a new page. The extension only sees requests made after it was
installed, so reload a page that was already open.

## Chromecast relay (beta)

The relay sends a stream to a Chromecast as real video, so the TV plays it at full quality and
your computer doesn't re-encode a tab.

It's experimental. It plays some streams smoothly. On others the TV keeps buffering, and the cause
isn't known yet.

### Why it's needed

A Chromecast fetches video itself, and it can't send the Referer or Origin a stream server
expects. Some servers go further and reject anything that isn't the browser itself: in testing,
`curl` and VLC got HTTP 403 even with identical headers.

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
2. Click **Cast via relay (beta)**. The player checks the stream, then shows the cast controls
   below the buttons.
3. Click **Cast to TV** and choose your Chromecast.

Playback on your computer stops when the TV takes over, so the stream isn't downloaded twice.
Press **Play** to watch on the computer again.

If the device picker doesn't open from inside the player, click **Open the cast page in its own
tab** and cast from there.

### Keep in mind

- **Keep the player tab open.** It does the fetching for the TV. If you close it, the TV stops,
  and the cast controls show a warning.
- **One stream at a time.** Starting a new relay cast stops the previous one, and the old tab says
  so.
- **Your computer must stay awake** and on the same network as the Chromecast.
- **Watch the "Relay activity" box** if the TV stalls. It shows how many requests the TV has made
  and any errors from the stream server.

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

If you change the port, tell the extension too. Open the player tab, open DevTools (⌥⌘I), and run
this in the Console:

```js
chrome.storage.local.set({ relayUrl: 'http://localhost:9000' })
```

The player shows the relay address in its status messages, so you can confirm which one it uses.

## Cast via Chrome

The player also has a **Cast via Chrome** button. It asks Chrome to cast the video element using
Chrome's built-in casting. In testing so far, Chrome hasn't cast the stream this way: it either
declined ("The prompt was dismissed") or fell back to mirroring the tab. Use the relay instead.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Manifest file is missing or unreadable" when loading | Select the `extension` folder, not `stream-sniffer`. |
| The popup says no streams were seen | Reload the page and press play again. The extension only sees requests made after it was loaded. |
| The player shows "HTTP 403" | The captured link has probably expired. Many servers use short-lived tokens. Reload the source page and capture it again. |
| VLC or `curl` gets 403 but the player works | The server only accepts Chrome itself. Use the player or the relay. |
| "Relay: not running at http://localhost:8788" | Start the relay with `node relay/server.mjs`. |
| The relay exits with "is not reaching this relay" | Another program is using the port. Pick another with `RELAY_PORT` and update `relayUrl` (see [Settings](#settings)). |
| The cast controls say Google Cast is unavailable | Use Google Chrome, and check that an ad or script blocker isn't blocking `gstatic.com`. |
| The TV keeps buffering | Known beta issue for some streams. Check "Relay activity" for errors, or [open an issue](https://github.com/afxjzs/stream-sniffer/issues) with what it shows. |

## How it works

- **Capture.** `extension/background.js` listens to Chrome's `webRequest` events for `.m3u8` URLs
  in every frame. It stores each URL per tab with all its request headers. Reading Referer and
  Origin needs the `extraHeaders` option.
- **Headers.** Web pages can't set Referer themselves. So the player asks the background to add a
  `declarativeNetRequest` rule, scoped to the player's tab, that sets Referer and Origin on its
  requests.
- **Playback.** The player uses [hls.js](https://github.com/video-dev/hls.js) 1.7.3, bundled in
  `extension/vendor/` because Manifest V3 extensions can't load remote code.
- **Cast page.** The relay serves the cast page from `http://localhost`, because extension pages
  can't load Google's Cast SDK. The player embeds it in a frame.
- **Errors.** Failures appear on screen. The player shows the hls.js error and HTTP status. The
  relay checks a stream through the player tab before casting, so a rejected stream shows an error
  instead of a black TV.

## Project layout

```
extension/        The Chrome extension (load this folder unpacked)
  background.js   Captures playlists and headers; manages header rules
  popup.*         Toolbar popup listing captured streams
  player.*        Player tab, cast buttons, and the relay fetch loop
  vendor/         hls.js and its license
relay/
  server.mjs      The Chromecast relay (Node, no dependencies)
  cast.html       Cast controls page, served by the relay
test/
  e2e.mjs         End-to-end test
  fixtures/       Fake stream site used by the test
```

## Tests

There's one end-to-end test. It loads the extension into Chrome for Testing and runs it against a
fake site on your machine. The site mimics a real one with three parts: a page, an embedded player
from another origin, and a stream server that returns 403 without the right Referer and token.

It checks what a user would see:

- The popup lists the captured playlist.
- The VLC and `curl` commands carry headers the stream server accepts.
- The player plays the stream.
- The relay serves playlists and video to a client that sends no special headers, as a Chromecast
  would.
- The relay refuses hosts outside the stream.
- Failures, such as a 403 or a relay that isn't running, show up on screen.

To run it you need `ffmpeg` on your PATH. The first run uses it to generate a short test stream.

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
