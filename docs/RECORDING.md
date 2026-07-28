# Recording the GIFs

```sh
npm run record        # -> docs/media/*.gif
```

Drives a real browser as the host while three bots fill the table and play
their own turns, so a whole game records with no human input. It runs its own
server on port 4398 with a throwaway data dir, so it never touches a running
dev server or your real `./data`.

Uses the **system Chrome** (`channel: 'chrome'`) rather than downloading one, so
`playwright` is a small devDependency. Video capture needs Playwright's own
bundled ffmpeg once (`npx playwright install ffmpeg`, ~1MB), and the GIF step
needs `ffmpeg` on PATH — without it the `.webm` is still written.

The script marks when each scene starts and slices the recording at those
marks, so the clips follow the animations rather than hard-coded timestamps
that would drift. Two things worth knowing if you change it:

- Playwright's webm carries irregular timestamps and **cannot be seeked
  accurately** — slicing it directly yielded clips of entirely the wrong scene.
  It's re-encoded to a constant frame rate first.
- GIFs are built in two ffmpeg passes (`palettegen` then `paletteuse`). A
  single pass quantises to a generic palette and visibly bands the paper.

Tune `FPS` and `WIDTH` at the top of `scripts/record.mjs` if the files are too
heavy; they're ~0.4–1.5MB each at the current settings.
