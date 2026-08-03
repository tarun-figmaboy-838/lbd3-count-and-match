/* ==========================================================================
 * god-mode.js -- hidden QA / design-review layer for "Matching Trays"
 *
 * Opens with Shift + G. There is deliberately no visible button, no
 * hint in the player UI, and no way to reach it from normal gameplay.
 *
 * Isolation contract
 *   - It drives the game only through Engine / Game public methods.
 *   - Opening it locks interaction and pauses tweens + audio, so the state it
 *     shows you is the state you inspect; closing it restores exactly that.
 *   - Layout edits are inline-style overrides held in memory (optionally in
 *     localStorage). Closing God Mode reverts every one of them: nothing is
 *     ever written to the real stylesheet -- you copy values out by hand.
 *   - Listeners are registered once, guarded by window.__godModeLoaded.
 *   - Set window.GOD_MODE_ENABLED = false (or drop the two tags from
 *     index.html) to strip it from a production build.
 * ======================================================================== */
'use strict';

(function () {

  // -------------------------------------------------- environment gate
  if (window.__godModeLoaded) return;                 // register exactly once
  if (window.GOD_MODE_ENABLED === false) return;
  window.__godModeLoaded = true;

  var KEY_STORE = 'lbd3GodLayout';
  var E = null, G = null;                             // engine + game facades
  var on = false, panel = null, root = null, badge = null, guides = null;
  var selBox = null, selected = null, picking = false, locked = false;
  var edits = Object.create(null);                    // selector -> inline style
  var log = [];                                       // state / interaction log
  var refreshTimer = null;

  function qs(s, r) { return (r || document).querySelector(s); }
  function el(tag, cls, txt) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (txt != null) d.textContent = txt;
    return d;
  }
  function typing(e) {
    var t = e.target;
    if (!t) return false;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
  }
  function note(kind, msg) {
    log.unshift({ t: new Date().toTimeString().slice(0, 8), kind: kind, msg: msg });
    if (log.length > 200) log.length = 200;
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else fallback();
    function fallback() {
      var t = el('textarea');
      t.value = text;
      t.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch (e) { }
      document.body.removeChild(t);
    }
    note('copy', text.split('\n')[0].slice(0, 60));
  }

  /* =====================================================  stage geometry */
  // Everything is reported in the 1920x1080 design space, so a value you copy
  // pastes straight into data.js / the stylesheet regardless of zoom.
  function stageEl() { return qs('#stage'); }
  function stageScale() { return (E && E.scale && E.scale()) || 1; }
  function stageRect(node) {
    var b = node.getBoundingClientRect(), s = stageScale();
    var sb = stageEl().getBoundingClientRect();
    return {
      x: (b.left - sb.left) / s, y: (b.top - sb.top) / s,
      w: b.width / s, h: b.height / s
    };
  }
  function r1(v) { return Math.round(v * 10) / 10; }

  /* =====================================================  game state name */
  function screenName() {
    if (!G || !window.__game.isLoaded()) return 'splash';
    var gm = G.gameManager, td = G.tutorial;
    if (!gm || !td) return 'booting';
    if (E.isActiveInHierarchy(gm.key)) return 'complete:key';
    if (gm.isSelectGame) return 'question:answered';
    if (E.isActiveInHierarchy(td.incorrectTextobject)) return 'feedback:wrong';
    if (gm.noOfMatchSucced >= 2) return 'question:yesno';
    if (gm._resolving) return 'resolving';
    if (gm.clickedPlates.length === 2) return 'gameplay:check';
    if (gm.clickedPlates.length === 1) return 'gameplay:one-picked';
    return 'gameplay:round' + (gm.noOfMatchSucced + 1);
  }
  var lastScreen = '';
  function watchScreen() {
    var s = screenName();
    if (s !== lastScreen) { note('state', lastScreen + ' -> ' + s); lastScreen = s; }
  }

  /* =====================================================  screen jumps */
  // Implemented with the game's own public calls -- never by poking the DOM.
  function jump(name) {
    if (!window.__game.isLoaded() && name !== 'splash') {
      G.splash && G.splash.loadNextScene();
      setTimeout(function () { jump(name); }, 700);
      return;
    }
    var gm = G.gameManager, td = G.tutorial;
    note('jump', name);
    switch (name) {
      case 'splash': location.reload(); return;
      case 'intro': td.tutorialIndex = 0; td.messageIndex = 0; td.showNextMessage(); break;
      case 'round1': resetAll(); break;
      case 'round2':
        resetAll();
        autoMatch(0);
        break;
      case 'question':
        resetAll();
        autoMatch(0);
        setTimeout(function () { autoMatch(0); }, 2200);
        break;
      case 'wrong': triggerWrong(); break;
      case 'correct': triggerCorrect(); break;
      case 'retry': gm.onClickTryAgain(); break;
      case 'reward':
      case 'complete':
        // clear the board the way the real flow does, so the jump lands on the
        // actual end state instead of the key floating over a live round
        gm.handStart.cancel();      // else the idle hint still fires afterwards
        gm.handPair.cancel();
        G.hideAllHands();
        E.setActive('931046663', false);      // TrayParent
        E.setActive('1574670127', false);     // Yes/No panel
        ['1748713363', '427234635', '2025194983'].forEach(function (b) {
          E.setActive(b, false);              // check / next / try again
        });
        gm.setIncorrectPanel(false);
        td.tutorialIndex = 2; td.messageIndex = 3; td.showNextMessage();
        break;
    }
    refresh();
  }
  var ORDER = ['splash', 'intro', 'round1', 'round2', 'question', 'complete'];
  function step(dir) {
    var cur = ORDER.indexOf(qs('#godJump').value);
    var i = Math.max(0, Math.min(ORDER.length - 1, (cur < 0 ? 0 : cur) + dir));
    qs('#godJump').value = ORDER[i];
    jump(ORDER[i]);
  }

  /** Pick the first matching pair still on the board and resolve it. */
  function autoMatch(delay) {
    setTimeout(function () {
      var gm = G.gameManager;
      var plates = Object.keys(G.plateByHost).map(function (k) { return G.plateByHost[k]; })
        .filter(function (p) { return E.isActiveSelf(p.host); });
      for (var i = 0; i < plates.length; i++) {
        for (var j = i + 1; j < plates.length; j++) {
          if (plates[i].itemCount === plates[j].itemCount) {
            gm.clickedPlates = [plates[i], plates[j]];
            plates[i].isSelected = plates[j].isSelected = true;
            gm.tryCompare();
            return;
          }
        }
      }
      note('warn', 'no matching pair left to auto-solve');
    }, delay || 0);
  }
  function triggerCorrect() {
    var gm = G.gameManager;
    if (gm.clickedPlates.length === 2) gm.tryCompare(); else autoMatch(0);
  }
  function triggerWrong() {
    var gm = G.gameManager;
    var plates = Object.keys(G.plateByHost).map(function (k) { return G.plateByHost[k]; })
      .filter(function (p) { return E.isActiveSelf(p.host); });
    for (var i = 0; i < plates.length; i++) {
      for (var j = i + 1; j < plates.length; j++) {
        if (plates[i].itemCount !== plates[j].itemCount) {
          gm.clickedPlates = [plates[i], plates[j]];
          plates[i].isSelected = plates[j].isSelected = true;
          gm.tryCompare();
          return;
        }
      }
    }
  }
  function resetAll() {
    note('reset', 'full game state');
    location.reload();
  }
  function restartScreen() {
    var gm = G.gameManager, td = G.tutorial;
    gm.resetAndClearTrayItems();
    Object.keys(G.plateByHost).forEach(function (k) { G.plateByHost[k].resetPlate(); });
    if (gm.checkButton) E.setActive(gm.checkButton, false);
    if (gm.tryAgainButton) E.setActive(gm.tryAgainButton, false);
    gm.setIncorrectPanel(false);
    G.hideAllHands();
    E.stopAllAudio();
    td.messageIndex = 0;
    td.showNextMessage();
    td.setButtonValue(true);
    note('restart', 'current screen');
    refresh();
  }

  /* =====================================================  element picking */
  function nodeLabel(node) {
    return node.dataset.name || node.dataset.id || node.tagName.toLowerCase();
  }
  function selectorFor(node) {
    if (node.dataset.id) return '[data-id="' + node.dataset.id + '"]';
    if (node.dataset.name) return '[data-name="' + node.dataset.name + '"]';
    if (node.id) return '#' + node.id;
    return node.tagName.toLowerCase() +
      (node.className ? '.' + String(node.className).trim().split(/\s+/).join('.') : '');
  }
  function select(node) {
    if (!node || node === selected) { if (!node) hideSel(); return; }
    selected = node;
    drawSel();
    fillInspector();
    note('select', nodeLabel(node));
  }
  function hideSel() {
    selected = null;
    if (selBox) selBox.classList.remove('godLive');
    fillInspector();
  }
  function drawSel() {
    if (!selected || !selBox) return;
    if (!selected.isConnected) { hideSel(); return; }
    var b = selected.getBoundingClientRect();
    selBox.style.left = b.left + 'px';
    selBox.style.top = b.top + 'px';
    selBox.style.width = b.width + 'px';
    selBox.style.height = b.height + 'px';
    selBox.classList.add('godLive');
    var r = stageRect(selected);
    qs('.godTag', selBox).textContent =
      nodeLabel(selected) + '  ' + Math.round(r.w) + '×' + Math.round(r.h);
  }
  function onStagePick(ev) {
    if (!on || !picking) return;
    var t = ev.target;
    if (root.contains(t)) return;
    var node = t.closest('.un');
    if (!node) return;
    ev.preventDefault();
    ev.stopPropagation();
    select(node);
  }

  /* =====================================================  editing */
  function styleOf(node) {
    var rec = E.get(node.dataset.id);
    var cs = getComputedStyle(node);
    var r = stageRect(node);
    return {
      x: r1(r.x), y: r1(r.y), w: r1(r.w), h: r1(r.h),
      scale: rec ? r1((rec.scale || [1])[0]) : 1,
      rot: rec ? r1(rec.rotZ || 0) : 0,
      opacity: r1(parseFloat(cs.opacity)),
      z: cs.zIndex === 'auto' ? 'auto' : cs.zIndex
    };
  }
  function fillInspector() {
    var box = qs('#godInsp');
    if (!box) return;
    if (!selected) { box.innerHTML = '<p class="godHint">Nothing selected. Turn on Pick and click any element.</p>'; return; }
    var s = styleOf(selected), sel = selectorFor(selected);
    var parent = selected.parentElement && selected.parentElement.closest('.un');
    box.innerHTML = '';
    var dl = el('dl', 'godKV');
    [['name', nodeLabel(selected)], ['selector', sel],
     ['parent', parent ? nodeLabel(parent) : '(stage)'],
     ['x / y', s.x + ', ' + s.y], ['w / h', s.w + ' × ' + s.h],
     ['scale', s.scale], ['rotation', s.rot + '°'],
     ['opacity', s.opacity], ['z-index', s.z]
    ].forEach(function (kv) {
      dl.appendChild(el('dt', null, kv[0]));
      dl.appendChild(el('dd', null, String(kv[1])));
    });
    box.appendChild(dl);
  }
  /** Offsets are applied in stage units so a nudge means the same at any zoom. */
  function nudge(dx, dy) {
    if (!selected) return;
    var st = selected.style;
    var cl = parseFloat(st.left || 0) || elLeft(selected);
    var ct = parseFloat(st.top || 0) || elTop(selected);
    st.left = (cl + dx) + 'px';
    st.top = (ct + dy) + 'px';
    remember();
    drawSel(); fillInspector();
  }
  function resize(dw, dh) {
    if (!selected) return;
    var st = selected.style;
    var w = parseFloat(st.width || 0) || selected.getBoundingClientRect().width / stageScale();
    var h = parseFloat(st.height || 0) || selected.getBoundingClientRect().height / stageScale();
    st.width = Math.max(8, w + dw) + 'px';
    st.height = Math.max(8, h + dh) + 'px';
    remember();
    drawSel(); fillInspector();
  }
  function elLeft(n) { var r = E.get(n.dataset.id); return r ? r.left : 0; }
  function elTop(n) { var r = E.get(n.dataset.id); return r ? r.top : 0; }

  function remember() {
    if (!selected) return;
    var sel = selectorFor(selected);
    if (!(sel in edits)) edits[sel] = { orig: selected.getAttribute('style') || '' };
    edits[sel].now = selected.getAttribute('style') || '';
  }
  function resetOne() {
    if (!selected) return;
    var sel = selectorFor(selected);
    if (edits[sel]) {
      selected.setAttribute('style', edits[sel].orig);
      delete edits[sel];
    }
    E.relayout();
    drawSel(); fillInspector();
    note('reset', sel);
  }
  function resetEdits() {
    Object.keys(edits).forEach(function (sel) {
      var n = qs(sel);
      if (n) n.setAttribute('style', edits[sel].orig);
      delete edits[sel];
    });
    E.relayout();
    drawSel(); fillInspector();
    note('reset', 'all layout overrides');
  }
  function cssBlock() {
    if (!selected) return '';
    var s = styleOf(selected);
    return selectorFor(selected) + ' {\n' +
      '  left: ' + s.x + 'px;\n  top: ' + s.y + 'px;\n' +
      '  width: ' + s.w + 'px;\n  height: ' + s.h + 'px;\n' +
      '  opacity: ' + s.opacity + ';\n' +
      (s.z !== 'auto' ? '  z-index: ' + s.z + ';\n' : '') +
      '}  /* stage space, 1920×1080 */';
  }
  function saveTemp() {
    var out = {};
    Object.keys(edits).forEach(function (k) { out[k] = edits[k].now; });
    try { localStorage.setItem(KEY_STORE, JSON.stringify(out)); note('save', Object.keys(out).length + ' overrides'); }
    catch (e) { note('bad', 'localStorage unavailable'); }
    refresh();
  }
  function loadTemp() {
    var raw;
    try { raw = localStorage.getItem(KEY_STORE); } catch (e) { }
    if (!raw) { note('warn', 'no saved overrides'); return refresh(); }
    var o = JSON.parse(raw), n = 0;
    Object.keys(o).forEach(function (sel) {
      var node = qs(sel);
      if (!node) return;
      if (!(sel in edits)) edits[sel] = { orig: node.getAttribute('style') || '' };
      node.setAttribute('style', o[sel]);
      edits[sel].now = o[sel];
      n++;
    });
    note('load', n + ' overrides applied');
    refresh();
  }
  function clearTemp() {
    try { localStorage.removeItem(KEY_STORE); } catch (e) { }
    resetEdits();
  }

  /* =====================================================  automated checks */
  function runChecks() {
    var out = [], pass = 0, fail = 0;
    function ok(m) { out.push('<span class="ok">PASS</span> ' + m); pass++; }
    function bad(m) { out.push('<span class="bad">FAIL</span> ' + m); fail++; }
    function warn(m) { out.push('<span class="warn">WARN</span> ' + m); }

    // 1. duplicate DOM ids / duplicate rendered game objects
    var seen = Object.create(null), dupes = [];
    document.querySelectorAll('[data-id]').forEach(function (n) {
      var k = n.dataset.id;
      if (seen[k]) dupes.push(k); else seen[k] = 1;
    });
    dupes.length ? bad('duplicate data-id nodes: ' + dupes.join(',')) : ok('no duplicate DOM nodes');

    var trays = {};
    document.querySelectorAll('[data-name^="Tray"]').forEach(function (n) {
      if (/^Tray[1-6]$/.test(n.dataset.name)) trays[n.dataset.name] = (trays[n.dataset.name] || 0) + 1;
    });
    var dupTray = Object.keys(trays).filter(function (k) { return trays[k] > 1; });
    dupTray.length ? bad('duplicated trays: ' + dupTray.join(',')) : ok('6 unique trays, none duplicated');

    // 2. exactly one hint hand visible
    var hands = (G.allHands() || []).filter(function (h) { return E.isActiveInHierarchy(h); });
    hands.length > 1 ? bad(hands.length + ' hint hands visible at once') : ok('hint hands visible: ' + hands.length);

    // 3. only one dialogue panel mounted
    var panels = ['859730161', '1364679847'].filter(function (id) { return E.isActiveInHierarchy(id); });
    panels.length > 1 ? bad('both dialogue panels mounted (stacked)') : ok('dialogue panels mounted: ' + panels.length);

    // 4. no voice-over overlap
    var vo = E.audioState().filter(function (a) { return a.channel === 'vo'; });
    vo.length > 1 ? bad('overlapping voice-over: ' + vo.length) : ok('voice-over channels playing: ' + vo.length);

    // 5. missing assets
    var missing = [];
    document.querySelectorAll('.un-img').forEach(function (n) {
      var m = /url\("?([^")]+)"?\)/.exec(n.style.backgroundImage || '');
      if (m && !assetOk(m[1])) missing.push(m[1]);
    });
    missing.length ? bad('images failed to load: ' + missing.join(', ')) : ok('all mounted images loaded');

    // 6. viewport overflow of interactive elements. Measured as the fraction of
    // the element still on screen, because several buttons have a hit box far
    // larger than their artwork -- a slightly clipped box is not a defect, a
    // mostly-clipped one is.
    var over = [];
    document.querySelectorAll('.un-btn:not(.un-off)').forEach(function (n) {
      var b = n.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) return;
      var vw = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0));
      var vh = Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
      var frac = (vw * vh) / (b.width * b.height);
      if (frac < 0.6) over.push(nodeLabel(n) + ' ' + Math.round(frac * 100) + '% visible');
    });
    over.length ? bad('buttons mostly off-screen: ' + over.join(', '))
      : ok('every interactive element substantially on-screen');

    // 7. tap target size (stage space; 80px is the comfortable minimum for kids)
    var small = [];
    document.querySelectorAll('.un-btn:not(.un-off):not(.un-dis)').forEach(function (n) {
      var r = stageRect(n);
      if (r.w > 1 && (r.w < 80 || r.h < 80)) small.push(nodeLabel(n) + ' ' + Math.round(r.w) + 'x' + Math.round(r.h));
    });
    small.length ? warn('tap targets under 80px: ' + small.join(', ')) : ok('all live tap targets >= 80px');

    // 8. timers / tweens left running
    var pend = E.dump().pendingTasks;
    out.push('<span class="warn">INFO</span> pending task groups: ' +
      (pend.length ? pend.map(function (p) { return p.owner; }).join(', ') : 'none'));

    // 9. single initialisation -- the stage must hold exactly the roots the
    // two scene trees declare, no more (a second boot would double them)
    var roots = document.querySelectorAll('#stage > .un').length;
    var want = ((window.SPLASH_LAYOUT || []).length + (window.LAYOUT || []).length);
    roots === want ? ok('scene initialised once (' + roots + '/' + want + ' roots)')
      : bad('expected ' + want + ' scene roots, found ' + roots + ' -- initialised twice?');

    // 10. mechanics invariants
    var gm = G.gameManager;
    if (gm) {
      gm.clickedPlates.length <= 2 ? ok('at most 2 trays picked (' + gm.clickedPlates.length + ')')
        : bad('more than 2 trays picked: ' + gm.clickedPlates.length);
      var pool = G.tutorial.tray_btn.length, live = 0;
      document.querySelectorAll('[data-name^="Tray"]').forEach(function (n) {
        if (/^Tray[1-6]$/.test(n.dataset.name) && !n.classList.contains('un-off')) live++;
      });
      pool + gm.clickedPlates.length === live
        ? ok('tray pool consistent (' + pool + ' free + ' + gm.clickedPlates.length + ' picked = ' + live + ')')
        : warn('tray pool ' + pool + ' + picked ' + gm.clickedPlates.length + ' != visible ' + live);
    }

    out.unshift('<b>' + pass + ' passed, ' + fail + ' failed</b>  (' + screenName() + ')');
    qs('#godCheckOut').innerHTML = out.join('\n');
    note('qa', pass + ' pass / ' + fail + ' fail');
  }
  var assetCache = Object.create(null);
  function assetOk(url) {
    if (url in assetCache) return assetCache[url];
    var i = new Image();
    i.onload = function () { assetCache[url] = true; };
    i.onerror = function () { assetCache[url] = false; };
    i.src = url;
    assetCache[url] = true;         // optimistic until proven otherwise
    return true;
  }

  /* =====================================================  panel build */
  function build() {
    root = el('div');
    root.id = 'godRoot';

    badge = el('div', null, '⚡ GOD MODE');
    badge.id = 'godBadge';

    guides = el('div');
    guides.id = 'godGuides';

    selBox = el('div');
    selBox.id = 'godSel';
    selBox.appendChild(el('span', 'godTag'));

    panel = el('div');
    panel.id = 'godPanel';
    panel.innerHTML =
      '<div id="godHead"><b>God Mode</b><span class="godSpacer"></span>' +
      '<button id="godMinBtn" title="minimise">−</button>' +
      '<button id="godCloseBtn" title="close (Shift+G)">×</button></div>' +
      '<div id="godBody">' +

      '<div class="godSec"><h4>State</h4><dl class="godKV" id="godState"></dl></div>' +

      '<div class="godSec"><h4>Screen &amp; level</h4>' +
      '<div class="godRow"><select id="godJump">' +
      '<option value="splash">splash</option><option value="intro">intro</option>' +
      '<option value="round1">round 1</option><option value="round2">round 2</option>' +
      '<option value="question">yes/no question</option><option value="complete">complete / key</option>' +
      '</select><button class="godBtn" id="godGo">Go</button></div>' +
      '<div class="godRow god3"><button class="godBtn" id="godPrev">‹ Prev</button>' +
      '<button class="godBtn" id="godNext">Next ›</button>' +
      '<button class="godBtn" id="godRestart">Restart</button></div>' +
      '<div class="godRow"><button class="godBtn godDanger" id="godResetGame">Reset whole game</button></div></div>' +

      '<div class="godSec"><h4>Trigger</h4><div class="godRow god3">' +
      '<button class="godBtn" id="godCorrect">Correct</button>' +
      '<button class="godBtn" id="godWrong">Wrong</button>' +
      '<button class="godBtn" id="godRetry">Retry</button>' +
      '<button class="godBtn" id="godReward">Reward</button>' +
      '<button class="godBtn" id="godComplete">Complete</button>' +
      '<button class="godBtn" id="godStopAudio">Stop VO</button></div></div>' +

      '<div class="godSec"><h4>Control</h4><div class="godRow god2">' +
      '<button class="godBtn" id="godPause">Pause VO+anim</button>' +
      '<button class="godBtn" id="godLock">Lock input</button></div>' +
      '<div class="godRow">' +
      '<label class="godChk"><input type="checkbox" id="godCbBounds">Bounds</label>' +
      '<label class="godChk"><input type="checkbox" id="godCbHit">Hitboxes</label>' +
      '<label class="godChk"><input type="checkbox" id="godCbZones">Drop zones</label>' +
      '<label class="godChk"><input type="checkbox" id="godCbCenter">Center lines</label>' +
      '<label class="godChk"><input type="checkbox" id="godCbSafe">Safe area</label>' +
      '<label class="godChk"><input type="checkbox" id="godCbGrid">Grid</label>' +
      '</div></div>' +

      '<div class="godSec"><h4>Inspector</h4>' +
      '<div class="godRow god2"><button class="godBtn" id="godPickBtn">Pick element</button>' +
      '<button class="godBtn" id="godClearSel">Deselect</button></div>' +
      '<div class="godRow"><input type="text" id="godSearch" placeholder="find by id / class / data-name"></div>' +
      '<div id="godInsp"></div>' +
      '<p class="godHint">Drag the frame to move · arrows nudge 1px · shift+arrows 10px · alt+arrows resize</p>' +
      '<div class="godRow god3"><button class="godBtn" id="godCopyVals">Copy values</button>' +
      '<button class="godBtn" id="godCopyCss">Copy CSS</button>' +
      '<button class="godBtn" id="godCopySel">Copy selector</button>' +
      '<button class="godBtn" id="godCopyComputed">Copy computed</button>' +
      '<button class="godBtn" id="godResetOne">Reset one</button>' +
      '<button class="godBtn godDanger" id="godResetAllEdits">Reset all</button></div>' +
      '<div class="godRow god3"><button class="godBtn" id="godSaveTemp">Save temp</button>' +
      '<button class="godBtn" id="godLoadTemp">Load temp</button>' +
      '<button class="godBtn" id="godClearTemp">Clear temp</button></div></div>' +

      '<div class="godSec"><h4>Runtime</h4><div id="godRuntime" class="godOut"></div></div>' +

      '<div class="godSec"><h4>Automated checks</h4>' +
      '<div class="godRow god2"><button class="godBtn" id="godRunChecks">Run checks</button>' +
      '<button class="godBtn" id="godCopyReport">Copy report</button></div>' +
      '<div id="godCheckOut" class="godOut">Not run yet.</div></div>' +

      '<div class="godSec"><h4>Event log</h4><div id="godLog" class="godOut"></div></div>' +
      '</div>';

    root.appendChild(panel);
    root.appendChild(selBox);
    document.body.appendChild(guides);
    document.body.appendChild(badge);
    document.body.appendChild(root);

    wire();
    drawGuides();
  }

  function drawGuides() {
    var s = stageScale();
    var sb = stageEl().getBoundingClientRect();
    guides.innerHTML = '';
    var svgns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgns, 'svg');
    svg.setAttribute('width', innerWidth);
    svg.setAttribute('height', innerHeight);
    svg.style.cssText = 'position:absolute;inset:0';
    function line(x1, y1, x2, y2, col, dash) {
      var l = document.createElementNS(svgns, 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('stroke', col);
      l.setAttribute('stroke-width', '1');
      if (dash) l.setAttribute('stroke-dasharray', dash);
      svg.appendChild(l);
    }
    if (document.body.classList.contains('godGrid')) {
      for (var gx = 0; gx <= 1920; gx += 120) {
        line(sb.left + gx * s, sb.top, sb.left + gx * s, sb.top + 1080 * s, 'rgba(124,170,200,.16)');
      }
      for (var gy = 0; gy <= 1080; gy += 120) {
        line(sb.left, sb.top + gy * s, sb.left + 1920 * s, sb.top + gy * s, 'rgba(124,170,200,.16)');
      }
    }
    if (document.body.classList.contains('godCenter')) {
      line(sb.left + 960 * s, sb.top, sb.left + 960 * s, sb.top + 1080 * s, 'rgba(255,111,216,.85)', '6 5');
      line(sb.left, sb.top + 540 * s, sb.left + 1920 * s, sb.top + 540 * s, 'rgba(255,111,216,.85)', '6 5');
    }
    if (document.body.classList.contains('godSafe')) {
      var r = document.createElementNS(svgns, 'rect');
      r.setAttribute('x', sb.left + 96 * s); r.setAttribute('y', sb.top + 54 * s);
      r.setAttribute('width', 1728 * s); r.setAttribute('height', 972 * s);
      r.setAttribute('fill', 'none'); r.setAttribute('stroke', 'rgba(61,245,196,.8)');
      r.setAttribute('stroke-dasharray', '10 6');
      svg.appendChild(r);
    }
    guides.appendChild(svg);
  }

  function wire() {
    var b = function (id, fn) { var n = qs('#' + id); if (n) n.addEventListener('click', fn); };

    b('godCloseBtn', function () { toggle(false); });
    b('godMinBtn', function () { panel.classList.toggle('godMin'); });

    b('godGo', function () { jump(qs('#godJump').value); });
    b('godPrev', function () { step(-1); });
    b('godNext', function () { step(1); });
    b('godRestart', restartScreen);
    b('godResetGame', function () {
      try { localStorage.removeItem(KEY_STORE); } catch (e) { }
      resetAll();
    });

    b('godCorrect', triggerCorrect);
    b('godWrong', triggerWrong);
    b('godRetry', function () { G.gameManager.onClickTryAgain(); refresh(); });
    b('godReward', function () { jump('reward'); });
    b('godComplete', function () { jump('complete'); });
    b('godStopAudio', function () { E.stopAllAudio(); note('audio', 'all channels stopped'); });

    b('godPause', function () {
      E.setPaused(!E.isPaused());
      document.body.classList.toggle('godPauseAnim', E.isPaused());
      this.classList.toggle('godOn', E.isPaused());
      note('pause', String(E.isPaused()));
    });
    b('godLock', function () {
      locked = !locked;
      E.setInputLocked(locked);
      this.classList.toggle('godOn', locked);
      note('lock', String(locked));
    });

    [['godCbBounds', 'godBounds'], ['godCbHit', 'godHit'], ['godCbZones', 'godZones'],
     ['godCbCenter', 'godCenter'], ['godCbSafe', 'godSafe'], ['godCbGrid', 'godGrid']
    ].forEach(function (pair) {
      var n = qs('#' + pair[0]);
      if (!n) return;
      n.addEventListener('change', function () {
        document.body.classList.toggle(pair[1], n.checked);
        drawGuides();
      });
    });

    b('godPickBtn', function () {
      picking = !picking;
      document.body.classList.toggle('godPick', picking);
      this.classList.toggle('godOn', picking);
    });
    b('godClearSel', hideSel);
    b('godCopyVals', function () {
      if (!selected) return;
      var s = styleOf(selected);
      copy([nodeLabel(selected), selectorFor(selected),
        'x: ' + s.x, 'y: ' + s.y, 'width: ' + s.w, 'height: ' + s.h,
        'scale: ' + s.scale, 'rotation: ' + s.rot, 'opacity: ' + s.opacity,
        'z-index: ' + s.z, '(stage space 1920x1080)'].join('\n'));
    });
    b('godCopyCss', function () { if (selected) copy(cssBlock()); });
    b('godCopySel', function () { if (selected) copy(selectorFor(selected)); });
    b('godCopyComputed', function () {
      if (!selected) return;
      var cs = getComputedStyle(selected), out = [selectorFor(selected) + ' {'];
      ['left', 'top', 'width', 'height', 'transform', 'transform-origin', 'opacity',
       'z-index', 'display', 'background-image', 'filter'].forEach(function (p) {
        out.push('  ' + p + ': ' + cs.getPropertyValue(p) + ';');
      });
      out.push('}');
      copy(out.join('\n'));
    });
    b('godResetOne', resetOne);
    b('godResetAllEdits', resetEdits);
    b('godSaveTemp', saveTemp);
    b('godLoadTemp', loadTemp);
    b('godClearTemp', clearTemp);

    b('godRunChecks', runChecks);
    b('godCopyReport', function () {
      copy('Matching Trays QA report  ' + new Date().toISOString() + '\nscreen: ' +
        screenName() + '\n\n' + (qs('#godCheckOut').textContent || ''));
    });

    var search = qs('#godSearch');
    if (search) {
      search.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        var q = search.value.trim();
        if (!q) return;
        var node = null;
        try { node = qs(q); } catch (e) { }
        if (!node) node = qs('[data-name="' + q + '"]') || qs('[data-id="' + q + '"]') ||
          qs('#' + q) || qs('.' + q);
        if (node) { select(node); document.body.classList.add('godMark'); node.classList.add('godMark'); setTimeout(function () { node.classList.remove('godMark'); document.body.classList.remove('godMark'); }, 1200); }
        else note('warn', 'no element matches "' + q + '"');
        refresh();
      });
    }

    dragPanel();
    dragSelection();
  }

  function dragPanel() {
    var head = qs('#godHead'), sx = 0, sy = 0, ox = 0, oy = 0, live = false;
    head.addEventListener('pointerdown', function (ev) {
      if (ev.target.tagName === 'BUTTON') return;
      live = true;
      head.classList.add('godDragging');
      sx = ev.clientX; sy = ev.clientY;
      var b = panel.getBoundingClientRect();
      ox = b.left; oy = b.top;
      head.setPointerCapture(ev.pointerId);
    });
    head.addEventListener('pointermove', function (ev) {
      if (!live) return;
      // clamped so the panel can never be dragged fully off-screen
      var x = Math.min(innerWidth - 60, Math.max(-panel.offsetWidth + 80, ox + ev.clientX - sx));
      var y = Math.min(innerHeight - 30, Math.max(0, oy + ev.clientY - sy));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      head.addEventListener(t, function () { live = false; head.classList.remove('godDragging'); });
    });
  }

  /** Figma-style drag of the selected element, in stage units. */
  function dragSelection() {
    var live = false, sx = 0, sy = 0, bl = 0, bt = 0;
    selBox.addEventListener('pointerdown', function (ev) {
      if (!selected) return;
      live = true;
      sx = ev.clientX; sy = ev.clientY;
      bl = parseFloat(selected.style.left || 0) || elLeft(selected);
      bt = parseFloat(selected.style.top || 0) || elTop(selected);
      selBox.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    selBox.addEventListener('pointermove', function (ev) {
      if (!live || !selected) return;
      var s = stageScale();
      var dx = (ev.clientX - sx) / s, dy = (ev.clientY - sy) / s;
      if (ev.shiftKey) { dx = Math.round(dx / 10) * 10; dy = Math.round(dy / 10) * 10; }
      selected.style.left = (bl + dx) + 'px';
      selected.style.top = (bt + dy) + 'px';
      drawSel();
    });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      selBox.addEventListener(t, function () {
        if (!live) return;
        live = false; remember(); fillInspector();
      });
    });
    selBox.style.pointerEvents = 'auto';
  }

  /* =====================================================  live readouts */
  function refresh() {
    if (!on) return;
    watchScreen();
    var gm = G && G.gameManager, td = G && G.tutorial;
    var st = qs('#godState');
    if (st) {
      st.innerHTML = '';
      var rows = [['screen', screenName()],
        ['loaded', String(window.__game.isLoaded())],
        ['tutorial', td ? td.tutorialIndex + ' / msg ' + td.messageIndex : '-'],
        ['matches', gm ? gm.noOfMatchSucced : '-'],
        ['picked', gm ? gm.clickedPlates.length : '-'],
        ['tray pool', td ? td.tray_btn.length : '-'],
        ['typing', td ? String(td.isTyping) : '-'],
        ['resolving', gm ? String(!!gm._resolving) : '-'],
        ['overrides', String(Object.keys(edits).length)]];
      rows.forEach(function (kv) {
        st.appendChild(el('dt', null, kv[0]));
        st.appendChild(el('dd', null, String(kv[1])));
      });
    }
    var rt = qs('#godRuntime');
    if (rt) {
      var audio = E.audioState();
      var ps = E.pointerState();
      rt.innerHTML =
        'audio    : ' + (audio.length ? audio.map(function (a) {
          return a.channel + ' ' + a.src + ' ' + a.t + '/' + (a.dur || '?') + 's' + (a.loop ? ' loop' : '');
        }).join('\n           ') : 'silent') +
        '\nsfx      : ' + (window.Sfx ? window.Sfx.state() : 'n/a') +
        '\ntimers   : ' + (E.dump().pendingTasks.map(function (p) {
          return p.owner + '(' + p.timers + 't/' + p.tweens + 'w)';
        }).join(' ') || 'none') +
        '\npointer  : ' + (ps.active ? 'down on ' + ps.target : 'up') +
        '\nanimating: ' + document.getAnimations().length + ' css, paused=' + E.isPaused() +
        '\ninput    : ' + (E.isInputLocked() ? 'LOCKED' : 'live') +
        '\nsparks   : ' + document.querySelectorAll('.un-spark').length +
        ' | fx canvases: ' + document.querySelectorAll('canvas.un-fx').length +
        '\nnodes    : ' + document.querySelectorAll('.un').length;
    }
    var lg = qs('#godLog');
    if (lg) {
      lg.innerHTML = log.slice(0, 26).map(function (e) {
        var cls = e.kind === 'bad' ? 'bad' : (e.kind === 'warn' ? 'warn' : 'ok');
        return '<span class="' + cls + '">' + e.t + ' ' + e.kind + '</span> ' + e.msg;
      }).join('\n');
    }
    drawSel();
  }

  /* =====================================================  toggle */
  function toggle(want) {
    var next = (want == null) ? !on : !!want;
    if (next === on) return;
    on = next;
    document.body.classList.toggle('godMode', on);

    if (on) {
      if (!panel) build();
      // opening freezes the moment being inspected, and locks input so a
      // stray click on the stage cannot advance the game underneath you
      E.setPaused(true);
      E.setInputLocked(true);
      locked = true;
      document.body.classList.add('godPauseAnim');
      var pb = qs('#godPause'), lb = qs('#godLock');
      if (pb) pb.classList.add('godOn');
      if (lb) lb.classList.add('godOn');
      note('godmode', 'opened');
      refresh();
      refreshTimer = setInterval(refresh, 400);
    } else {
      // closing is a full teardown: the learner build is restored exactly
      clearInterval(refreshTimer); refreshTimer = null;
      resetEdits();
      hideSel();
      picking = false; locked = false;
      E.setPaused(false);
      E.setInputLocked(false);
      ['godPick', 'godBounds', 'godHit', 'godZones', 'godCenter', 'godSafe',
       'godGrid', 'godPauseAnim', 'godMark'].forEach(function (c) {
        document.body.classList.remove(c);
      });
      if (panel) {
        panel.querySelectorAll('input[type=checkbox]').forEach(function (c) { c.checked = false; });
        panel.querySelectorAll('.godOn').forEach(function (c) { c.classList.remove('godOn'); });
      }
      document.querySelectorAll('.godMark').forEach(function (n) { n.classList.remove('godMark'); });
    }
  }

  /* =====================================================  key handling */
  function onKey(ev) {
    // Typing always wins, so a capital G in the search field cannot close the
    // panel out from under you.
    if (typing(ev)) return;
    // Shift+G (Ctrl+Shift+G also accepted). Never a bare key, and the game
    // itself reads no keyboard input at all, so gameplay cannot open it.
    if (ev.shiftKey && !ev.altKey && (ev.key === 'G' || ev.key === 'g')) {
      ev.preventDefault();
      toggle();
      return;
    }
    if (!on) return;
    var big = ev.shiftKey ? 10 : 1;
    switch (ev.key) {
      case 'ArrowLeft':  ev.preventDefault(); ev.altKey ? resize(-big, 0) : nudge(-big, 0); break;
      case 'ArrowRight': ev.preventDefault(); ev.altKey ? resize(big, 0) : nudge(big, 0); break;
      case 'ArrowUp':    ev.preventDefault(); ev.altKey ? resize(0, -big) : nudge(0, -big); break;
      case 'ArrowDown':  ev.preventDefault(); ev.altKey ? resize(0, big) : nudge(0, big); break;
      case 'Escape':     hideSel(); break;
      default:
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'c' && selected) {
          ev.preventDefault(); copy(cssBlock());
        }
    }
  }

  /* =====================================================  boot */
  function boot() {
    var g = window.__game;
    if (!g || !g.engine) {
      if (window.console) console.warn('[god-mode] no game instance; not starting');
      return;
    }
    E = g.engine; G = g.game;
    lastScreen = screenName();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onStagePick, true);
    window.addEventListener('resize', function () { if (on) { drawGuides(); drawSel(); } });
    window.GodMode = {
      open: function () { toggle(true); },
      close: function () { toggle(false); },
      isOpen: function () { return on; },
      runChecks: function () { if (!on) toggle(true); runChecks(); return qs('#godCheckOut').textContent; },
      screen: screenName,
      jump: jump,
      log: function () { return log.slice(); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else boot();
})();
