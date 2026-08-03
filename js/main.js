/* main.js -- LBD-3 boot + scene flow (Main.unity -> LBD_3.unity) */
'use strict';

(function () {
  var E = Engine, C = window.CONFIG;

  // Unity loads Main.unity first; SplashScreenLoader then LoadSceneAsync's the
  // gameplay scene in Single mode. Both trees are built up front so no fetch()
  // is needed, and the gameplay tree is held inactive until "loaded".
  var splashRoots = window.SPLASH_LAYOUT;
  var playRoots = window.LAYOUT;

  var nodes = E.boot(splashRoots.concat(playRoots), C);

  // ---- remember and suppress the gameplay scene ---------------------------
  var playRootState = playRoots.map(function (r) {
    return { id: String(r.id), active: !!r.active };
  });
  playRootState.forEach(function (s) { E.setActive(s.id, false); });

  // ---- bind every Button's scene-wired onClick list, in scene order -------
  function bindButtons(roots) {
    (roots || []).forEach(function walk(n) {
      (n.components || []).forEach(function (c) {
        if (c.kind !== 'Button') return;
        var calls = (c.onClick || []).filter(function (cl) {
          return cl.callState !== 0;      // 0 = Off
        });
        if (!calls.length) return;
        E.onClick(String(n.id), function () {
          for (var i = 0; i < calls.length; i++) Game.invokeEvent(calls[i]);
        });
      });
      (n.children || []).forEach(walk);
    });
  }

  // ---- AudioSource playOnAwake for a freshly activated scene -------------
  function playAwakeAudio(roots) {
    (roots || []).forEach(function walk(n) {
      var id = String(n.id);
      var s = Game.srcOf[id];
      if (s && s.playOnAwake && s.clip && E.isActiveInHierarchy(id)) {
        Game.srcPlayOwn(id);
      }
      (n.children || []).forEach(walk);
    });
  }

  // ---- splash scene -------------------------------------------------------
  // The splash Button's own serialized onClick already calls LoadNextScene, so
  // bindButtons wires it. Registering it a second time here made one tap run
  // the transition twice. Audio unlocks on the first pointerdown in the engine.
  var splashCfg = Game.script('SplashScreenLoader', C.splashScripts);
  if (splashCfg) Game.splash = Game.SplashScreenLoader(splashCfg, loadGameplay);
  bindButtons(splashRoots);

  // ---- gameplay scene -----------------------------------------------------
  var loaded = false;
  function loadGameplay() {
    if (loaded) return;
    loaded = true;

    // SceneManager.LoadScene(Single) unloads Main.unity
    splashRoots.forEach(function (r) { E.setActive(String(r.id), false); });
    playRootState.forEach(function (s) { E.setActive(s.id, s.active); });
    E.relayout();

    // ---- Awake ----------------------------------------------------------
    // TutorialDialogue.Awake sets the static `instance`; only the copy that is
    // active in the hierarchy runs, so the dead one on /GameObject is skipped.
    var tdCfg = Game.liveScript('TutorialDialogue');
    Game.tutorial = new Game.TutorialDialogue(tdCfg);

    var gmCfg = Game.script('GameManager');
    Game.gameManager = new Game.GameManager(gmCfg);

    Game.scriptsOf('PlateItem').forEach(function (cfg) {
      var p = new Game.PlateItem(cfg);
      Game.plateByHost[p.host] = p;
      Game.plateByComp[String(cfg.__id)] = p;
      if (cfg.button && cfg.button.__ref) {
        Game.plateByComp[String(cfg.button.__ref)] = p;
      }
    });

    Game.scriptsOf('GridLayoutManager').forEach(function (cfg) {
      Game.GridLayoutManager(cfg);
    });
    Game.scriptsOf('JumpAndScaleUI').forEach(function (cfg) {
      E.register(Game.go(cfg.__host), Game.JumpAndScaleUI(cfg));
    });
    Game.scriptsOf('TypewriterEffect').forEach(function (cfg) {
      E.register(Game.go(cfg.__host), Game.TypewriterEffect(cfg));
    });

    // GameManager.Start / TutorialDialogue.Start
    E.register(Game.go(gmCfg.__host), { start: Game.gameManager.start });
    E.register(Game.go(tdCfg.__host), { start: Game.tutorial.start });

    bindButtons(playRoots);
    playAwakeAudio(playRoots);

    E.awakeAll();
    E.tickControllers();
    E.onActivated(function () { E.tickControllers(); });
  }

  // expose for the automated test harness
  window.__game = {
    engine: E,
    game: Game,
    loadGameplay: loadGameplay,
    isLoaded: function () { return loaded; },
    analytics: Analytics
  };

  // Warm every sprite as well as every clip, so the gameplay tree has nothing
  // left to fetch when the splash fade hands over -- otherwise tray art can
  // pop in a frame late and shift the layout. Resolves once all assets have
  // settled (loaded or failed), which is the loading-complete condition.
  var assets = [].concat(
    Object.keys(Game.srcOf).map(function (k) { return Game.srcOf[k].clip; }),
    E.spritePaths(splashRoots),
    E.spritePaths(playRoots)
  ).filter(Boolean);

  window.__game.assetsReady = E.preload(assets).then(function (r) {
    if (r.failed && r.failed.length && console && console.warn) {
      console.warn('[assets] failed to load:', r.failed.join(', '));
    }
    return r;
  });
})();
