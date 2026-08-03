/* ==========================================================================
 * engine.js -- dependency-free uGUI runtime
 *
 * Reproduces the parts of Unity that this game actually uses:
 *   - RectTransform anchor/pivot/sizeDelta layout (exact, both axes independent)
 *   - canvas locked to the reference resolution, centred and letterboxed
 *   - nested Canvas overrideSorting -> z-index
 *   - Image (simple), tint via multiply blend, linear->sRGB colour
 *     conversion, preserveAspect
 *   - TextMeshPro alignment / spacing / autosize approximation
 *   - GridLayoutGroup
 *   - Unity lifecycle (Awake / OnEnable / Start / Update / OnDisable)
 *   - cancellable coroutines, LeanTween + DOTween easing and tween kinds
 *   - AudioSource channels with browser unlock
 *   - ParticleSystem canvas approximation
 *
 * No framework, no build step, no fetch(). Layout/config are embedded by
 * data.js as window.LAYOUT / window.CONFIG.
 * ======================================================================== */
'use strict';

var Engine = (function () {

  // ------------------------------------------------------------------ state
  var stage = null, viewport = null, booted = false;
  var nodes = Object.create(null);      // id -> {id,data,el,parent,active,...}
  var order = [];                       // ids in creation (draw) order
  var refW = 1920, refH = 1080;
  var colorSpace = 0;
  var canvasScale = 1, stageW = 1920, stageH = 1080;
  var resizeHooks = [], tickHooks = [];
  var audioUnlocked = false, pendingAudio = [];
  var rafId = null, lastT = 0;
  var particleSystems = [];

  // ------------------------------------------------------------ colour math
  // Unity Linear colour space: serialized Image/TMP colours are linear;
  // the browser composites in sRGB, so convert or everything reads too dark.
  function lin2srgb(c) {
    if (c <= 0) return 0;
    if (c <= 0.0031308) return c * 12.92;
    return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }
  function css(rgba) {
    if (!rgba) return 'rgba(255,255,255,1)';
    var r = rgba[0], g = rgba[1], b = rgba[2], a = rgba.length > 3 ? rgba[3] : 1;
    if (colorSpace === 1) { r = lin2srgb(r); g = lin2srgb(g); b = lin2srgb(b); }
    return 'rgba(' + Math.round(clamp01(r) * 255) + ',' +
      Math.round(clamp01(g) * 255) + ',' + Math.round(clamp01(b) * 255) + ',' +
      (Math.round(clamp01(a) * 1000) / 1000) + ')';
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function isWhite(c) {
    return !c || (c[0] >= 0.999 && c[1] >= 0.999 && c[2] >= 0.999);
  }

  // ------------------------------------------------------------------ easing
  // LeanTween / DOTween easing. Names accept either library's spelling.
  var E = {
    linear: function (t) { return t; },
    inQuad: function (t) { return t * t; },
    outQuad: function (t) { return t * (2 - t); },
    inOutQuad: function (t) {
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    },
    inCubic: function (t) { return t * t * t; },
    outCubic: function (t) { return (--t) * t * t + 1; },
    inOutCubic: function (t) {
      return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
    },
    inSine: function (t) { return 1 - Math.cos(t * Math.PI / 2); },
    outSine: function (t) { return Math.sin(t * Math.PI / 2); },
    inOutSine: function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; },
    inBack: function (t) { var s = 1.70158; return t * t * ((s + 1) * t - s); },
    outBack: function (t) {
      var s = 1.70158; t -= 1; return t * t * ((s + 1) * t + s) + 1;
    },
    inOutBack: function (t) {
      var s = 1.70158 * 1.525;
      if ((t *= 2) < 1) return 0.5 * (t * t * ((s + 1) * t - s));
      return 0.5 * ((t -= 2) * t * ((s + 1) * t + s) + 2);
    },
    outElastic: function (t) {
      if (t === 0 || t === 1) return t;
      var p = 0.3, s = p / 4;
      return Math.pow(2, -10 * t) * Math.sin((t - s) * (2 * Math.PI) / p) + 1;
    },
    outBounce: function (t) {
      if (t < 1 / 2.75) return 7.5625 * t * t;
      if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; }
      if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; }
      t -= 2.625 / 2.75; return 7.5625 * t * t + 0.984375;
    }
  };
  var EASE_ALIAS = {
    'Linear': 'linear', 'easeLinear': 'linear',
    'InQuad': 'inQuad', 'easeInQuad': 'inQuad',
    'OutQuad': 'outQuad', 'easeOutQuad': 'outQuad',
    'InOutQuad': 'inOutQuad', 'easeInOutQuad': 'inOutQuad',
    'InSine': 'inSine', 'easeInSine': 'inSine',
    'OutSine': 'outSine', 'easeOutSine': 'outSine',
    'InOutSine': 'inOutSine', 'easeInOutSine': 'inOutSine',
    'InBack': 'inBack', 'easeInBack': 'inBack',
    'OutBack': 'outBack', 'easeOutBack': 'outBack',
    'InOutBack': 'inOutBack', 'easeInOutBack': 'inOutBack',
    'OutElastic': 'outElastic', 'easeOutElastic': 'outElastic',
    'InCubic': 'inCubic', 'OutCubic': 'outCubic', 'InOutCubic': 'inOutCubic'
  };
  function ease(name) {
    if (typeof name === 'function') return name;
    if (!name) return E.linear;
    return E[EASE_ALIAS[name] || name] || E.linear;
  }

  // ------------------------------------------------------- task groups
  // Replicates StopAllCoroutines / DOTween.Kill semantics: every timer and
  // tween belongs to a token, and cancelling a token kills all of them.
  var groupSeq = 0;
  var liveGroups = [];        // every group with work in flight (QA/God Mode)
  var paused = false;
  function TaskGroup(owner) {
    this.owner = owner || ('g' + (++groupSeq));
    this.cancelled = false;
    this.paused = paused;
    this.timers = [];
    this.tweens = [];
    liveGroups.push(this);
    if (liveGroups.length > 400) {         // drop groups that have gone quiet
      liveGroups = liveGroups.filter(function (g) {
        return !g.cancelled && (g.timers.length || g.tweens.length);
      });
    }
  }
  /** Snapshot of outstanding timers / tweens, for the debug panel. */
  TaskGroup.pending = function () {
    var out = [];
    liveGroups.forEach(function (g) {
      if (g.cancelled || (!g.timers.length && !g.tweens.length)) return;
      out.push({ owner: g.owner, timers: g.timers.length, tweens: g.tweens.length });
    });
    return out;
  };
  TaskGroup.cancelAll = function () {
    liveGroups.slice().forEach(function (g) { g.cancel(); });
    liveGroups = [];
  };
  TaskGroup.prototype.wait = function (sec) {
    var self = this;
    return new Promise(function (res) {
      if (self.cancelled) return;             // never resolves -> chain stops
      var id = setTimeout(function () {
        var i = self.timers.indexOf(id);
        if (i >= 0) self.timers.splice(i, 1);
        if (!self.cancelled) res();
      }, Math.max(0, sec * 1000));
      self.timers.push(id);
    });
  };
  TaskGroup.prototype.tween = function (dur, easeName, apply, onDone) {
    var self = this;
    if (self.cancelled) return Promise.resolve();
    var fn = ease(easeName);
    return new Promise(function (res) {
      var t0 = null, last = null, rec = { alive: true };
      self.tweens.push(rec);
      function step(ts) {
        if (!rec.alive || self.cancelled) return;
        if (t0 === null) t0 = last = ts;
        // holding the tween shifts its start so progress freezes, never jumps
        if (self.paused || paused) {
          t0 += (ts - last); last = ts;
          rec.raf = requestAnimationFrame(step);
          return;
        }
        last = ts;
        var k = dur <= 0 ? 1 : Math.min(1, (ts - t0) / (dur * 1000));
        try { apply(fn(k), k); } catch (e) { logErr(e); }
        if (k < 1) { rec.raf = requestAnimationFrame(step); }
        else {
          rec.alive = false;
          var i = self.tweens.indexOf(rec);
          if (i >= 0) self.tweens.splice(i, 1);
          if (onDone) { try { onDone(); } catch (e) { logErr(e); } }
          res();
        }
      }
      rec.raf = requestAnimationFrame(step);
    });
  };
  TaskGroup.prototype.delayedCall = function (sec, fn) {
    return this.wait(sec).then(function () { fn(); });
  };
  TaskGroup.prototype.cancel = function () {
    this.cancelled = true;
    for (var i = 0; i < this.timers.length; i++) clearTimeout(this.timers[i]);
    this.timers.length = 0;
    for (var j = 0; j < this.tweens.length; j++) {
      this.tweens[j].alive = false;
      if (this.tweens[j].raf) cancelAnimationFrame(this.tweens[j].raf);
    }
    this.tweens.length = 0;
  };
  TaskGroup.prototype.reset = function () { this.cancel(); this.cancelled = false; };
  // run a generator as a coroutine; `yield <number>` waits seconds,
  // `yield <promise>` awaits it. Cancelling the group stops it.
  TaskGroup.prototype.run = function (genFn) {
    var self = this, it = genFn();
    function pump(v) {
      if (self.cancelled) return Promise.resolve();
      var r;
      try { r = it.next(v); } catch (e) { logErr(e); return Promise.resolve(); }
      if (r.done) return Promise.resolve(r.value);
      var y = r.value;
      var p = (typeof y === 'number') ? self.wait(y)
        : (y && typeof y.then === 'function') ? y : Promise.resolve(y);
      return p.then(pump);
    }
    return pump();
  };

  function logErr(e) {
    if (typeof console !== 'undefined' && console.error) console.error(e);
  }

  // -------------------------------------------------------------- DOM build
  function el(tag, cls) {
    var d = document.createElement(tag || 'div');
    if (cls) d.className = cls;
    return d;
  }

  function buildNode(data, parentRec, depth) {
    var d = el('div', 'un');
    d.dataset.id = String(data.id);
    d.dataset.name = data.name == null ? '' : String(data.name);
    var rec = {
      id: String(data.id), data: data, el: d,
      parent: parentRec, children: [],
      activeSelf: !!data.active,
      img: null, tmp: null, btn: null, canvas: null, cg: null,
      grid: null, particles: null,
      audio: null, started: false, controllers: [],
      w: 0, h: 0, left: 0, top: 0,
      scale: (data.scale || [1, 1, 1]).slice(),
      rotZ: data.rotZ || 0,
      posOverride: null,   // {x,y} runtime anchoredPosition override
      alpha: 1
    };
    nodes[rec.id] = rec;
    order.push(rec.id);

    var comps = data.components || [];
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      switch (c.kind) {
        case 'Image': rec.img = c; break;
        case 'TMP': rec.tmp = c; break;
        case 'Button': rec.btn = c; break;
        case 'Canvas': rec.canvas = c; break;
        case 'CanvasGroup': rec.cg = c; break;
        case 'GridLayout': rec.grid = c; break;
        case 'Particles': rec.particles = c; break;
        case 'AudioSource': rec.audio = c; break;
        default: break;
      }
    }

    // Unity drives the ROOT Canvas's RectTransform itself: the serialized
    // values are meaningless (sizeDelta 0,0 and localScale 0,0,0 here), so the
    // rect must be replaced with the canvas pixel size or nothing renders.
    if (rec.canvas) {
      var anc = parentRec, nested = false;
      while (anc) { if (anc.canvas) { nested = true; break; } anc = anc.parent; }
      rec.isRootCanvas = !nested;
      if (rec.isRootCanvas) { rec.scale = [1, 1, 1]; rec.rotZ = 0; }
    }

    applyGraphics(rec);

    if (!rec.activeSelf) d.classList.add('un-off');
    if (parentRec) parentRec.children.push(rec);
    (parentRec ? parentRec.el : stage).appendChild(d);

    var kids = data.children || [];
    for (var k = 0; k < kids.length; k++) buildNode(kids[k], rec, depth + 1);
    return rec;
  }

  // ------------------------------------------------------------- graphics
  function applyGraphics(rec) {
    var d = rec.el, img = rec.img, tmp = rec.tmp;

    // nested canvas that overrides sorting -> stacking context + z-index
    if (rec.canvas && rec.canvas.overrideSorting) {
      d.style.zIndex = String(rec.canvas.sortingOrder);
      d.style.isolation = 'isolate';
    }

    if (img && img.enabled) {
      paintImage(rec);
      if (!img.raycast) d.style.pointerEvents = 'none';
    } else if (!img && !tmp && !rec.btn) {
      d.style.pointerEvents = 'none';
    }

    if (tmp && tmp.enabled) {
      d.classList.add('un-tmp');
      var t = el('div', 'un-tmp-inner');
      rec.tmpEl = t;
      d.appendChild(t);
      var fam = tmp.font && tmp.font.family ? tmp.font.family : 'sans-serif';
      t.style.fontFamily = '"' + fam + '", sans-serif';
      t.style.fontSize = tmp.fontSize + 'px';
      var col = tmp.faceColor && tmp.faceColor.length ? tmp.faceColor : tmp.color;
      t.style.color = css(col);
      if (tmp.charSpacing) t.style.letterSpacing = (tmp.charSpacing / 100 * tmp.fontSize) + 'px';
      // TMP lineSpacing is a percentage of the font's line height
      t.style.lineHeight = (1 + (tmp.lineSpacing || 0) / 100) * 1.0 + 'em';
      t.style.whiteSpace = tmp.wrap ? 'pre-wrap' : 'pre';
      if (tmp.style & 1) t.style.fontWeight = 'bold';
      if (tmp.style & 2) t.style.fontStyle = 'italic';
      if (tmp.style & 4) t.style.textDecoration = 'underline';
      if (tmp.style & 8) t.style.textTransform = 'uppercase';
      if (tmp.outlineWidth > 0 && tmp.outlineColor) {
        var ow = (tmp.outlineWidth * tmp.fontSize * 0.1).toFixed(2);
        t.style.webkitTextStroke = ow + 'px ' + css(tmp.outlineColor);
        t.style.paintOrder = 'stroke fill';
      }
      // TMP horizontal alignment bitfield: 1 left, 2 center, 4 right,
      // 8 justified, 16 flush; vertical: 256 top, 512 middle, 1024 bottom
      d.style.display = 'flex';
      d.style.justifyContent = (tmp.alignH & 2) ? 'center'
        : (tmp.alignH & 4) ? 'flex-end' : 'flex-start';
      d.style.alignItems = (tmp.alignV & 512) ? 'center'
        : (tmp.alignV & 1024) ? 'flex-end' : 'flex-start';
      t.style.textAlign = (tmp.alignH & 2) ? 'center'
        : (tmp.alignH & 4) ? 'right' : 'left';
      var m = tmp.margin || [0, 0, 0, 0];
      d.style.paddingLeft = m[0] + 'px'; d.style.paddingTop = m[1] + 'px';
      d.style.paddingRight = m[2] + 'px'; d.style.paddingBottom = m[3] + 'px';
      if (!tmp.raycast) d.style.pointerEvents = 'none';
      setTextEl(rec, tmp.text);
    }

    if (rec.cg) {
      rec.alpha = rec.cg.alpha;
      d.style.opacity = rec.cg.alpha;
      if (!rec.cg.blocksRaycasts) d.style.pointerEvents = 'none';
    }

    if (rec.btn) {
      d.classList.add('un-btn');
      rec.interactable = rec.btn.interactable;
      if (!rec.interactable) d.classList.add('un-dis');
      d.style.cursor = 'pointer';
      d.style.pointerEvents = 'auto';
    }

    if (rec.particles) {
      particleSystems.push(rec);
      d.style.pointerEvents = 'none';
    }
  }

  /**
   * A Unity Image draws into its own layer, never onto the GameObject div, so
   * that a tint cannot affect child objects.
   *
   * Unity multiplies the sprite by m_Color. CSS background-blend-mode:multiply
   * reproduces that exactly and stays inside this layer -- an earlier version
   * used mask-image + background-color, which replaced the artwork with a flat
   * silhouette and also masked every child.
   */
  function ensureImgEl(rec) {
    if (rec.imgEl) return rec.imgEl;
    var d = el('div', 'un-img');
    rec.imgEl = d;
    rec.el.insertBefore(d, rec.el.firstChild);
    return d;
  }

  function paintImage(rec) {
    var img = rec.img;
    if (!img) return;
    var d = ensureImgEl(rec);
    d.removeAttribute('style');
    rec.preserveAspect = null;

    var s = img.sprite;
    var tint = img.color || [1, 1, 1, 1];
    var alpha = tint.length > 3 ? tint[3] : 1;
    var rgb = [tint[0], tint[1], tint[2]];
    if (alpha < 0.999) d.style.opacity = alpha;

    if (!s || !s.path) {
      // Unity draws a plain colour quad when the sprite is null or missing.
      d.style.backgroundColor = css(rgb);
    } else {
      d.style.backgroundImage = 'url("' + s.path + '")';
      d.style.backgroundRepeat = 'no-repeat';
      d.style.backgroundSize = '100% 100%';
      if (!isWhite(rgb)) {
        // Unity multiplies the sprite by m_Color; blending inside this layer
        // reproduces that without tinting the object's children.
        d.style.backgroundColor = css(rgb);
        d.style.backgroundBlendMode = 'multiply';
      }
      if (img.preserveAspect) rec.preserveAspect = [s.rect[2], s.rect[3]];
    }
    applyPreserveAspect(rec);
  }

  function applyPreserveAspect(rec) {
    if (!rec.preserveAspect || !rec.imgEl) return;
    var ar = rec.preserveAspect[0] / rec.preserveAspect[1];
    var bw = rec.w, bh = rec.h;
    if (!bw || !bh) return;
    if (bw / bh > ar) bw = bh * ar; else bh = bw / ar;
    rec.imgEl.style.backgroundSize = bw + 'px ' + bh + 'px';
    rec.imgEl.style.backgroundPosition = 'center center';
  }

  function setSprite(id, sprite) {
    var r = get(id);
    if (!r || !r.img) return;
    var s = (sprite && sprite.__sprite) ? sprite.__sprite : sprite;
    if (!s || !s.path) return;
    r.img.sprite = s;
    paintImage(r);
  }

  function setImageColor(id, rgba) {
    var r = get(id);
    if (!r || !r.img) return;
    r.img.color = rgba;
    paintImage(r);
  }

  function setTextEl(rec, str) {
    if (!rec.tmpEl) return;
    var s = str == null ? '' : String(str);
    if (rec.tmp && rec.tmp.richText) {
      // TMP rich text -> minimal HTML; escape everything else
      var esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      esc = esc.replace(/&lt;(\/?)(b|i|u|s)&gt;/gi, '<$1$2>');
      esc = esc.replace(/&lt;color=([#\w]+)&gt;/gi, '<span style="color:$1">')
        .replace(/&lt;\/color&gt;/gi, '</span>');
      rec.tmpEl.innerHTML = esc;
    } else {
      rec.tmpEl.textContent = s;
    }
    if (rec.tmp && rec.tmp.autoSize) autoSize(rec);
  }

  function autoSize(rec) {
    var t = rec.tmpEl, tmp = rec.tmp;
    var lo = tmp.sizeMin || 8, hi = tmp.sizeMax || tmp.fontSize;
    var boxW = rec.w - ((tmp.margin || [0, 0, 0, 0])[0] + (tmp.margin || [0, 0, 0, 0])[2]);
    var boxH = rec.h - ((tmp.margin || [0, 0, 0, 0])[1] + (tmp.margin || [0, 0, 0, 0])[3]);
    if (boxW <= 0 || boxH <= 0) return;
    var best = lo;
    for (var i = 0; i < 12; i++) {
      var mid = (lo + hi) / 2;
      t.style.fontSize = mid + 'px';
      if (t.scrollWidth <= boxW + 1 && t.scrollHeight <= boxH + 1) {
        best = mid; lo = mid;
      } else { hi = mid; }
    }
    t.style.fontSize = best + 'px';
  }

  // --------------------------------------------------------------- layout
  // Unity RectTransform, exact, per axis:
  //   size   = (aMax - aMin) * P + sizeDelta
  //   corner = aMin * P + anchoredPosition - sizeDelta * pivot
  // (bottom-left origin; flipped to CSS top-left afterwards)
  function layoutTree() {
    for (var i = 0; i < (LAYOUT_ROOTS || []).length; i++) {
      var rid = String(LAYOUT_ROOTS[i].id);
      if (nodes[rid]) layoutNode(nodes[rid], stageW, stageH);
    }
  }

  function layoutNode(rec, pw, ph) {
    var d = rec.data;
    if (rec.isRootCanvas) {
      rec.w = stageW; rec.h = stageH; rec.left = 0; rec.top = 0;
      var rs = rec.el.style;
      rs.left = '0px'; rs.top = '0px';
      rs.width = stageW + 'px'; rs.height = stageH + 'px';
      rs.transform = 'none'; rs.transformOrigin = '50% 50%';
      for (var rc = 0; rc < rec.children.length; rc++) {
        layoutNode(rec.children[rc], rec.w, rec.h);
      }
      return;
    }
    if (d.rect) {
      var aMin = d.anchorMin, aMax = d.anchorMax, sd = d.sizeDelta,
        pv = d.pivot, ap = rec.posOverride || d.anchoredPosition;

      var w = (aMax[0] - aMin[0]) * pw + sd[0];
      var h = (aMax[1] - aMin[1]) * ph + sd[1];
      var cx = aMin[0] * pw + ap[0] - sd[0] * pv[0];
      var cy = aMin[1] * ph + ap[1] - sd[1] * pv[1];

      if (w < 0) w = 0;
      if (h < 0) h = 0;

      rec.w = w; rec.h = h;
      rec.left = cx;
      rec.top = ph - (cy + h);
      var st = rec.el.style;
      st.left = rec.left + 'px';
      st.top = rec.top + 'px';
      st.width = w + 'px';
      st.height = h + 'px';
      applyTransform(rec);
      applyPreserveAspect(rec);
      if (rec.tmp && rec.tmp.autoSize) autoSize(rec);
    } else {
      // Plain Transform under a Canvas (particle roots): localPosition is in
      // canvas units, and a canvas unit IS a pixel, measured from the parent
      // RectTransform's pivot. Treating these as world units put every emitter
      // thousands of pixels off-screen.
      rec.w = 0; rec.h = 0;
      var p = d.position || [0, 0, 0];
      var par = rec.parent;
      var opx, opy;
      if (par && par.data && par.data.rect && !par.isRootCanvas) {
        opx = par.data.pivot[0] * pw;
        opy = (1 - par.data.pivot[1]) * ph;
      } else {                       // root canvas / stage: pivot is centred
        opx = pw / 2; opy = ph / 2;
      }
      rec.left = opx + p[0];
      rec.top = opy - p[1];
      rec.el.style.left = rec.left + 'px';
      rec.el.style.top = rec.top + 'px';
      rec.el.style.width = '0px';
      rec.el.style.height = '0px';
      applyTransform(rec);
    }

    if (rec.grid && rec.grid.enabled) { layoutGrid(rec); return; }
    for (var i = 0; i < rec.children.length; i++) {
      layoutNode(rec.children[i], rec.w, rec.h);
    }
  }

  function applyTransform(rec) {
    var d = rec.data, s = rec.scale, r = rec.rotZ;
    var tr = '';
    if (r) tr += 'rotate(' + (-r) + 'deg) ';
    if (s[0] !== 1 || s[1] !== 1) tr += 'scale(' + s[0] + ',' + s[1] + ') ';
    rec.el.style.transform = tr || 'none';
    var pv = d.rect ? d.pivot : [0.5, 0.5];
    rec.el.style.transformOrigin = (pv[0] * 100) + '% ' + ((1 - pv[1]) * 100) + '%';
  }


  // Unity GridLayoutGroup (constraint / start corner / axis / alignment)
  function layoutGrid(rec) {
    var g = rec.grid;
    var kids = rec.children.filter(function (c) { return c.activeSelf; });
    var n = kids.length;
    var pad = g.padding || {};
    var pl = pad.m_Left || 0, pr = pad.m_Right || 0,
      pt = pad.m_Top || 0, pb = pad.m_Bottom || 0;
    var cs = g.cellSize, sp = g.spacing;
    var cx, cy;
    var cc = g.runtimeConstraintCount != null
      ? g.runtimeConstraintCount : g.constraintCount;

    if (g.constraint === 1) {              // FixedColumnCount
      cx = cc; cy = Math.ceil(n / Math.max(1, cx));
    } else if (g.constraint === 2) {       // FixedRowCount
      cy = cc; cx = Math.ceil(n / Math.max(1, cy));
    } else {                                // Flexible
      var innerW = Math.max(1, rec.w - pl - pr);
      cx = Math.max(1, Math.floor((innerW + sp[0] + 0.001) / (cs[0] + sp[0])));
      cy = Math.ceil(n / cx);
    }
    if (n === 0) { cx = cy = 0; }

    var reqW = cx * cs[0] + Math.max(0, cx - 1) * sp[0];
    var reqH = cy * cs[1] + Math.max(0, cy - 1) * sp[1];
    var alignX = (g.childAlignment % 3) * 0.5;
    var alignY = Math.floor(g.childAlignment / 3) * 0.5;
    var offX = pl + (rec.w - (reqW + pl + pr)) * alignX;
    var offY = pt + (rec.h - (reqH + pt + pb)) * alignY;

    for (var i = 0; i < n; i++) {
      var px, py;
      if (g.startAxis === 0) { px = i % cx; py = Math.floor(i / cx); }
      else { px = Math.floor(i / cy); py = i % cy; }
      if (g.startCorner % 2 === 1) px = cx - 1 - px;
      if (Math.floor(g.startCorner / 2) === 1) py = cy - 1 - py;

      var k = kids[i];
      k.w = cs[0]; k.h = cs[1];
      k.left = offX + (cs[0] + sp[0]) * px;
      k.top = offY + (cs[1] + sp[1]) * py;
      k.el.style.left = k.left + 'px';
      k.el.style.top = k.top + 'px';
      k.el.style.width = k.w + 'px';
      k.el.style.height = k.h + 'px';
      applyTransform(k);
      for (var j = 0; j < k.children.length; j++) {
        layoutNode(k.children[j], k.w, k.h);
      }
    }
    // inactive children still need a defined box for when they reappear
    for (var m = 0; m < rec.children.length; m++) {
      if (!rec.children[m].activeSelf) {
        var c = rec.children[m];
        c.w = cs[0]; c.h = cs[1];
        c.el.style.width = c.w + 'px'; c.el.style.height = c.h + 'px';
        for (var q = 0; q < c.children.length; q++) {
          layoutNode(c.children[q], c.w, c.h);
        }
      }
    }
  }

  // ------------------------------------------------------------ boot scale
  /**
   * Locked canvas.
   *
   * The canvas is always exactly the reference resolution (1920x1080), scaled
   * by min(w/1920, h/1080) and centred, so every device gets a pixel-identical
   * composition inside letterbox / pillarbox bars.
   *
   * Unity's CanvasScaler was set to Expand, which keeps that scale factor but
   * grows the canvas in the shorter axis -- the stage became 1920x1440 at 4:3
   * and 2337x1080 on a phone, so edge-anchored elements drifted and the layout
   * differed per aspect ratio. Locking trades that for one guaranteed layout.
   */
  function computeScale() {
    var W = viewport.clientWidth, H = viewport.clientHeight;
    var s = Math.min(W / refW, H / refH);
    if (!isFinite(s) || s <= 0) s = 1;
    canvasScale = s;
    stageW = refW;
    stageH = refH;
    var offX = (W - refW * s) / 2, offY = (H - refH * s) / 2;
    var st = stage.style;
    st.width = refW + 'px';
    st.height = refH + 'px';
    // scale is applied first, then the centring offset, so offX/offY are in
    // final viewport pixels
    st.transform = 'translate(' + offX + 'px,' + offY + 'px) scale(' + s + ')';
    st.transformOrigin = '0 0';
    sizeAllFxCanvases();
    refreshAmbientFields();      // spread is measured in stage units
  }

  var LAYOUT_ROOTS = null;

  function boot(layout, cfg) {
    cfg = cfg || {};
    viewport = document.getElementById('viewport');
    stage = document.getElementById('stage');
    if (!viewport || !stage) throw new Error('missing #viewport / #stage');
    var sc = cfg.canvasScaler || {};
    refW = sc.referenceResolution ? sc.referenceResolution[0] : 1920;
    refH = sc.referenceResolution ? sc.referenceResolution[1] : 1080;
    // uiScaleMode / screenMatchMode / match / scaleFactor are ignored: the
    // canvas is locked to the reference resolution (see computeScale).
    colorSpace = cfg.colorSpace != null ? cfg.colorSpace : 0;

    if (booted) return nodes;               // boot() is idempotent
    booted = true;

    stage.innerHTML = '';
    nodes = Object.create(null); order = []; particleSystems = [];
    LAYOUT_ROOTS = layout;

    computeScale();
    for (var i = 0; i < layout.length; i++) buildNode(layout[i], null, 0);
    layoutTree();

    var pending = null;
    window.addEventListener('resize', function () {
      // coalesce bursts of resize events into one relayout per frame
      if (pending) return;
      pending = requestAnimationFrame(function () {
        pending = null;
        computeScale(); layoutTree();
        for (var r = 0; r < resizeHooks.length; r++) {
          try { resizeHooks[r](); } catch (e) { logErr(e); }
        }
      });
    });
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, unlockAudio, { passive: true });
    });
    startTick();
    return nodes;
  }

  // ---------------------------------------------------------- node access
  function get(id) { return nodes[String(id)]; }
  function byName(name, root) {
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var r = nodes[order[i]];
      if (String(r.data.name) === name) out.push(r);
    }
    return out;
  }
  function isActiveSelf(id) { var r = get(id); return !!(r && r.activeSelf); }
  /** Direct child of `id` whose GameObject name matches, or null. */
  function childByName(id, name) {
    var r = get(id);
    if (!r) return null;
    for (var i = 0; i < r.children.length; i++) {
      if (String(r.children[i].data.name) === name) return r.children[i].id;
    }
    return null;
  }
  function isActiveInHierarchy(id) {
    var r = get(id);
    while (r) { if (!r.activeSelf) return false; r = r.parent; }
    return true;
  }

  var activateHooks = [];
  function onActivated(fn) { activateHooks.push(fn); }

  function setActive(id, on) {
    var r = get(id);
    if (!r) return;
    on = !!on;
    if (r.activeSelf === on) return;
    r.activeSelf = on;
    r.el.classList.toggle('un-off', !on);
    // GridLayoutGroup parents re-flow when a child's active state changes
    if (r.parent && r.parent.grid) layoutGrid(r.parent);
    for (var i = 0; i < activateHooks.length; i++) activateHooks[i](r, on);
  }

  function setText(id, s) { var r = get(id); if (r) setTextEl(r, s); }
  function getText(id) {
    var r = get(id);
    return r && r.tmpEl ? (r.tmpEl.textContent || '') : '';
  }
  function setTextColor(id, rgba) {
    var r = get(id); if (r && r.tmpEl) r.tmpEl.style.color = css(rgba);
  }
  function setAlpha(id, a) {
    var r = get(id); if (!r) return;
    r.alpha = a; r.el.style.opacity = a;
  }
  function setScale(id, sx, sy) {
    var r = get(id); if (!r) return;
    r.scale[0] = sx; r.scale[1] = (sy == null ? sx : sy);
    applyTransform(r);
  }
  function getScale(id) { var r = get(id); return r ? r.scale.slice() : [1, 1, 1]; }
  /**
   * The scale the object was authored with, never mutated by runtime tweens.
   * Animate relative to this: assuming 1 silently resizes anything the scene
   * scaled, which is most of the decorative art here.
   */
  function baseScale(id) {
    var r = get(id);
    return (r && r.data && r.data.scale) ? r.data.scale[0] : 1;
  }
  /** Temporary stacking override; pass null to hand control back to the scene. */
  function raise(id, z) {
    var r = get(id);
    if (r) r.el.style.zIndex = (z == null ? '' : String(z));
  }
  function setRotZ(id, deg) {
    var r = get(id); if (!r) return;
    r.rotZ = deg; applyTransform(r);
  }
  function getRotZ(id) { var r = get(id); return r ? r.rotZ : 0; }
  function setAnchoredPos(id, x, y) {
    var r = get(id); if (!r) return;
    r.posOverride = [x, y];
    var pw = r.parent ? r.parent.w : stageW, ph = r.parent ? r.parent.h : stageH;
    if (r.parent && r.parent.grid) { layoutGrid(r.parent); return; }
    layoutNode(r, pw, ph);
  }
  function getAnchoredPos(id) {
    var r = get(id); if (!r) return [0, 0];
    return (r.posOverride || r.data.anchoredPosition || [0, 0]).slice();
  }
  // pixel offset applied on top of layout (used by DOShakePosition)
  function setPixelOffset(id, dx, dy) {
    var r = get(id); if (!r) return;
    r.el.style.marginLeft = (dx || 0) + 'px';
    r.el.style.marginTop = (dy || 0) + 'px';
  }
  function setInteractable(id, on) {
    var r = get(id); if (!r) return;
    r.interactable = !!on;
    r.el.classList.toggle('un-dis', !on);
  }
  function isInteractable(id) { var r = get(id); return !!(r && r.interactable); }

  // world-space centre of a node in stage pixels (for hand-hint placement)
  function centerOf(id) {
    var r = get(id); if (!r) return [0, 0];
    var x = 0, y = 0, n = r;
    while (n) { x += n.left; y += n.top; n = n.parent; }
    return [x + r.w / 2, y + r.h / 2];
  }

  // ------------------------------------------------------------ interaction
  // UnityEvent has two listener kinds. Inspector-wired ("persistent") calls
  // are NOT removed by onClick.RemoveAllListeners() -- only script-added ones
  // are. Invocation order is persistent first, then runtime, in order added.
  // Pointer Events only -- never mouse+touch together, so a tap can never
  // fire twice. The press is armed on pointerdown, captured for the whole
  // gesture, and only fires when the SAME pointer is released inside the
  // element, which kills ghost clicks and drag-in releases.
  var inputLocked = false;
  var pointerState = { active: 0, id: null, target: null };
  function setInputLocked(on) {
    inputLocked = !!on;
    document.body.classList.toggle('un-input-locked', inputLocked);
  }
  function isInputLocked() { return inputLocked; }

  function ensureClick(id) {
    var r = get(id);
    if (!r) return null;
    if (r._clickBound) return r;
    r._persist = [];
    r._runtime = [];
    r._pid = null;
    function disarm() {
      r._pid = null;
      r.el.classList.remove('un-press');
    }
    r._down = function (e) {
      if (inputLocked || !r.interactable) return;
      if (e.button != null && e.button !== 0) return;   // ignore right/middle
      if (r._pid !== null) return;                      // one finger per button
      e.preventDefault();
      unlockAudio();                                    // first-gesture unlock
      r._pid = e.pointerId;
      pointerState = { active: 1, id: e.pointerId, target: r.el.dataset.name || r.id };
      r.el.classList.add('un-press');
      try { r.el.setPointerCapture(e.pointerId); } catch (x) { }
    };
    r._up = function (e) {
      if (r._pid === null || e.pointerId !== r._pid) return;
      var wasArmed = true;
      disarm();
      pointerState = { active: 0, id: null, target: null };
      try { r.el.releasePointerCapture(e.pointerId); } catch (x) { }
      if (e.type !== 'pointerup') return;               // cancel / lostcapture
      if (inputLocked || !r.interactable || !wasArmed) return;
      // release must land inside the element (pointer capture keeps delivering
      // events after the finger has slid off, which would be a ghost click)
      var b = r.el.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right ||
        e.clientY < b.top || e.clientY > b.bottom) return;
      var list = r._persist.concat(r._runtime);
      for (var i = 0; i < list.length; i++) {
        try { list[i](); } catch (err) { logErr(err); }
      }
    };
    r.el.addEventListener('pointerdown', r._down);
    r.el.addEventListener('pointerup', r._up);
    r.el.addEventListener('pointercancel', r._up);
    r.el.addEventListener('lostpointercapture', r._up);
    r._clickBound = true;
    return r;
  }
  /** Scene-serialized (persistent) onClick list. */
  function setPersistentClick(id, fn) {
    var r = ensureClick(id);
    if (r) r._persist = [fn];
  }
  /** onClick.AddListener(...) at runtime. */
  function addClick(id, fn) {
    var r = ensureClick(id);
    if (r) r._runtime.push(fn);
  }
  /** onClick.RemoveAllListeners() -- runtime listeners only. */
  function clearClicks(id) {
    var r = get(id);
    if (r && r._runtime) r._runtime.length = 0;
  }
  function onClick(id, fn) { setPersistentClick(id, fn); }

  // ----------------------------------------------------------------- audio
  var channels = Object.create(null), cache = Object.create(null);
  var missing = Object.create(null);          // src -> true once it 404s
  function clip(src) {
    if (!src || missing[src]) return null;
    if (!cache[src]) {
      var a = new Audio();
      a.preload = 'auto';
      // a missing clip must never break the flow: mark it and move on
      a.addEventListener('error', function () { missing[src] = true; }, { once: true });
      a.src = src;
      cache[src] = a;
    }
    return cache[src];
  }
  function channel(name) {
    if (!channels[name]) channels[name] = { el: null, src: null, vol: 1, loop: false };
    return channels[name];
  }
  /**
   * Starting a clip on a channel always stops whatever that channel held.
   *
   * One reusable element per channel. Cloning the cached Audio per play (the
   * previous approach) issued a fresh network request every single time and
   * leaked a media element per play, which exhausted the browser's media
   * resources mid-session -- ERR_INSUFFICIENT_RESOURCES, after which clips
   * silently stopped loading.
   */
  function play(chName, src, opts) {
    opts = opts || {};
    if (!src || missing[src]) return;
    // Play the ONE cached element for this clip. Giving each channel its own
    // element meant the preloaded copy and the channel copy each fetched the
    // file, and re-assigning .src per line re-downloaded every voice-over on
    // every replay. One element per clip also makes it impossible for a sound
    // to overlap itself.
    var a = clip(src);
    if (!a) return;
    var ch = channel(chName);
    stopChannel(chName);                      // release what this channel held
    try { a.pause(); a.currentTime = 0; } catch (e) { }
    ch.el = a; ch.src = src;
    a.loop = !!opts.loop;
    a.volume = clamp01(opts.volume != null ? opts.volume : ch.vol);
    tryPlay(a);
  }
  /** Fire-and-forget cue on its own reusable element, keyed by clip. */
  function playOneShot(src, volume) {
    var a = clip(src);
    if (!a) return;
    a.loop = false;
    a.volume = clamp01(volume != null ? volume : 1);
    try { a.pause(); a.currentTime = 0; } catch (e) { }
    tryPlay(a);
  }
  function stopChannel(chName) {
    var ch = channels[chName];
    if (ch && ch.el) {
      var i = pendingAudio.indexOf(ch.el);
      if (i >= 0) pendingAudio.splice(i, 1);   // don't resurrect it on unlock
      try { ch.el.pause(); ch.el.currentTime = 0; } catch (e) { }
    }
  }
  function stopAllAudio() {
    Object.keys(channels).forEach(stopChannel);
    pendingAudio.length = 0;
  }
  function pauseAllAudio(on) {
    Object.keys(channels).forEach(function (k) {
      var el = channels[k].el; if (!el) return;
      try { if (on) el.pause(); else if (el.currentTime > 0) el.play(); } catch (e) { }
    });
  }
  /** Channels currently playing a clip. */
  function audioState() {
    return Object.keys(channels).filter(function (k) {
      var e = channels[k].el;
      return e && e.src && !e.paused && !e.ended;
    }).map(function (k) {
      var e = channels[k].el;
      return { channel: k, src: String(channels[k].src).replace(/^.*\//, ''),
        t: Math.round(e.currentTime * 10) / 10,
        dur: isFinite(e.duration) ? Math.round(e.duration * 10) / 10 : null,
        loop: e.loop, volume: e.volume };
    });
  }
  function tryPlay(a) {
    var p;
    try { p = a.play(); } catch (e) { return; }
    if (p && p.catch) {
      p.catch(function () {
        if (!audioUnlocked && pendingAudio.length < 8) pendingAudio.push(a);
      });
    }
  }
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    while (pendingAudio.length) {
      var a = pendingAudio.shift();
      try { a.play(); } catch (e) { }
    }
  }
  function isAudioUnlocked() { return audioUnlocked; }
  function audioDuration(src) {
    return new Promise(function (res) {
      var a = clip(src);
      if (!a) return res(0);
      if (a.readyState >= 1 && isFinite(a.duration)) return res(a.duration);
      a.addEventListener('loadedmetadata', function () {
        res(isFinite(a.duration) ? a.duration : 0);
      }, { once: true });
      setTimeout(function () { res(isFinite(a.duration) ? a.duration : 0); }, 1500);
    });
  }
  /**
   * Warms every asset and resolves once they have all settled (loaded OR
   * failed) so the caller has a real completion condition instead of a guess.
   * A per-asset cap keeps a hung request from stalling the game forever.
   */
  function preload(list, timeoutMs) {
    var srcs = [];
    (list || []).forEach(function (s) {
      if (s && srcs.indexOf(s) < 0) srcs.push(s);
    });
    // Images first, then audio. Both are fetched through a small worker pool:
    // firing every asset at once made the browser run out of media resources
    // (ERR_INSUFFICIENT_RESOURCES) and clips silently failed to load.
    srcs.sort(function (a, b) { return isImage(a) === isImage(b) ? 0 : (isImage(a) ? -1 : 1); });

    var total = srcs.length;
    return new Promise(function (resolve) {
      if (!total) return resolve({ total: 0, failed: [] });
      var failed = [], done = 0, next = 0, finished = false;
      var LANES = 4;

      var cap = setTimeout(function () { finish(true); }, timeoutMs || 15000);
      function finish(timedOut) {
        if (finished) return;
        finished = true;
        clearTimeout(cap);
        resolve({ total: total, failed: failed, timedOut: !!timedOut });
      }
      function step(src, ok) {
        if (finished) return;
        if (!ok) failed.push(src);
        if (++done >= total) return finish(false);
        pump();
      }
      function pump() {
        if (finished || next >= srcs.length) return;
        var src = srcs[next++];
        if (isImage(src)) {
          var im = new Image();
          im.onload = function () { step(src, true); };
          im.onerror = function () { step(src, false); };
          im.src = src;
          return;
        }
        var a = clip(src);
        if (!a) return step(src, false);
        if (a.readyState >= 2) return step(src, true);
        var settled = false;
        function once(ok) {
          if (settled) return;
          settled = true;
          step(src, ok);
        }
        a.addEventListener('canplaythrough', function () { once(true); }, { once: true });
        a.addEventListener('loadeddata', function () { once(true); }, { once: true });
        a.addEventListener('error', function () { once(false); }, { once: true });
        // a clip that stalls must not hold a lane forever
        setTimeout(function () { once(a.readyState >= 2); }, 6000);
      }
      for (var i = 0; i < Math.min(LANES, srcs.length); i++) pump();
    });
  }
  function isImage(src) { return /\.(png|jpe?g|webp|gif|svg)$/i.test(src); }
  /** Every sprite path referenced anywhere in a layout tree. */
  function spritePaths(roots) {
    var out = [];
    (roots || []).forEach(function walk(n) {
      (n.components || []).forEach(function (c) {
        if (c.kind === 'Image' && c.sprite && c.sprite.path) out.push(c.sprite.path);
      });
      (n.children || []).forEach(walk);
    });
    return out;
  }

  // ------------------------------------------------------------ tick / rAF
  function onTick(fn) { tickHooks.push(fn); }
  function startTick() {
    if (rafId) return;
    lastT = performance.now();
    (function loop(ts) {
      rafId = requestAnimationFrame(loop);
      var dt = Math.min(0.1, (ts - lastT) / 1000);
      lastT = ts;
      if (paused) return;                  // debug pause: hold the whole sim
      for (var i = 0; i < tickHooks.length; i++) {
        try { tickHooks[i](dt); } catch (e) { logErr(e); }
      }
      stepParticles(dt);
    })(lastT);
  }
  function setPaused(on) {
    paused = !!on;
    pauseAllAudio(paused);
    document.body.classList.toggle('un-paused', paused);
    for (var i = 0; i < liveGroups.length; i++) liveGroups[i].paused = paused;
  }
  function isPaused() { return paused; }

  // ------------------------------------------------------ particles (canvas)
  // Unity ParticleSystem cannot be reproduced mechanically; this is a Canvas
  // approximation driven by the serialized emission/lifetime/size/colour.
  //
  // Each system gets its OWN canvas, spliced into the DOM straight after the
  // top-level layer that owns it, so an effect stacks exactly where Unity had
  // it -- the background star field stays behind the trays and the confetti
  // stays on top, instead of one shared canvas painting over the whole UI.
  // Created on first draw and released the moment a system goes idle: a
  // full-stage canvas is a compositing layer, and keeping one alive per system
  // (six here, five of them idle) cost real frame time for nothing.
  function ensureFxCanvas(rec) {
    if (rec.fx) return rec.fx;
    var c = el('canvas', 'un-fx');
    rec.fx = c;
    rec.fxCtx = c.getContext('2d');
    var h = fxHost(rec);
    h.parent.insertBefore(c, h.before);
    sizeFxCanvas(c);
    return c;
  }
  function releaseFxCanvas(rec) {
    if (!rec.fx) return;
    if (rec.fx.parentNode) rec.fx.parentNode.removeChild(rec.fx);
    rec.fx = null; rec.fxCtx = null;
  }

  /** Where an effect layer belongs in the DOM, so it stacks like Unity's. */
  function fxHost(rec) {
    var top = rec;
    while (top.parent && !top.parent.isRootCanvas) top = top.parent;
    return { parent: top.parent ? top.parent.el : stage, before: top.el.nextSibling };
  }

  /**
   * An always-on looping emitter is ambient decoration (the backdrop star
   * field, the key's glow). Simulating those on a canvas meant repainting a
   * full-stage layer every single frame for the whole session -- measured at
   * ~40ms/frame, i.e. 62fps down to 20. They are built once as CSS-animated
   * elements instead, which the compositor animates for free, and the canvas
   * path is kept for transient bursts like the confetti.
   */
  function ensureAmbientField(rec) {
    if (rec.spark) return;
    var ps = rec.particles, sc = particleScale(rec);
    // A backdrop field covers the WHOLE canvas. The authored emitter box is
    // 1799x906 offset below centre, which left the top of the sky and both
    // edges bare -- the magic is meant to fill the scene, not sit in a patch.
    var spreadX = stageW, spreadY = stageH;
    var originX = 0, originY = 0;
    var dia = Math.max(3, (ps.startSize || 1) * sc * 0.5);
    // area-scaled count, so full coverage does not mean a thinner sprinkle
    var n = Math.max(10, Math.min(ps.maxParticles || 24, 54));
    var col = ps.startColor || [1, 1, 1, 1];
    var life = Math.max(1.2, ps.startLifetime || 4);

    var box = el('div', 'un-spark-field');
    box.style.width = spreadX + 'px';
    box.style.height = spreadY + 'px';
    box.style.left = originX + 'px';
    box.style.top = originY + 'px';
    var base = css([col[0], col[1], col[2]]);
    var peak = clamp01(col.length > 3 ? col[3] : 1);
    // A few tints around the authored colour: a single flat hue reads as dust,
    // a warm/cool mix reads as enchantment. The authored colour stays dominant.
    var TINTS = [base, base, base, '#fff8e0', '#ffffff', '#cfe9ff', '#ffd9f2'];

    for (var i = 0; i < n; i++) {
      var s = el('div', 'un-spark');
      // a spread of sizes, with a few noticeably brighter "hero" sparkles, so
      // the field has depth instead of looking like uniform dots
      var hero = (i % 5 === 0);
      var d = dia * (hero ? 1.15 + Math.random() * 0.35 : 0.5 + Math.random() * 0.55);
      s.style.width = s.style.height = d + 'px';
      var tint = TINTS[(Math.random() * TINTS.length) | 0];
      s.style.left = (Math.random() * 100) + '%';
      s.style.top = (Math.random() * 100) + '%';
      s.style.background = 'radial-gradient(circle, ' + tint + ' 0%, ' + tint +
        ' 22%, rgba(0,0,0,0) 72%)';
      s.style.color = tint;                      // the ::after star
      s.style.opacity = '0';
      s.style.setProperty('--pk', String(hero ? peak : peak * 0.72));
      // per-sparkle drift vector: mostly rising, with a lateral wander
      s.style.setProperty('--dx', ((Math.random() - 0.5) * 90).toFixed(1) + 'px');
      s.style.setProperty('--dy', (-40 - Math.random() * 90).toFixed(1) + 'px');
      s.style.animationDuration = (life * (0.55 + Math.random() * 0.75)).toFixed(2) + 's';
      s.style.animationDelay = (-Math.random() * life * 1.8).toFixed(2) + 's';
      box.appendChild(s);
    }
    var h = fxHost(rec);
    h.parent.insertBefore(box, h.before);
    rec.spark = box;
  }
  function releaseAmbientField(rec) {
    if (!rec.spark) return;
    if (rec.spark.parentNode) rec.spark.parentNode.removeChild(rec.spark);
    rec.spark = null;
  }
  function refreshAmbientFields() {
    for (var i = 0; i < particleSystems.length; i++) {
      var r = particleSystems[i];
      if (r.spark) { releaseAmbientField(r); ensureAmbientField(r); }
    }
  }
  // Particles are soft blobs, so the layer is rasterised at half resolution and
  // stretched by CSS. A full-stage backing store cost ~40ms/frame to clear and
  // composite (62fps -> 21fps); at half res the effect is indistinguishable.
  var FX_RES = 0.5;
  function sizeFxCanvas(c) {
    var w = Math.max(1, Math.round(stageW * FX_RES));
    var h = Math.max(1, Math.round(stageH * FX_RES));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    c.style.width = stageW + 'px';
    c.style.height = stageH + 'px';
  }
  function sizeAllFxCanvases() {
    for (var i = 0; i < particleSystems.length; i++) {
      if (particleSystems[i].fx) sizeFxCanvas(particleSystems[i].fx);
    }
  }

  /** Soft round sparkle texture, built once per colour and reused. */
  var sparkCache = Object.create(null);
  function sparkTex(colorStr) {
    var t = sparkCache[colorStr];
    if (t) return t;
    var R = 32;
    t = document.createElement('canvas');
    t.width = t.height = R * 2;
    var c = t.getContext('2d');
    var g = c.createRadialGradient(R, R, 0, R, R, R);
    var clear = colorStr.replace(/^rgba?\(([^)]*?)(,\s*[\d.]+)?\)$/, function (m, rgb) {
      return 'rgba(' + rgb.split(',').slice(0, 3).join(',') + ',0)';
    });
    g.addColorStop(0, colorStr);
    g.addColorStop(0.3, colorStr);
    g.addColorStop(1, clear);
    c.fillStyle = g;
    c.beginPath(); c.arc(R, R, R, 0, Math.PI * 2); c.fill();
    sparkCache[colorStr] = t;
    return t;
  }

  /** Accumulated lossy-scale used for particle magnitudes (Unity scalingMode). */
  function particleScale(rec) {
    var ps = rec.particles;
    if (ps.scalingMode === 1) return Math.abs((rec.scale || [1])[0]) || 1;  // Local
    var s = 1, n = rec;
    while (n && !n.isRootCanvas) { s *= Math.abs((n.scale || [1])[0]) || 1; n = n.parent; }
    return s || 1;
  }

  function stepParticles(dt) {
    for (var i = 0; i < particleSystems.length; i++) {
      var rec = particleSystems[i];
      var ps = rec.particles;
      var live = isActiveInHierarchy(rec.id);
      if (!live) {
        if (rec._pool) rec._pool = null;
        releaseFxCanvas(rec);
        releaseAmbientField(rec);
        continue;
      }
      // Always-on looping emitters are ambient decoration, never simulated.
      // Backdrop ones become a CSS sparkle field (built once, zero per-frame
      // cost); ones nested inside a scaled object -- the key's glow aura -- are
      // dropped entirely and that object is styled directly in CSS, because the
      // effect layer sits outside its transform and its offsets landed in the
      // wrong place (a stray blob beside the key).
      if (ps.looping && ps.playOnAwake) {
        if (rec.parent && rec.parent.isRootCanvas) ensureAmbientField(rec);
        else releaseFxCanvas(rec);
        continue;
      }
      var playing = ps.playOnAwake || rec._playing;
      if (!playing && !(rec._pool && rec._pool.length)) { releaseFxCanvas(rec); continue; }

      var ctx = rec.fxCtx || (ensureFxCanvas(rec), rec.fxCtx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, rec.fx.width, rec.fx.height);
      ctx.setTransform(FX_RES, 0, 0, FX_RES, 0, 0);   // draw in stage units
      if (!rec._pool) { rec._pool = []; rec._acc = 0; rec._t = 0; }
      rec._t += dt;

      var c = centerOf(rec.id);
      var sc = particleScale(rec);
      var cap = Math.min(ps.maxParticles || 60, 120);
      // rateOverTime 0 means "bursts only" in Unity -- honour it instead of
      // substituting a default, which made one-shot bursts emit forever.
      var rate = ps.rateOverTime != null ? ps.rateOverTime : 10;
      var over = !ps.looping && ps.duration != null && rec._t > ps.duration;

      if (playing && !over) {
        if (rate > 0) {
          rec._acc += rate * dt;
          while (rec._acc >= 1 && rec._pool.length < cap) {
            rec._acc -= 1;
            rec._pool.push(spawnParticle(ps, c, sc));
          }
        } else if (!rec._burst) {
          // a single burst, which is what a rate-0 non-looping system is
          rec._burst = true;
          for (var b = 0; b < cap; b++) rec._pool.push(spawnParticle(ps, c, sc));
        }
      }

      for (var j = rec._pool.length - 1; j >= 0; j--) {
        var p = rec._pool[j];
        p.age += dt;
        if (p.age >= p.life) {
          if (ps.looping && playing) rec._pool[j] = spawnParticle(ps, c, sc);
          else rec._pool.splice(j, 1);
          continue;
        }
        p.vy += (ps.gravity || 0) * 9.81 * dt * 20 * sc;
        p.x += p.vx * dt; p.y += p.vy * dt;
        var k = p.age / p.life;
        // fade in AND out over the lifetime: a star that pops in at full
        // brightness reads as a blob, one that swells and fades twinkles
        var a = (ps.colorOverLifetime ? Math.sin(Math.PI * k) : 1) * p.a;
        var sz = Math.max(0.5, p.size * (0.65 + 0.35 * Math.sin(Math.PI * k)));
        ctx.globalAlpha = clamp01(a);
        // one cached soft-sparkle texture, blitted -- building a radial
        // gradient per particle per frame cost ~60% of the frame budget
        var tex = sparkTex(p.col);
        ctx.drawImage(tex, p.x - sz, p.y - sz, sz * 2, sz * 2);
      }
      ctx.globalAlpha = 1;
      // a finished one-shot stops itself instead of looping forever
      if (!ps.looping && over && !rec._pool.length) {
        rec._playing = false; rec._pool = null; rec._burst = false;
      }
    }
  }
  function spawnParticle(ps, c, sc) {
    var ang = Math.random() * Math.PI * 2;
    var spd = (ps.startSpeed || 0) * (0.5 + Math.random()) * sc;
    var col = ps.startColor || [1, 1, 1, 1];
    var ox, oy;
    if (ps.shapeType === 5 && ps.shapeScale) {
      // Unity Box shape. These emitters are authored as a floor plane, so the
      // screen axes are the box's X and Z (17.99 x 9.06 -> ~1799 x 906 px at
      // this scale, i.e. the whole backdrop). Using Y gave a thin centre band.
      var sx = ps.shapeScale[0] || 1;
      var sy = ps.shapeScale[2] || ps.shapeScale[1] || 1;
      ox = (Math.random() - 0.5) * sx * sc;
      oy = (Math.random() - 0.5) * sy * sc;
    } else {                                            // Sphere / cone / edge
      var rad = (ps.shapeRadius || 0.5) * sc * Math.sqrt(Math.random());
      ox = Math.cos(ang) * rad; oy = Math.sin(ang) * rad;
    }
    return {
      x: c[0] + ox, y: c[1] + oy,
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      life: Math.max(0.2, (ps.startLifetime || 1) * (0.6 + Math.random() * 0.6)),
      age: 0,
      // startSize is a diameter; a quarter of it keeps sparkles sparkle-sized
      size: Math.max(1.5, (ps.startSize || 1) * sc * 0.25),
      col: css([col[0], col[1], col[2]]),
      colClear: css([col[0], col[1], col[2], 0]),
      a: col.length > 3 ? col[3] : 1
    };
  }
  function playParticles(id) {
    var r = get(id); if (!r || !r.particles) return;
    r._playing = true; r._pool = null; r._burst = false; r._t = 0;
  }
  function stopParticles(id) {
    var r = get(id); if (!r) return;
    r._playing = false; r._pool = null; r._burst = false;
    releaseFxCanvas(r);
  }

  // ------------------------------------------------- controller lifecycle
  // Unity order: Awake -> OnEnable -> Start (first time active) -> Update.
  var registry = [];   // {hostId, def}
  function register(hostId, def) {
    registry.push({ hostId: String(hostId), def: def, started: false, enabled: false });
  }
  function tickControllers() {
    for (var i = 0; i < registry.length; i++) {
      var e = registry[i];
      var live = isActiveInHierarchy(e.hostId);
      if (live && !e.enabled) {
        e.enabled = true;
        if (e.def.onEnable) { try { e.def.onEnable(); } catch (x) { logErr(x); } }
        if (!e.started) {
          e.started = true;
          if (e.def.start) { try { e.def.start(); } catch (x) { logErr(x); } }
        }
      } else if (!live && e.enabled) {
        e.enabled = false;
        if (e.def.onDisable) { try { e.def.onDisable(); } catch (x) { logErr(x); } }
      }
    }
  }
  function awakeAll() {
    for (var i = 0; i < registry.length; i++) {
      var e = registry[i];
      // Unity runs Awake only for objects active in the hierarchy at load
      if (isActiveInHierarchy(e.hostId) && e.def.awake) {
        try { e.def.awake(); } catch (x) { logErr(x); }
      }
    }
  }
  function controllerStarted(hostId) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].hostId === String(hostId)) return registry[i].started;
    }
    return false;
  }

  // ---------------------------------------------------------- diagnostics
  function dump() {
    return {
      nodeCount: order.length,
      canvasScale: canvasScale, stageW: stageW, stageH: stageH,
      pendingTasks: TaskGroup.pending(),
      audio: audioState(),
      controllers: registry.map(function (e) {
        return { host: e.hostId, started: e.started, enabled: e.enabled };
      })
    };
  }

  return {
    boot: boot, get: get, byName: byName, nodes: function () { return nodes; },
    order: function () { return order; },
    setActive: setActive, isActiveSelf: isActiveSelf, childByName: childByName,
    isActiveInHierarchy: isActiveInHierarchy, onActivated: onActivated,
    setSprite: setSprite, setImageColor: setImageColor,
    setText: setText, getText: getText, setTextColor: setTextColor,
    setAlpha: setAlpha, setScale: setScale, getScale: getScale, baseScale: baseScale,
    raise: raise,
    setRotZ: setRotZ, getRotZ: getRotZ,
    setAnchoredPos: setAnchoredPos, getAnchoredPos: getAnchoredPos,
    setPixelOffset: setPixelOffset,
    setInteractable: setInteractable,
    isInteractable: isInteractable, centerOf: centerOf,
    onClick: onClick, setPersistentClick: setPersistentClick,
    addClick: addClick, clearClicks: clearClicks,
    TaskGroup: TaskGroup, ease: ease, easings: E,
    play: play, playOneShot: playOneShot, stopChannel: stopChannel,
    stopAllAudio: stopAllAudio, audioState: audioState,
    isAudioUnlocked: isAudioUnlocked,
    audioDuration: audioDuration, preload: preload, spritePaths: spritePaths,
    unlockAudio: unlockAudio,
    onTick: onTick, onResize: function (f) { resizeHooks.push(f); },
    relayout: function () { layoutTree(); },
    layoutGrid: function (id) { var r = get(id); if (r && r.grid) layoutGrid(r); },
    playParticles: playParticles, stopParticles: stopParticles,
    register: register, awakeAll: awakeAll, tickControllers: tickControllers,
    controllerStarted: controllerStarted,
    setInputLocked: setInputLocked, isInputLocked: isInputLocked,
    pointerState: function () { return pointerState; },
    setPaused: setPaused, isPaused: isPaused,
    cssColor: css, dump: dump,
    scale: function () { return canvasScale; },
    stageSize: function () { return [stageW, stageH]; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
