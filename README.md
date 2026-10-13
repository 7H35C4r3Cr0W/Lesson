# ⭐ Star Cards

A first-grade flashcard and mini-game web app for one family, built around the North Carolina
Standard Course of Study for Grade 1 and the CKLA Grade 1 reading order many NC classes use. It runs on a
Raspberry Pi on your home Wi-Fi and is used on an iPad in Safari. No accounts, no internet, no ads.

- **For the child:** tap a subject → a winding path of levels → each level is a deck you can **Look** through
  (flashcards that talk) or **Play** (a short round of tap-the-answer). A level is passed with **85% or better**
  on a round (three stars), which opens the next one. Games pull questions from the levels reached. Right
  answers earn stars, stars earn stickers.
- **For the grown-up:** a locked area with progress, a **Levels** page (every level, its best and latest score,
  passed or not, and every wrong answer), "needs practice" cards, a test builder (pick decks, how many
  questions, which cards), test history with question-by-question results, flags for cards that are wrong,
  deck on/off switches, settings, export.

Everything is plain Python (standard library) and plain JavaScript. No build step, nothing to `pip install`.

**What's inside:** 203 levels / ~3,500 cards across 7 subjects, built from the North Carolina Grade 1 standards and
sized to last the whole school year: 🔤 Sounds (22), 📖 Words (50, in CKLA reading order, incl. all five CKLA
tricky-word sets, two sight-word sets, prefixes/suffixes and contractions), 💬 Sentences (31, incl. grammar and
reading-comprehension levels), 🔢 Math (45), 🔬 Science (18), 🌎 My World / social studies (20), 💪 Healthy Me /
health & PE (17). Plus 8 mini-games. Every deck was written from fact-checked research on the NC standards and then
independently re-checked card by card. Late-year levels that step past the Grade 1 code or standards (e.g. ea/igh/ew
spellings, seasons, coin totals) say so in their grown-up "about" text; hide any deck the class has not reached from
Grown-ups → Cards and it is skipped on the path.

## Try it in your browser (no install)

A demo copy runs on GitHub Pages: **https://7h35c4r3cr0w.github.io/Lesson/** . It is the whole app with no server
behind it: everything you do there is saved only in that browser (no account, nothing uploaded, and it is gone if
you clear the site's data), so every visitor has their own private progress. The 🙋 Help button is off in the demo
because it needs a model running on the family's own network. Open **📋 Lesson plans** on the home screen (or
`#/lessons`) for the teacher view: every subject, world and level with what it teaches, the NC standard, how the
lesson runs and example cards; it prints.

Build the demo copy yourself with `python tools/build_static.py` (writes `docs/`); any static web host can serve it.

## For teachers

- **What it is:** 203 short levels across seven subjects, written to the NC Standard Course of Study for Grade 1,
  reading in the CKLA Grade 1 Skills order. Each level = talking flashcards (Look) + a tap-the-answer round (Play).
- **How it teaches:** a level is passed at 85% or better on a round (9 of 10), which opens the next one; missed cards
  come back first and are collected under Needs practice; three right answers in a row across days make a card
  mastered; eight mini-games reuse the levels already reached. Nothing has a timer, lives or a game-over.
- **In a classroom:** run `python server.py --port 8080` on any computer and open its address on the iPads on the same
  Wi-Fi; each child gets a profile (up to 8) and the grown-up area shows every level's score and wrong answers, builds
  tests from any decks and prints the lesson plans. No accounts, no internet, no ads, nothing leaves the room.

## Run it on this PC first

```bash
python server.py --port 8080
```

Open http://localhost:8080 . Press Ctrl+C to stop. The database goes in `./data/`.

## Put it on the Raspberry Pi

1. On the Pi (Raspberry Pi OS Bookworm or newer, Python 3.9+): enable SSH, and give it a nice name so the
   tablet can find it: `sudo raspi-config nonint do_hostname starcards && sudo reboot`.
   Reserve its IP in your router (UniFi: Client → Settings → Fixed IP) so the address never changes.
2. From this folder on Windows:
   ```powershell
   .\deploy\deploy-from-windows.ps1 -PiHost starcards.local -User pi
   ```
   It runs the tests, checks the content, copies the app and runs `deploy/install.sh` with sudo, which creates a
   locked-down `starcards` system user, installs to `/opt/starcards`, keeps the database in `/var/lib/starcards`,
   and starts a systemd service on port 80. Run it again any time you change something.
3. On the iPad open **http://starcards.local/** (or `http://<the Pi's IP>/`). The iPad must be on the same
   Wi-Fi as the Pi (not a guest network).

