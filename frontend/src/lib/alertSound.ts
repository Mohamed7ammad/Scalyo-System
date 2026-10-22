'use client';

/* ════════════════════════════════════════════════════════════════════════════
   Shared alert tones — Web Audio API, no sound files to ship.
   Browsers only allow audio after the user has interacted with the page, so
   installAudioUnlock() creates / resumes ONE AudioContext on the user's taps and
   keys; staff interact constantly, so it is ready long before an alert fires.
   ════════════════════════════════════════════════════════════════════════════ */

let ctx: AudioContext | null = null;

function unlockAudio() {
  try {
    const AC = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ctx && AC) ctx = new AC();
    if (ctx?.state === 'suspended') void ctx.resume();
  } catch { /* audio unavailable */ }
}

/** Listen for the user's taps/keys to unlock audio. Returns a cleanup function. */
export function installAudioUnlock(): () => void {
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
  return () => {
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
}

type ToneName = 'agentIdlePrompt' | 'supervisorAlert';
const TONES: Record<ToneName, { notes: number[]; gap: number; peak: number; wave: OscillatorType }> = {
  /* Agent «هل ما زلتِ هنا؟» — insistent 4-note chime (she may be on a call). */
  agentIdlePrompt: { notes: [880, 1318.5, 880, 1318.5], gap: 0.22, peak: 0.4,  wave: 'triangle' },
  /* Team Leader alert toast — soft two-note ping, distinct from the agent's. */
  supervisorAlert: { notes: [659.25, 987.77],            gap: 0.18, peak: 0.18, wave: 'sine' },
};

/** Play a tone if audio has been unlocked; silently does nothing otherwise. */
export function playTone(name: ToneName) {
  try {
    if (!ctx || ctx.state !== 'running') return;
    const { notes, gap, peak, wave } = TONES[name];
    notes.forEach((freq, i) => {
      const t = ctx!.currentTime + i * gap;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = wave;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + gap - 0.02);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + gap - 0.01);
    });
  } catch { /* audio unavailable */ }
}
