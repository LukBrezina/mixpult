# Mixpult web

Catchy night techno for beginners, played from a phone. An 8-bar loop (F minor, 130 BPM by default; tempo is on the FX tab) and five tracks: drums, mood, bass, melody and voice. Each one has just a 2D pad, a record button and the loop drawn as a glowing line. Up/down picks the beat, the mood or the pitch; left/right is energy (a smooth crossfade of three sounds). Touch the pad to hear it, hold the button to record. No note or chord names anywhere; bass and melody only play tones of the current chord, so nothing can sound out of key.

Voice is a launchpad instead: hold an empty pad and talk to record a short clip (the loop pauses meanwhile, since an iPhone plays back worse while the mic is on). Tap pads to chop the clips into the loop, hold the record button to keep them. A new song starts with two robot clips ("work it", "do it") on the launchpad. Clips run through a vocal chain (compression, presence and air, a bit of grit, chorus, big reverb and dotted delay, pumping with the kick) and are stored in IndexedDB.

The first run asks to go full screen (on iPhone: Add to Home Screen), then a tour blinks play, shows thumbs on the knob and the record button on each tab, and blinks the next tab after each recording. The ⋯ menu can show it again.

```sh
npm install
npm run dev     # https://localhost:5317, also on the LAN for a phone
npm test        # music theory, data model, beats
npm run build   # static build in dist/
npm run deploy  # build and upload to Cloudflare (mixpult.brezinovi.sk, see wrangler.jsonc)
```

The phone only allows the microphone over https, so the dev server uses a self-signed cert from `.cert/` (see `vite.config.js` for the one-line `openssl` command; put your LAN IP in it). The phone warns about the certificate once: tap through it.

- `src/theory.js` – key, chord palette, bass/melody rows (pure functions)
- `src/song.js` – data model; every change is a small `apply(song, op)` (ready for co-op)
- `src/patterns.js` – drum beats and energy layers
- `src/demo.js` – a full song for tests and level checks (not in the app)
- `src/sounds.js` – instruments: three layers per track (Tone.js), TR-909 drum samples
- `src/voice.js` – microphone capture, clip trimming, clip storage
- `src/tour.js` – first-run tour visuals: ghost thumbs, tips, pulsing targets (the steps live in `main.js`)
- `src/engine.js` – mixer, sidechain, DJ filter, sequencer, live play from the pad, WAV export
- `src/stroke.js` – the loop drawn as a glowing line (trail, recorded notes, sparks)
- `src/main.js` – UI

Samples: see `public/samples/CREDITS.md`.
