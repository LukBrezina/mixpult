# Mixpult web

Groovebox pro začátečníky: smyčka 1/2/4 takty, do které se postupně naťukají bicí, akordy, basa a melodie. Všechno je zamčené do stupnice zvolené nálady, takže nic nezní falešně.

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # hudební teorie, datový model, generátory
npm run build   # statická verze do dist/
```

- `src/theory.js` – stupnice, akordy, voicingy (čisté funkce)
- `src/song.js` – datový model písničky, validace importu, změna délky
- `src/patterns.js` – hotové rytmy, postupy, „vymysli za mě“
- `src/sounds.js` – nástroje (Tone.js syntezátory, piano a bicí ze samplů)
- `src/engine.js` – mixpult, efekty, sekvencer, WAV export
- `src/main.js` – UI

Samply: viz `public/samples/CREDITS.md`.
