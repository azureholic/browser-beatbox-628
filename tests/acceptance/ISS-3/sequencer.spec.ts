import { expect, type Page, test } from '@playwright/test';

/**
 * ISS-3 Acceptance Test Suite — 16-step continuous looping sequencer (REQ-002)
 *
 * Contract reference: ./contract.md
 * Default synthetic seed tempo: 120 BPM -> 16th-note step interval = 60_000 / (120 * 4) = 125 ms.
 * All timing assertions use Playwright's deterministic virtual clock (`page.clock`) with zero real-time sleeps.
 */
const TOTAL_STEPS = 16;
const DEFAULT_BPM = 120;
const STEP_INTERVAL_MS = 60_000 / (DEFAULT_BPM * 4); // 125 ms per 16th-note step
const SEEDED_INSTRUMENT_IDS = ['kick', 'snare', 'hihat-closed', 'clap'] as const;

async function mountBeatboxWithVirtualClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00.000Z') });
  await page.goto('/');
  await expect(page.getByTestId('beatbox-app')).toBeVisible();
}

async function startPlaybackFromInitialState(page: Page): Promise<void> {
  const app = page.getByTestId('beatbox-app');
  const playButton = page.getByTestId('transport-play');

  await expect(app).toHaveAttribute('data-playing', 'false');
  await expect(playButton).toBeVisible();
  await expect(playButton).toBeEnabled();

  await playButton.click();

  await expect(app).toHaveAttribute('data-playing', 'true');
  await expect(app).toHaveAttribute('data-current-step', '0');
}

