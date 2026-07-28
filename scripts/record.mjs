// Records the app playing itself and cuts the result into GIFs for the README.
//
//   npm run record
//
// Drives one real browser as the host; three bots fill the table and play their
// own turns, so a whole game runs with no human input. The script notes when
// each scene starts, then slices the single recorded video at those marks —
// hard-coded timestamps would drift the moment an animation's duration changes.
//
// Uses the system Chrome (channel: 'chrome'), so installing playwright does not
// pull a browser down with it. Needs ffmpeg on PATH for the GIF step; without
// it the .webm is still written and the script says so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'docs', 'media');
const PORT = 4398; // not 4321: never disturbs a running dev server or container
const URL = `http://localhost:${PORT}`;
const VIEWPORT = { width: 390, height: 844 }; // a phone, which is how this is played

// GIF quality knobs. 12fps is plenty for paper folding and keeps README files small.
const FPS = 12;
const WIDTH = 380;

const marks = [];
let t0 = 0;
const mark = (name) => marks.push({ name, at: Date.now() - t0 });
// A boundary with no name: closes off the previous named clip without
// opening a new tracked gif for whatever comes next — for stretches (bots
// autoplaying a round with nobody to watch) that aren't worth a README image.
const skip = () => mark(null);

function have(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(ms = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${URL}/`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > ms) throw new Error('server never came up');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(REPO, 'client', 'dist', 'index.html'))) {
    throw new Error('client/dist is missing — run `npm run build:client` first');
  }

  // a throwaway data dir, so recording never touches real rooms
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-record-'));
  const server = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SELF_URL: URL },
    stdio: 'ignore',
  });

  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-video-'));
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch({ channel: 'chrome' });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      recordVideo: { dir: videoDir, size: VIEWPORT },
      // the turn timer and the paper both animate; reduced motion would flatten
      // exactly what we are trying to show
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    t0 = Date.now();

    await page.goto(URL);
    await page.getByPlaceholder('Please enter your name').fill('David');
    await page.waitForTimeout(700);

    mark('lobby');
    await page.getByRole('button', { name: /Start a new game/ }).click();
    await page.getByRole('heading', { name: 'Team Blue' }).waitFor();
    // 1 word per player — 4 total slips, so a round finishes in a handful of
    // clicks instead of 20. Rounds 2 and 3 need to actually complete (bots
    // autoplaying) to reach the scores screen later in this recording.
    await page.getByLabel('Words per player').fill('1');
    await page.getByLabel('Words per player').press('Enter');
    await page.waitForTimeout(500);
    // +1 three times, not "Fill to 4" — bots.js has no artificial stagger
    // between joins (nor should it, for real players), so clicking the bulk
    // button lands all three in one burst and the gif is mostly a static
    // already-full table. Clicking one at a time is what actually shows the
    // table filling up rather than just jumping to "full".
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: '🤖 +1' }).click();
      await page.waitForTimeout(500);
    }

    mark('cut');
    await page.getByRole('button', { name: /^Start game/ }).click();
    await page.waitForTimeout(2200); // the sheet becomes slips

    mark('writing');
    await page.getByRole('button', { name: /Fill the empty ones for me/ }).click();
    await page.waitForTimeout(1400);

    mark('submit');
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.waitForTimeout(2600); // fold + drop into the box

    mark('turn');
    // host is team A's first drawer, so the human seat is the one drawing
    await page.getByRole('button', { name: /Ready — start turn/ }).click();
    await page.waitForTimeout(1400); // the first slip unfolds
    for (const label of ['Correct!', 'Correct!', 'Pass', 'Correct!']) {
      const button = page.getByRole('button', { name: label });
      if (!(await button.isVisible().catch(() => false))) break;
      await button.click();
      await page.waitForTimeout(1500); // let each slip finish its trip
    }

    skip(); // nothing here is worth a README image — real gameplay resumes off-camera
    // finish round 1 (the passed slip needs one more correct to empty the bag).
    // Same 1500ms pacing as the demo clicks above — the correct/pass flash and
    // paper-fold chain takes ~1s, and clicking too soon catches the button
    // mid-animation, where `isVisible()` can read false and end this loop
    // before the round has actually finished.
    while (await page.getByRole('button', { name: 'Correct!' }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Correct!' }).click();
      await page.waitForTimeout(1500);
    }
    // rounds 2 and 3: a bot draws both (team rotation lands on Wren, then
    // Nadia, with this exact 4-player table), so bots play the whole thing
    // out unattended — "Start the round now" is the host's own escape from
    // the ready gate (a <button> styled as a link), used here just to skip
    // the wait, not to cut the round short
    const startRoundNow = page.getByRole('button', { name: /Start the round now/ });
    async function skipReadyGateAndWaitForNext() {
      await startRoundNow.click();
      // wait for it to disappear (the round actually opened) before waiting
      // for it to come back (the round finished) — waiting for "visible" alone
      // right after the click can resolve instantly against the pre-click
      // render, one React tick before the click's effect actually lands
      await startRoundNow.waitFor({ state: 'hidden', timeout: 10_000 });
      await startRoundNow.waitFor({ state: 'visible', timeout: 30_000 });
    }
    await skipReadyGateAndWaitForNext(); // round 1 -> round 2, then wait for round 2 to finish
    await startRoundNow.click(); // round 2 -> round 3 (no gate reappears after round 3 — game ends instead)
    await page.getByRole('heading', { name: 'Final scores' }).waitFor({ timeout: 30_000 });

    mark('scores');
    await page.waitForTimeout(2600); // fanfare + confetti

    mark('end');
    await page.waitForTimeout(400);
    await context.close(); // flushes the video file
    const video = fs.readdirSync(videoDir).find((f) => f.endsWith('.webm'));
    if (!video) throw new Error('no video was written');
    const source = path.join(OUT, 'playthrough.webm');
    fs.copyFileSync(path.join(videoDir, video), source);
    console.log(`recorded ${path.relative(REPO, source)}`);

    if (!have('ffmpeg')) {
      console.log('ffmpeg not on PATH — keeping the .webm, skipping the GIFs');
      return;
    }

    // Normalise to a constant frame rate first. Playwright's webm carries
    // irregular timestamps, and seeking into it lands nowhere near the wall
    // clock — slicing it directly produced clips showing the wrong scene
    // entirely. Re-encoded at a fixed fps, `-ss` matches the marks.
    const cfr = path.join(OUT, 'playthrough.cfr.mp4');
    execFileSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', source, '-vf', `fps=${FPS}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', cfr],
      { stdio: 'inherit' },
    );

    for (let i = 0; i < marks.length - 1; i++) {
      const { name, at } = marks[i];
      if (!name) continue; // an unnamed boundary — see `skip()`
      const duration = (marks[i + 1].at - at) / 1000;
      const gif = path.join(OUT, `${name}.gif`);
      // two passes: build a palette from the clip, then map to it. One-pass GIF
      // encoding quantises to a generic palette and bands the paper badly.
      const filters = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
      execFileSync(
        'ffmpeg',
        // prettier-ignore
        [
          '-y', '-loglevel', 'error',
          '-ss', String(at / 1000), '-t', String(duration), '-i', cfr,
          '-filter_complex', `${filters},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
          gif,
        ],
        { stdio: 'inherit' },
      );
      const kb = Math.round(fs.statSync(gif).size / 1024);
      console.log(`  ${name}.gif  ${duration.toFixed(1)}s  ${kb}kB`);
    }
    fs.rmSync(cfr, { force: true }); // intermediate only
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    fs.rmSync(videoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
