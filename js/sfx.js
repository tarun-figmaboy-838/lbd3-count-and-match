/* ==========================================================================
 * sfx.js -- game feel layer
 *
 * The Unity project ships exactly two sound effects (tap.mp3, tap_b645f6.mp3)
 * and nine voice-over lines, so there is no correct / wrong / reward / finish
 * sound to reuse. Rather than invent asset files, these cues are synthesised
 * with WebAudio: no downloads, no new bytes, nothing to 404, and every cue is
 * mixed well under the voice-over so speech always stays the clearest thing.
 *
 * Every entry point is safe to call before the audio context is unlocked and
 * on browsers with no WebAudio at all -- it simply does nothing.
 * ======================================================================== */
'use strict';

var Sfx = (function () {

  var ctx = null, master = null, ready = false, muted = false;
  var last = Object.create(null);          // cue -> last play time (de-dupe)
  var MASTER = 0.34;                       // headroom: VO sits on top of this

  function context() {
    if (ctx || ready) return ctx;
    ready = true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  /** Browsers start the context suspended; resume it on the first gesture. */
  function unlock() {
    var c = context();
    if (c && c.state === 'suspended') { try { c.resume(); } catch (e) { } }
  }

  function env(gain, t0, dur, peak, attack) {
    var a = attack == null ? 0.006 : attack;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  /** One shaped oscillator voice. */
  function tone(opts) {
    var c = context();
    if (!c || muted) return;
    var t0 = c.currentTime + (opts.delay || 0);
    var dur = opts.dur || 0.18;
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.from, t0);
    if (opts.to && opts.to !== opts.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + dur);
    }
    env(gain, t0, dur, opts.peak == null ? 0.5 : opts.peak, opts.attack);
    osc.connect(gain);
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, t0);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Filtered noise burst -- used for the soft shaker/whoosh textures. */
  function noise(opts) {
    var c = context();
    if (!c || muted) return;
    var t0 = c.currentTime + (opts.delay || 0);
    var dur = opts.dur || 0.2;
    var frames = Math.max(1, Math.floor(c.sampleRate * dur));
    var buf = c.createBuffer(1, frames, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) d[i] = (Math.random() * 2 - 1);
    var src = c.createBufferSource();
    src.buffer = buf;
    var bp = c.createBiquadFilter();
    bp.type = opts.filter || 'bandpass';
    bp.frequency.setValueAtTime(opts.from || 1200, t0);
    if (opts.to) bp.frequency.exponentialRampToValueAtTime(Math.max(80, opts.to), t0 + dur);
    bp.Q.value = opts.q == null ? 1 : opts.q;
    var gain = c.createGain();
    env(gain, t0, dur, opts.peak == null ? 0.25 : opts.peak, opts.attack || 0.01);
    src.connect(bp); bp.connect(gain); gain.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /* ------------------------------------------------------------------ cues */
  var CUES = {
    // picking a tray: a small bright pop that rises, so two picks in a row
    // feel like progress rather than the same beep twice
    select: function (n) {
      var base = 620 * Math.pow(1.18, Math.min(2, n || 0));
      tone({ type: 'triangle', from: base, to: base * 1.5, dur: 0.13, peak: 0.42 });
      tone({ type: 'sine', from: base * 2, to: base * 2.6, dur: 0.09, peak: 0.16, delay: 0.01 });
    },
    // deselect / undo: the select pop played downwards
    deselect: function () {
      tone({ type: 'triangle', from: 620, to: 420, dur: 0.13, peak: 0.34 });
    },
    // matched pair: a rising three-note arpeggio (major triad) = "well done"
    correct: function () {
      [0, 0.085, 0.17].forEach(function (d, i) {
        tone({ type: 'triangle', from: [660, 830, 990][i], dur: 0.3, peak: 0.4, delay: d });
        tone({ type: 'sine', from: [1320, 1660, 1980][i], dur: 0.24, peak: 0.11, delay: d });
      });
      noise({ from: 5200, to: 8000, dur: 0.4, peak: 0.07, delay: 0.16, q: 0.7 });
    },
    // wrong pair: warm and low, never harsh -- this is a five-year-old's game
    wrong: function () {
      tone({ type: 'sine', from: 300, to: 190, dur: 0.34, peak: 0.4, attack: 0.02 });
      tone({ type: 'sine', from: 226, to: 150, dur: 0.4, peak: 0.26, delay: 0.07, attack: 0.03 });
    },
    // the correct badge popping onto a tray
    pop: function () {
      tone({ type: 'sine', from: 880, to: 1500, dur: 0.11, peak: 0.3 });
    },
    // key reward
    reward: function () {
      [988, 1318, 1568, 2093].forEach(function (f, i) {
        tone({ type: 'triangle', from: f, dur: 0.42, peak: 0.3, delay: i * 0.07 });
      });
      noise({ from: 4000, to: 9000, dur: 0.7, peak: 0.08, delay: 0.1, q: 0.6 });
    },
    // end-of-game celebration
    celebrate: function () {
      [523, 659, 784, 1047].forEach(function (f, i) {
        tone({ type: 'triangle', from: f, to: f * 1.01, dur: 0.5, peak: 0.32, delay: i * 0.1 });
      });
      noise({ from: 2000, to: 7000, dur: 0.55, peak: 0.1, delay: 0.05, q: 0.5 });
    },
    // screen change
    whoosh: function () {
      noise({ filter: 'lowpass', from: 400, to: 3000, dur: 0.34, peak: 0.16, q: 0.4 });
    },
    // generic UI button, layered under the existing tap.mp3
    button: function () {
      tone({ type: 'sine', from: 520, to: 700, dur: 0.09, peak: 0.26 });
    }
  };

  /**
   * Play a cue. `minGap` collapses repeats: one action can call this from more
   * than one place (a scene event AND a controller) without doubling the sound.
   */
  function play(name, arg, minGap) {
    var fn = CUES[name];
    if (!fn || muted) return;
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var gap = minGap == null ? 60 : minGap;
    if (last[name] && now - last[name] < gap) return;
    last[name] = now;
    unlock();
    try { fn(arg); } catch (e) { }
  }

  return {
    play: play, unlock: unlock,
    setMuted: function (m) { muted = !!m; },
    isMuted: function () { return muted; },
    cues: function () { return Object.keys(CUES); },
    state: function () { return ctx ? ctx.state : 'none'; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sfx;