Useful on the Pi:

```bash
journalctl -u starcards -f                      # live log
sudo systemctl restart starcards                # after editing /etc/default/starcards
sudo -u starcards python3 /opt/starcards/server.py --data-dir /var/lib/starcards --reset-pin   # forgot the PIN
sudo -u starcards python3 /opt/starcards/server.py --data-dir /var/lib/starcards --backup-now  # extra snapshot
ls /var/lib/starcards/backups/                  # daily database snapshots (last 7)
```

Copy a backup to Windows: `scp pi@starcards.local:/var/lib/starcards/backups/*.db .`

### Mirror the backups to a Synology NAS

The app keeps 7 daily snapshots on the Pi itself; to also push them to a NAS so they survive an SD-card
failure, mount a NAS share on the Pi and run `tools/backup-to-nas.sh` from cron.

```bash
# one time, on the Pi
sudo apt install -y cifs-utils
printf 'username=%s\npassword=%s\n' NAS_USER 'NAS_PASS' | sudo tee /etc/starcards-nas.cred >/dev/null
sudo chmod 600 /etc/starcards-nas.cred
sudo mkdir -p /mnt/nas-starcards
# //<NAS-ip>/<share>  — fill in your NAS IP and the shared folder name
echo '//192.168.1.231/starcards-backups /mnt/nas-starcards cifs credentials=/etc/starcards-nas.cred,uid=root,iocharset=utf8,vers=3.0,nofail 0 0' | sudo tee -a /etc/fstab
sudo mount -a && ls /mnt/nas-starcards     # should succeed with no error

# nightly copy at 3:15
( sudo crontab -l 2>/dev/null; echo '15 3 * * * /opt/starcards/tools/backup-to-nas.sh /mnt/nas-starcards >> /var/log/starcards-nasbackup.log 2>&1' ) | sudo crontab -
sudo /opt/starcards/tools/backup-to-nas.sh /mnt/nas-starcards   # test it now
```

Never port-forward this to the internet. It is plain http with a child lock, made for your LAN only.

## Set up the iPad

- Open the address in Safari, tap **Share → Add to Home Screen**. It opens full screen with the star icon.
- **Guided Access** (Settings → Accessibility → Guided Access, then triple-click the top button inside the app)
  locks the iPad to Star Cards until you triple-click again; you can also set a time limit.
- The first tap on any screen turns on sound (Safari rule). If the voice is silent, check the side switch /
  silent mode, and Settings → Accessibility → Spoken Content → Voices to download a nicer English voice
  (Samantha, Ava or Evan). Pick it in Grown-ups → Settings → Voice.

## The grown-up area

Tap **Grown-ups** at the bottom of the home screen. With no PIN set the lock is a times-table question; set a
PIN in Settings and the Pi itself will refuse grown-up changes without it.

- **Overview**: stars, levels passed, streak, cards mastered, this week's accuracy, a 14-day chart, per-subject
  table, latest misses.
- **Levels**: every level in every subject with its status (passed / not yet / locked), best score, last round,
  rounds played, cards missed and cards mastered. Open a level for every round played on it (score, pass or
  not) and **what he got wrong**: each missed card, the answer, what he chose and how often, when. *Start this
  level over* forgets its rounds and resets its cards.
- **Tests**: *Make a test* → name, how many questions, which cards (all / already seen / needs practice / missed /
  new), decks to draw from, and whether to show right/wrong after each question. Saved tests appear as a
  "Test time!" button on the child's home screen. History lists every finished test with score and time; open one
  for the question-by-question record, then *Retest the missed* or add them to Needs practice.
- **Needs practice**: cards missed two of the last three times (automatic) plus any you flag yourself. They come
  first in practice and fill the "Try again" button. *Knows it now* clears one.
- **Cards**: every deck with a show/hide switch (hide what the class has not reached yet; hidden decks are skipped
  on the path), progress per card, and **Card is wrong** to hide a bad card and leave yourself a note.
- **Settings**: child's name and buddies, the look (Night: calm dark blue, the default; Day: soft cream),
  open-every-level switch, round length, sound, **when the voice speaks** (Only when needed: the word in a
  listen-and-find question, a replay after a miss, the answer after two misses, and the 🔊/🙋 buttons; Read
  everything; Never), which voice, the Help button, PIN, export, erase.

## How levels work

Each deck is one level on its subject's path, in the order the school year runs (short vowels → digraphs →
blends → long vowels → tricky words, counting → adding → tens and ones → time → shapes, and so on).