test.describe('ISS-3: 16-step continuous looping sequencer (REQ-002)', () => {
  test('REQ-002_executes_all_16_steps_in_exact_sequential_order_and_tracks_current_step', async ({ page }) => {
    await mountBeatboxWithVirtualClock(page);

    const app = page.getByTestId('beatbox-app');

    // Verify all seeded instrument tracks render exactly 16 steps in ascending DOM order (indices 0..15)
    for (const instrumentId of SEEDED_INSTRUMENT_IDS) {
      const track = page.getByTestId(`track-${instrumentId}`);
      await expect(track).toBeVisible();

      const stepCells = track.locator(`[data-testid^="step-${instrumentId}-"]`);
      await expect(stepCells).toHaveCount(TOTAL_STEPS);

      for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
        const cell = stepCells.nth(stepIndex);
        await expect(cell).toHaveAttribute('data-testid', `step-${instrumentId}-${stepIndex}`);
        await expect(cell).toHaveAttribute('data-current', 'false');
      }
    }

    await startPlaybackFromInitialState(page);

    const observedSteps: number[] = [];

    for (let tick = 0; tick < TOTAL_STEPS; tick++) {
      if (tick > 0) {
        await page.clock.runFor(STEP_INTERVAL_MS);
      }

      await expect(app).toHaveAttribute('data-current-step', String(tick));
      const currentStepAttr = await app.getAttribute('data-current-step');
      observedSteps.push(Number(currentStepAttr));

      // Verify current-step indicator matches exclusively the active column across all 16 steps of each track
      for (const instrumentId of SEEDED_INSTRUMENT_IDS) {
        const track = page.getByTestId(`track-${instrumentId}`);
        await expect(
          track.locator(`[data-testid^="step-${instrumentId}-"][data-current="true"]`),
        ).toHaveCount(1);
        await expect(page.getByTestId(`step-${instrumentId}-${tick}`)).toHaveAttribute('data-current', 'true');
      }
    }

    expect(observedSteps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test('REQ-002_loops_continuously_from_step_16_back_to_step_1_without_manual_intervention', async ({ page }) => {
    await mountBeatboxWithVirtualClock(page);
    await startPlaybackFromInitialState(page);

    const app = page.getByTestId('beatbox-app');

    // Advance tick-by-tick from Step 1 (index 0) to Step 16 (index 15)
    for (let stepIndex = 1; stepIndex < TOTAL_STEPS; stepIndex++) {
      await page.clock.runFor(STEP_INTERVAL_MS);
      await expect(app).toHaveAttribute('data-current-step', String(stepIndex));
    }

    // Confirm we are at Step 16 (index 15) while still playing
    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '15');
    await expect(page.getByTestId('step-kick-15')).toHaveAttribute('data-current', 'true');
    await expect(page.getByTestId('step-kick-0')).toHaveAttribute('data-current', 'false');

    // Advance one additional step interval with NO user interaction -> wraps seamlessly to Step 1 (index 0)
    await page.clock.runFor(STEP_INTERVAL_MS);

    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect(page.getByTestId('step-kick-0')).toHaveAttribute('data-current', 'true');
    await expect(page.getByTestId('step-kick-15')).toHaveAttribute('data-current', 'false');
  });

  test('REQ-002_crosses_loop_boundary_multiple_times_deterministically_with_no_skips_duplicates_or_stalls', async ({
    page,
  }) => {
    await mountBeatboxWithVirtualClock(page);
    await startPlaybackFromInitialState(page);

    const app = page.getByTestId('beatbox-app');

    // Sub-interval determinism check: advancing less than STEP_INTERVAL_MS (60ms < 125ms) must not advance early
    await page.clock.runFor(60);
    await expect(app).toHaveAttribute('data-current-step', '0');

    // Completing the remaining 65ms (60 + 65 = 125ms) advances deterministically to index 1 (Step 2)
    await page.clock.runFor(STEP_INTERVAL_MS - 60);
    await expect(app).toHaveAttribute('data-current-step', '1');

    const fullCyclesToVerify = 3;
    const totalTicks = TOTAL_STEPS * fullCyclesToVerify; // 48 transitions -> crosses 15 -> 0 boundary 3 times
    const observedSequence: number[] = [0, 1];

    for (let tick = 2; tick <= totalTicks; tick++) {
      await page.clock.runFor(STEP_INTERVAL_MS);

      const expectedStep = tick % TOTAL_STEPS;
      await expect(app).toHaveAttribute('data-playing', 'true');
      await expect(app).toHaveAttribute('data-current-step', String(expectedStep));

      const rawStep = await app.getAttribute('data-current-step');
      observedSequence.push(Number(rawStep));
    }

    // Verify 49 observed states (initial 0 + 48 deterministic transitions) have zero skips, duplicates, or stalls
    expect(observedSequence).toHaveLength(totalTicks + 1);
    for (let i = 0; i <= totalTicks; i++) {
      expect(observedSequence[i]).toBe(i % TOTAL_STEPS);
    }

    // Explicitly verify all 3 wrap-around transitions (ticks 15->16, 31->32, 47->48)
    for (let cycle = 1; cycle <= fullCyclesToVerify; cycle++) {
      const lastStepOfCycleTick = cycle * TOTAL_STEPS - 1;
      const firstStepOfNextCycleTick = cycle * TOTAL_STEPS;
      expect(observedSequence[lastStepOfCycleTick]).toBe(15);
      expect(observedSequence[firstStepOfNextCycleTick]).toBe(0);
    }
  });

  test('REQ-002_toggles_per_step_activation_independently_across_multiple_instruments_and_persists_across_loops', async ({
    page,
  }) => {
    await mountBeatboxWithVirtualClock(page);

    const kickStep0 = page.getByTestId('step-kick-0');
    const kickStep1 = page.getByTestId('step-kick-1');
    const kickStep2 = page.getByTestId('step-kick-2');
    const snareStep1 = page.getByTestId('step-snare-1');
    const snareStep2 = page.getByTestId('step-snare-2');
    const hihatStep1 = page.getByTestId('step-hihat-closed-1');
    const clapStep0 = page.getByTestId('step-clap-0');

    // Baseline seeded states from synthetic 4x16 demo pattern
    await expect(kickStep0).toHaveAttribute('data-active', 'true');
    await expect(kickStep1).toHaveAttribute('data-active', 'false');
    await expect(kickStep2).toHaveAttribute('data-active', 'false');
    await expect(snareStep1).toHaveAttribute('data-active', 'false');
    await expect(snareStep2).toHaveAttribute('data-active', 'false');
    await expect(hihatStep1).toHaveAttribute('data-active', 'false');
    await expect(clapStep0).toHaveAttribute('data-active', 'false');

    // Toggle inactive step ON for Kick (step index 1) -> only kick step 1 changes
    await kickStep1.click();
    await expect(kickStep1).toHaveAttribute('data-active', 'true');
    await expect(kickStep2).toHaveAttribute('data-active', 'false');
    await expect(snareStep1).toHaveAttribute('data-active', 'false');
    await expect(hihatStep1).toHaveAttribute('data-active', 'false');

    // Toggle active step OFF for Kick (step index 0) -> only kick step 0 changes
    await kickStep0.click();
    await expect(kickStep0).toHaveAttribute('data-active', 'false');
    await expect(kickStep1).toHaveAttribute('data-active', 'true');

    // Activate distinct steps on Snare (step index 2) and Clap (step index 0)
    await snareStep2.click();
    await clapStep0.click();
    await expect(snareStep2).toHaveAttribute('data-active', 'true');
    await expect(clapStep0).toHaveAttribute('data-active', 'true');
    await expect(kickStep0).toHaveAttribute('data-active', 'false');
    await expect(kickStep2).toHaveAttribute('data-active', 'false');

    // Start playback, toggle Closed Hi-Hat step 1 while playing, and run across a full 16-step loop
    await startPlaybackFromInitialState(page);
    await hihatStep1.click();
    await expect(hihatStep1).toHaveAttribute('data-active', 'true');

    for (let tick = 1; tick <= TOTAL_STEPS; tick++) {
      await page.clock.runFor(STEP_INTERVAL_MS);
    }

    // Back at Step 1 (index 0) after full loop; all multi-instrument step activations must persist
    await expect(page.getByTestId('beatbox-app')).toHaveAttribute('data-current-step', '0');
    await expect(kickStep0).toHaveAttribute('data-active', 'false');
    await expect(kickStep1).toHaveAttribute('data-active', 'true');
    await expect(snareStep2).toHaveAttribute('data-active', 'true');
    await expect(hihatStep1).toHaveAttribute('data-active', 'true');
    await expect(clapStep0).toHaveAttribute('data-active', 'true');
  });
});
