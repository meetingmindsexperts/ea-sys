/**
 * Audio feedback for barcode-scan surfaces (staff check-in scanner + the
 * self-service kiosk). One implementation — the two pages used to carry
 * byte-identical copies (kiosk review L2).
 *
 * Client-only by nature (Web Audio API); safe to import anywhere because
 * nothing runs at module load.
 */
export function playBeep(success: boolean) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = success ? 800 : 300;
    osc.type = success ? "sine" : "square";
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + (success ? 0.15 : 0.3));
  } catch {
    // Audio not supported
  }
}