**Pass mark 85%.** Every Play round on a level is scored (first answer to each question). ★★★ = 85% or better,
which *passes* the level and opens the next one; ★★ = 60% or better; ★ = finished the round. With 10 questions
in a round that is 9 right (8 of 8 rounds need 7, 5 of 5 need 5). A level keeps its best round, so a bad day never
closes a level again. Rounds under the mark are kept on the grown-up Levels page but do not count as progress; the
end-of-round screen says exactly what it takes ("Get 9 out of 10 for 3 stars") and offers *Try again*. Look-only
levels (no Play button) are passed by flipping and sorting every card in the flashcards. "Mix it up", "Try again",
tests and games never pass a level; only a round on the level itself does. A level once passed stays open even if
the one before it is not (passed under *Open every level*, or while a deck was hidden).

Separately, each card is *mastered* after three right answers in a row across sessions; a miss drops it back;
missed cards come back later in the same round and first in the next one. Mastery drives what the next round
asks and the grown-up pages, not the stars on the map.

Upgrading from a version without the pass mark: on its first start the Pi scores the practice already done. A
sitting on a level that scored 85% or better counts as a passed round; a level that never did goes back to square
one (its cards return to "new"; stars and stickers already earned stay).

## Games

The Games tile (and *Surprise me*) runs short rounds of eight questions drawn from the levels already reached:
Slingshot, Feed the Monster, Bubble Pop, Frog Hop (math), Word Builder (spelling), Memory Match, Mystery
Picture and Rocket Launch. Games earn stars but never change a card's mastery, so a wild fling cannot mark a word
as trouble. Every game can be played by tapping alone; nothing has a timer, lives or a game-over.

## The 🙋 Help button (local AI helper)

If you run a local model, the Pi can ask it for a hint about the card the child is on and speak the reply.
Nothing leaves your network. In `/etc/default/starcards`:

```
STARCARDS_LLM_URL=http://192.168.1.20:11434/v1      # Ollama's OpenAI-compatible endpoint
STARCARDS_LLM_MODEL=llama3.1:8b
```

then `sudo systemctl restart starcards`. The button appears on practice and flashcard screens. The model is told
to give a hint, not the answer, in one or two short sentences; replies are trimmed and spoken by the tablet.
The Pi must be able to reach the model's address (a Pi on the ATT side of the UniFi gateway cannot see
the far side of a second router without a port forward; a Pi on the same network as the model can).

**Asking out loud** needs the microphone, which Safari only allows on https. One-time setup:

```bash
sudo bash /opt/starcards/tools/make_cert.sh starcards.local 192.168.1.50   # your Pi's name and IP
```

then follow the steps it prints (install the "Star Cards Home CA" profile on the iPad and trust it, set
`STARCARDS_ARGS=--cert /etc/starcards/cert.pem --key /etc/starcards/key.pem --port 443`, restart, and re-add
https://starcards.local/ to the Home Screen). The 🙋 button then listens for a question first.

## Editing the cards

Decks are JSON files in `content/decks/`; the format and rules are in `CONTENT.md`. Edit on Windows, run
`python tools/validate_content.py`, then deploy again. (To edit on the Pi itself, copy `content/` to
`/var/lib/starcards/content` and set `STARCARDS_ARGS=--content-dir /var/lib/starcards/content`.) Saved files are
picked up on the next page load, no restart needed.

## Tests

```bash
python -m unittest discover -s tests        # server: API, lock, tests, flags, backups, static files
python tools/validate_content.py            # every deck against the content rules
```

In the browser, open `/tests/` (also linked from Grown-ups → Settings → About) to run the learning-rule tests,
load every game module, and check every card on the Pi makes a sound question. The two implementations of the
card-stats rule (Python and JavaScript) are checked against the same vectors in `web/tests/stat_vectors.json`.

**Ergonomics audit:** open the app as `http://starcards.local/?audit#/` and a small panel measures every screen
you visit against the kid rules (tap targets at least 64 px, answer choices 100 px, nothing tappable in the bottom
tenth of a landscape screen, child-facing text at least 17 px, icon buttons labelled). Green = clean.

## Folder map

```
server.py            the whole server: static files, content bundle, API, SQLite, PIN lock, Help proxy, backups
web/                 the app  (js/main.js router, js/views/* screens, js/games/* games, css/app.css)
content/             subjects.json + decks/*.json
tools/               validate_content.py, make_icons.py, make_cert.sh
tests/               server tests;  web/tests/ browser self-check
deploy/              systemd unit, install.sh, deploy-from-windows.ps1, default settings file
```
