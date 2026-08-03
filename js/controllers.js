/* ==========================================================================
 * controllers.js -- LBD-3 "Matching Trays"
 *
 * One function per Unity MonoBehaviour, ported line-by-line from:
 *   Assets/Scripts/GameManager.cs        Assets/Scripts/PlateItem.cs
 *   Assets/Scripts/TutorialDialogue.cs   Assets/Scripts/GridLayoutManager.cs
 *   Assets/Scripts/JumpAndScaleUI.cs     Assets/Scripts/TypewriterEffect.cs
 *   Assets/Scripts/SplashScreenLoader.cs Assets/Scripts/WebGLFocusHandler.cs
 *
 * Button behaviour comes from the scene's UnityEvent wiring, NOT from the C#
 * -- PlateItem.OnClicked()'s call to GameManager.OnPlateClicked() is commented
 * out in the source, and the scene supplies it instead. Each tray fires four
 * listeners, in this exact order:
 *     0 TutorialDialogue.OnTrayButtonClicked(thisButton)
 *     1 PlateItem.OnClicked()
 *     2 TutorialDialogue.playaudio(1)
 *     3 GameManager.OnPlateClicked(thisPlate)
 * ======================================================================== */
'use strict';

var Game = (function () {
  var E = Engine, C = window.CONFIG;
  var S = (typeof Sfx !== 'undefined') ? Sfx : { play: function () { } };

  // ------------------------------------------------------------- ref helpers
  var compHost = Object.create(null);   // component fileID -> GameObject id
  var trHost = Object.create(null);   // transform fileID  -> GameObject id

  function indexLayout(roots) {
    (roots || []).forEach(function walk(n) {
      if (n.trId) trHost[String(n.trId)] = String(n.id);
      (n.components || []).forEach(function (c) {
        if (c.id != null) compHost[String(c.id)] = String(n.id);
      });
      (n.children || []).forEach(walk);
    });
  }
  indexLayout(window.LAYOUT);
  indexLayout(window.SPLASH_LAYOUT);

  /** Resolve any serialized reference to the GameObject id the engine knows. */
  function go(v) {
    if (v == null) return null;
    var f = (typeof v === 'object') ? v.__ref : v;
    if (f == null || f === '0') return null;
    f = String(f);
    if (E.get(f)) return f;
    if (compHost[f]) return compHost[f];
    if (trHost[f]) return trHost[f];
    return null;
  }
  function script(type, list) {
    list = list || C.scripts;
    for (var i = 0; i < list.length; i++) if (list[i].__type === type) return list[i];
    return null;
  }
  function scriptsOf(type, list) {
    return (list || C.scripts).filter(function (s) { return s.__type === type; });
  }
  /** Unity only runs Awake/Start for objects active in the hierarchy at load. */
  function liveScript(type) {
    var all = scriptsOf(type);
    for (var i = 0; i < all.length; i++) {
      if (E.isActiveInHierarchy(go(all[i].__host))) return all[i];
    }
    return all[0] || null;
  }
  function audioPath(v) {
    return v && v.__audio ? v.__audio : null;
  }
  function sprite(v) { return v && v.__sprite ? v.__sprite : null; }

  // ============================================================ AudioSources
  // Unity AudioSource playOnAwake fires when the object becomes enabled.
  var srcOf = Object.create(null);   // GameObject id -> {clip,vol,loop,channel}

  // Every spoken line shares ONE channel, so starting a line always cancels
  // the previous one. Without this the "Oops!" line (its own AudioSource on the
  // incorrect dialogue box) talked over the instruction line.
  var VO_CHANNEL = 'vo';
  var VO_HOSTS = {
    '1028098040': 1,   // gameplay_audioSource -- every tutorial VO
    '1364679847': 1    // incorrectDialogueBox -- "Oops! ..." VO
  };
  // These two AudioSources are script-driven speech channels whose serialized
  // clip is a leftover copy of the background music. Honouring playOnAwake
  // here started a second, full-volume bg.mp3 on top of the looping one.
  var SUPPRESS_AWAKE = { '1028098040': 1, '2104404939': 1 };

  function indexAudio(roots, tag) {
    (roots || []).forEach(function walk(n) {
      (n.components || []).forEach(function (c) {
        if (c.kind === 'AudioSource') {
          var id = String(n.id);
          srcOf[id] = {
            clip: c.clip, vol: c.volume, loop: c.loop,
            playOnAwake: c.playOnAwake && !SUPPRESS_AWAKE[id],
            isVO: !!VO_HOSTS[id],
            channel: VO_HOSTS[id] ? VO_CHANNEL : (tag + ':' + n.id)
          };
        }
      });
      (n.children || []).forEach(walk);
    });
  }
  indexAudio(window.LAYOUT, 'p');
  indexAudio(window.SPLASH_LAYOUT, 's');

  function srcPlay(hostId, clipPath, volume) {
    var s = srcOf[String(hostId)];
    if (!s) return;
    var clip = clipPath || s.clip;
    if (!clip) return;
    E.play(s.channel, clip,
      { volume: volume != null ? volume : s.vol, loop: s.loop });
  }
  function srcPlayOwn(hostId) {
    var s = srcOf[String(hostId)];
    if (s && s.clip) E.play(s.channel, s.clip, { volume: s.vol, loop: s.loop });
  }
  function srcStop(hostId) {
    var s = srcOf[String(hostId)];
    if (s) E.stopChannel(s.channel);
  }
  function stopVO() { E.stopChannel(VO_CHANNEL); }

  // ------------------------------------------------------- hint-hand arbiter
  // Six per-tray hands plus one shared hand all point at trays. The tutorial
  // timeline and GameManager's idle timer could raise two of them at once, so
  // showing one now hides the rest -- there is never more than one hand.
  var handIds = null;
  function allHands() {
    if (!handIds) {
      handIds = E.byName('hand').map(function (r) { return r.id; });
    }
    return handIds;
  }
  function isHand(id) { return allHands().indexOf(String(id)) >= 0; }
  function showHand(id, on) {
    if (!id) return;
    if (on) {
      allHands().forEach(function (h) {
        if (h !== String(id)) E.setActive(h, false);
      });
    }
    E.setActive(id, on);
  }
  function hideAllHands() {
    allHands().forEach(function (h) { E.setActive(h, false); });
  }

  // ======================================================== TutorialDialogue
  function TutorialDialogue(cfg) {
    var self = this;
    this.cfg = cfg;
    this.dialogueText = go(cfg.dialogueText);
    this.incorrectTextobject = go(cfg.incorrectTextobject);
    this.CorrectTextobject = go(cfg.CorrectTextobject);
    this.redalert = go(cfg.redalert);
    this.gameplaySrc = go(cfg.gameplay_audioSource);
    this.uiSrc = go(cfg.ui_audioSource);
    this.clips = (cfg.tutorialAudioClips || []).map(audioPath);
    this.tray_btn = (cfg.tray_btn || []).map(go);
    this.randomMessages = cfg.randomMessages || [];
    this.tutorials = cfg.tutorials || [];
    this.typingSpeed = cfg.typingSpeed != null ? cfg.typingSpeed : 0.05;
    this.tutorialIndex = 0;
    this.messageIndex = 0;
    this.isTyping = false;
    this.tasks = new E.TaskGroup('td');
    this.typing = new E.TaskGroup('td-type');
    this.delayed = new E.TaskGroup('td-delayed');   // audio + object reveals
    this._inputBtns = [];

    this.start = function () { self.startDialogue(); };
  }

  /** The message that is currently on screen (messageIndex points past it). */
  TutorialDialogue.prototype.currentMessage = function () {
    var set = this.tutorials[this.tutorialIndex];
    if (!set || !set.messages) return null;
    return set.messages[this.messageIndex - 1] || null;
  };

  /** Drop every runtime "advance" listener so a stale button can't skip ahead. */
  TutorialDialogue.prototype.clearInputListeners = function () {
    for (var i = 0; i < this._inputBtns.length; i++) E.clearClicks(this._inputBtns[i]);
    this._inputBtns.length = 0;
  };

  TutorialDialogue.prototype.startDialogue = function () {
    this.tutorialIndex = 0;
    this.messageIndex = 0;
    this.showNextMessage();
  };

  TutorialDialogue.prototype.showNextMessage = function () {
    var self = this;
    if (this.tutorialIndex >= this.tutorials.length) {
      E.setText(this.dialogueText, '');
      return;
    }
    var currentMessages = this.tutorials[this.tutorialIndex].messages || [];

    if (this.messageIndex >= currentMessages.length) {
      this.tutorialIndex++;
      this.messageIndex = 0;
      this.showNextMessage();
      // NOTE: in the C# this runs *after* the recursive call returns.
      if (Game.gameManager && Game.gameManager.noOfMatchSucced < 2) {
        this.setButtonValue(true);
      }
      return;
    }

    var msg = currentMessages[this.messageIndex];

    // one shared cancellable chain per message: anything the previous message
    // still had queued (delayed VO, delayed hand reveal) dies here, so a retry
    // or a fast learner can never be interrupted by stale timers
    this.delayed.reset();
    this.clearInputListeners();

    if (msg.isRandom && this.randomMessages.length > 0) {
      msg.message = this.randomMessages[
        Math.floor(Math.random() * this.randomMessages.length)];
    }

    this.triggerCustomAction(msg);
    this.enableDisableObjectsWithDelay(msg, this.messageIndex);

    if (msg.audioIndex >= 0 && msg.audioIndex < this.clips.length) {
      this.playAudioDelayed(msg.audioIndex, msg.audioDelay || 0,
        this.messageIndex);
    }

    this.typeText(msg);

    if (msg.waitForInput) {
      if (msg.useRandomInput) {
        // AssignListenersToTrayButtons() -- body commented out in the C#;
        // the scene's own per-tray onClick wiring calls OnTrayButtonClicked.
      } else {
        var btn = go(msg.inputButton);
        if (btn) {
          E.setActive(btn, true);
          E.clearClicks(btn);
          this._inputBtns.push(btn);
          // fires exactly once: a second tap on the same button (or a tap
          // after the dialogue has moved on) must not skip a message
          E.addClick(btn, function () {
            if (self._inputBtns.indexOf(btn) < 0) return;
            self.clearInputListeners();
            self.handleNextClick(btn);
          });
        }
      }
    }
    this.messageIndex++;
  };

  TutorialDialogue.prototype.typeText = function (msg) {
    var self = this;
    this.typing.reset();
    var text = msg.message == null ? '' : String(msg.message);
    this.isTyping = true;
    E.setText(this.dialogueText, '');
    this.typing.run(function* () {
      var acc = '';
      for (var i = 0; i < text.length; i++) {
        acc += text[i];
        E.setText(self.dialogueText, acc);
        yield self.typingSpeed;
      }
      self.isTyping = false;
      if (msg.waitForCondition) return;          // wait for external trigger
      if (!msg.waitForInput) {
        yield (msg.autoAdvanceDelay || 0);
        self.showNextMessage();
      }
    });
  };

  /**
   * Advance. If a line is still typing, snap it to full text first so the
   * learner always sees the complete sentence before the next one replaces it.
   */
  TutorialDialogue.prototype.advance = function () {
    if (this.isTyping) {
      this.typing.cancel();
      var m = this.currentMessage();
      E.setText(this.dialogueText, (m && m.message != null) ? String(m.message) : '');
      this.isTyping = false;
    }
    this.showNextMessage();
  };

  TutorialDialogue.prototype.handleNextClick = function () { this.advance(); };

  TutorialDialogue.prototype.onTrayButtonClicked = function (btnHostId) {
    if (this.tray_btn.indexOf(String(btnHostId)) < 0) return;
    this.advance();
  };

  TutorialDialogue.prototype.continueAfterCondition = function () {
    if (!this.isTyping) this.showNextMessage();
  };

  TutorialDialogue.prototype.showNextIfNotTyping = function () {
    if (!this.isTyping) this.showNextMessage();
  };

  TutorialDialogue.prototype.retryPreviousMessage = function (stepsBack) {
    stepsBack = stepsBack == null ? 3 : stepsBack;
    this.messageIndex = Math.max(0, this.messageIndex - stepsBack);
    this.showNextMessage();
  };

  TutorialDialogue.prototype.enableDisableObjectsWithDelay =
    function (msg, localMessageIndex) {
      var self = this;
      (msg.objectsToDisable || []).forEach(function (o) {
        var id = go(o);
        if (!id) return;
        if (isHand(id)) showHand(id, false); else E.setActive(id, false);
      });
      var list = msg.objectsToEnable || [];
      if (!list.length) return;
      // one cancellable chain, reset per message: matches the single coroutine
      // and guarantees a previous message's delayed reveal cannot land later
      this.delayed.run(function* () {
        for (var i = 0; i < list.length; i++) {
          var d = list[i];
          yield (d.delayBeforeEnable || 0);
          // the C# aborts the whole coroutine once the message has advanced
          if (localMessageIndex !== self.messageIndex - 1) return;
          var id = go(d.obj);
          if (!id) continue;
          if (isHand(id)) showHand(id, true); else E.setActive(id, true);
        }
      });
    };

  TutorialDialogue.prototype.playAudioDelayed =
    function (audioIndex, delay, localMessageIndex) {
      var self = this;
      if (!delay) {                     // no delay -> no timer, no drift
        srcPlay(self.gameplaySrc, self.clips[audioIndex]);
        return;
      }
      this.delayed.run(function* () {
        yield delay;
        if (localMessageIndex === self.messageIndex - 1) {
          srcPlay(self.gameplaySrc, self.clips[audioIndex]);
        }
      });
    };

  /**
   * UI tap sound. Stays on the UI channel -- not the VO channel -- so a tap
   * never cuts speech, and one channel means a rapid double-tap replaces the
   * sound instead of stacking two copies of it. Held under the VO level.
   */
  TutorialDialogue.prototype.playaudio = function (audioIndex) {
    if (this.clips[audioIndex]) srcPlay(this.uiSrc, this.clips[audioIndex], 0.55);
  };

  TutorialDialogue.prototype.setButtonValue = function (value) {
    for (var i = 0; i < this.tray_btn.length; i++) {
      if (this.tray_btn[i]) E.setInteractable(this.tray_btn[i], value);
    }
  };

  TutorialDialogue.prototype.triggerCustomAction = function (msg) {
    var ev = msg.onMessageComplete && msg.onMessageComplete.__event;
    if (!ev) return;
    for (var i = 0; i < ev.length; i++) invokeEvent(ev[i]);
  };

  // ============================================================== PlateItem
  function PlateItem(cfg) {
    this.cfg = cfg;
    this.host = go(cfg.__host);
    this.itemCount = cfg.itemCount;
    this.button = go(cfg.button);
    this.correctObject = go(cfg.correctObject);
    this.Tray_number_obj = go(cfg.Tray_number_obj);
    this.defaultSprite = sprite(cfg.defaultSprite);
    this.selectedSprite = sprite(cfg.selectedSprite);
    this.incorrectSprite = sprite(cfg.incorrectSprite);
    // plateImage = GetComponent<Image>() on the tray itself
    this.plateImage = this.host;
    // the container holding this tray's counted items (candles, gems, ...)
    this.objects = E.childByName(this.host, 'objects');
    this.isSelected = false;
  }
  PlateItem.prototype.onClicked = function () {
    // never allow a pick to change while a comparison is playing out
    if (Game.gameManager && Game.gameManager._resolving) return;
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!this.isSelected) {
      this.isSelected = true;
      this._selectedAt = now;
      if (this.plateImage && this.selectedSprite) {
        E.setSprite(this.plateImage, this.selectedSprite);
      }
      this.liftIn();
      // the itemCount == gameManager.buttonId branch only logs in the C#
    } else {
      // an excited double-tap is one pick, not pick-then-unpick
      if (now - (this._selectedAt || 0) < 280) return;
      this.isSelected = false;
      this.resetPlate();
      S.play('deselect');
      // The scene fires OnClicked BEFORE OnPlateClicked, so without this flag
      // the very same tap would fall through and re-select the tray.
      this._justDeselected = true;
      Game.gameManager.onPlateDeselected(this);
    }
  };

  /**
   * Selection feedback: the tray rises to the front and settles with a small
   * over-scale, so a learner can see at a glance which trays they picked.
   */
  PlateItem.prototype.liftIn = function () {
    var id = this.host;
    if (!id) return;
    var rec = E.get(id);
    if (rec) {
      rec.el.style.zIndex = '3';           // the glow must sit over neighbours
      rec.el.classList.remove('un-wrong');
      rec.el.classList.add('un-selected');
    }
    this.fx = this.fx || new E.TaskGroup('plate-' + id);
    this.fx.reset();
    var base = E.baseScale(id);
    this.fx.tween(0.26, 'outBack', function (t) {
      E.setScale(id, base * (1 + 0.06 * t));
    }, function () { E.setScale(id, base * 1.06); });
  };
  /** Matched: success glow plus a one-shot magic burst. No size change. */
  PlateItem.prototype.markCorrect = function () {
    var rec = E.get(this.host);
    if (!rec) return;
    if (this.fx) this.fx.cancel();
    E.setScale(this.host, E.baseScale(this.host));
    rec.el.style.zIndex = '3';
    rec.el.classList.remove('un-selected', 'un-wrong');
    // restart the burst from scratch even on a replay
    rec.el.classList.remove('un-burst');
    void rec.el.offsetWidth;
    rec.el.classList.add('un-correct', 'un-burst');
  };

  /**
   * Drop the green glow before the reward card appears. The card carries its own
   * large golden glow, and a green drop-shadow on the tray tints it through --
   * two adjacent cards then merged into one flat green-yellow wash.
   */
  PlateItem.prototype.clearCorrectGlow = function () {
    var rec = E.get(this.host);
    if (rec) rec.el.classList.remove('un-correct', 'un-burst');
  };

  PlateItem.prototype.settle = function () {
    if (this.fx) this.fx.cancel();
    var rec = E.get(this.host);
    if (rec) {
      rec.el.style.zIndex = '';
      rec.el.classList.remove('un-selected', 'un-wrong', 'un-correct', 'un-burst');
    }
    if (this.host) E.setScale(this.host, E.baseScale(this.host));
  };

  PlateItem.prototype.resetPlate = function () {
    this.isSelected = false;
    if (this.plateImage && this.defaultSprite) {
      E.setSprite(this.plateImage, this.defaultSprite);
      if (this.Tray_number_obj) E.setActive(this.Tray_number_obj, false);
    }
    // the shake / lift leave a transform behind if cancelled mid-flight
    this.settle();
    if (this.host) E.setPixelOffset(this.host, 0, 0);
  };
  PlateItem.prototype.showIncorrectSprite = function () {
    if (this.plateImage && this.incorrectSprite) {
      E.setSprite(this.plateImage, this.incorrectSprite);
      if (this.Tray_number_obj) E.setActive(this.Tray_number_obj, true);
    }
    var rec = E.get(this.host);
    if (rec) {
      rec.el.classList.remove('un-selected');
      rec.el.classList.add('un-wrong');
    }
    return Promise.resolve();     // `yield return null` -- one frame
  };
  PlateItem.prototype.setSelectedSprite = function () {
    if (this.selectedSprite) E.setSprite(this.plateImage, this.selectedSprite);
  };

  // ============================================================ GameManager
  function GameManager(cfg) {
    var self = this;
    this.cfg = cfg;
    this.clickedPlates = [];
    this.checkButton = go(cfg.checkButton);
    this.tryAgainButton = go(cfg.tryAgainButton);
    this.key = go(cfg.key);
    this.isSelectGame = !!cfg.isSelectGame;
    this.buttonId = cfg.buttonId || 0;
    this.noOfMatchSucced = cfg.noOfMatchSucced || 0;
    this._isTutorialCmplt = !!cfg._isTutorialCmplt;
    this.Tray3_number_obj = go(cfg.Tray3_number_obj);
    this.Tray6_number_obj = go(cfg.Tray6_number_obj);
    this.BottonPanel = go(cfg.BottonPanel);
    this.BottonPanelParent = go(cfg.BottonPanelParent);
    this.particles = go(cfg.particleSystem);
    this.myTransforms = (cfg.myTransforms || []).map(go);
    this.hand = go(cfg.hand);

    this.handStart = new E.TaskGroup('gm-handStart');
    this.handPair = new E.TaskGroup('gm-handPair');
    this.incorrect = new E.TaskGroup('gm-incorrect');
    this.correct = new E.TaskGroup('gm-correct');
    this.seq = new E.TaskGroup('gm-seq');
    this._resolving = false;

    this.start = function () {
      self.handStart.reset();
      self.handStart.run(function* () {
        yield 5;
        if (self.clickedPlates.length === 0 && self.myTransforms.length > 0 &&
          self.myTransforms[0] && self.hand) {
          self.moveHandTo(self.myTransforms[0]);   // Tray1
          showHand(self.hand, true);
        }
      });
    };
  }

  /**
   * hand.transform.position = myTransforms[i].position
   * Solves Unity's corner = aMin*P + anchoredPosition - sizeDelta*pivot for
   * anchoredPosition, given the target centre in stage space.
   */
  GameManager.prototype.moveHandTo = function (targetId) {
    var c = E.centerOf(targetId);
    var h = E.get(this.hand);
    if (!h) return;
    var parent = h.parent;
    var px = 0, py = 0, n = parent;
    while (n) { px += n.left; py += n.top; n = n.parent; }
    var pw = parent ? parent.w : E.stageSize()[0];
    var ph = parent ? parent.h : E.stageSize()[1];
    var d = h.data;
    var localX = c[0] - px, localY = c[1] - py;
    var apX = (localX - h.w / 2) - d.anchorMin[0] * pw + d.sizeDelta[0] * d.pivot[0];
    var apY = ((ph - localY) - h.h / 2) - d.anchorMin[1] * ph + d.sizeDelta[1] * d.pivot[1];
    E.setAnchoredPos(this.hand, apX, apY);
  };

  GameManager.prototype.onPlateClicked = function (plate) {
    var self = this;
    if (this._resolving) return;
    // this tap was an un-pick; the scene's later OnPlateClicked must not undo it
    if (plate._justDeselected) { plate._justDeselected = false; return; }
    if (this.clickedPlates.length < 2 &&
      this.clickedPlates.indexOf(plate) < 0) {
      this.clickedPlates.push(plate);

      hideAllHands();               // the learner is acting: drop every hint
      this.handStart.cancel();
      S.play('select', this.clickedPlates.length - 1);

      if (this.clickedPlates.length === 1) {
        this.handPair.reset();
        var firstName = E.get(plate.host).data.name;
        this.handPair.run(function* () {
          yield 7;
          if (self.clickedPlates.length === 1 && self.hand) {
            var moveToIndex = -1;
            if (firstName === 'Tray1') moveToIndex = 4;        // Tray5
            else if (firstName === 'Tray5') moveToIndex = 0;   // Tray1
            else if (firstName === 'Tray2') moveToIndex = 3;   // Tray4
            else if (firstName === 'Tray4') moveToIndex = 1;   // Tray2
            if (moveToIndex >= 0 && moveToIndex < self.myTransforms.length &&
              self.myTransforms[moveToIndex]) {
              self.moveHandTo(self.myTransforms[moveToIndex]);
              showHand(self.hand, true);
            }
          }
        });
      } else if (this.clickedPlates.length > 1) {
        this.handPair.cancel();
      }

      // remove this tray's button from TutorialDialogue.tray_btn
      var i = Game.tutorial.tray_btn.indexOf(plate.button);
      if (i >= 0) Game.tutorial.tray_btn.splice(i, 1);

      // Locking happens AFTER the splice so it only covers the trays that are
      // still up for grabs: the two picked trays stay tappable and can be
      // un-picked, instead of the learner being stuck with a wrong first tap.
      if (this.clickedPlates.length === 2) {
        Game.tutorial.setButtonValue(false);
      }

      // if (_isTutorialCmplt) { TryCompare(); }  -- commented out in the C#
    }
  };

  /**
   * The "Oops!" panel and the instruction panel occupy exactly the same rect,
   * so leaving both active stacked two identical dialogue boxes on top of each
   * other (the taller sort order simply hid the one underneath). Only ever one
   * panel is mounted, which also stops the hidden instruction text from being
   * mid-typewriter behind it.
   */
  GameManager.prototype.setIncorrectPanel = function (on) {
    var td = Game.tutorial;
    if (!td) return;
    if (td.incorrectTextobject) E.setActive(td.incorrectTextobject, on);
    if (td.CorrectTextobject) E.setActive(td.CorrectTextobject, !on);
  };

  /**
   * Un-picking a tray. Puts the tray back in the pool, retracts the Check
   * button (pressing it with one tray picked was a dead end) and rewinds the
   * spoken instruction by two lines, which lands on the line that matches the
   * new count in every tutorial set -- "Select another tray" when one is still
   * picked, "Tap two trays" when none are.
   */
  GameManager.prototype.onPlateDeselected = function (plate) {
    var i = this.clickedPlates.indexOf(plate);
    if (i >= 0) this.clickedPlates.splice(i, 1);

    if (Game.tutorial.tray_btn.indexOf(plate.button) < 0) {
      Game.tutorial.tray_btn.push(plate.button);
    }
    if (this.checkButton) E.setActive(this.checkButton, false);
    this.handPair.cancel();
    hideAllHands();
    if (!this.isSelectGame) Game.tutorial.setButtonValue(true);
    Game.tutorial.retryPreviousMessage(2);
  };

  GameManager.prototype.tryCompare = function () {
    // hide the button first and latch, so a double-tap on Check can never run
    // the comparison twice (which would double-count a match)
    if (this._resolving) return;
    if (this.checkButton) E.setActive(this.checkButton, false);
    if (this.clickedPlates.length === 2) {
      this._resolving = true;
      Game.tutorial.setButtonValue(false);   // no tray taps while resolving
      // the two picked trays are outside tray_btn, so lock them explicitly
      this.clickedPlates.forEach(function (p) { E.setInteractable(p.button, false); });
      this.comparePlates(this.clickedPlates[0], this.clickedPlates[1]);
    }
  };

  GameManager.prototype.comparePlates = function (p1, p2) {
    hideAllHands();
    if (p1.itemCount === p2.itemCount) {
      this.noOfMatchSucced++;
      if (this.noOfMatchSucced === 1) this.tutorialCmplt(true);
      this.showCorrectImages(p1, p2);
      this.clickedPlates = [];
      Game.tutorial.continueAfterCondition();
      if (this.particles) E.playParticles(this.particles);
    } else {
      this.showIncorrectMatch(p1, p2);
      this.setIncorrectPanel(true);
      if (this.tryAgainButton) E.setActive(this.tryAgainButton, true);
      Game.tutorial.tray_btn.push(p1.button);
      Game.tutorial.tray_btn.push(p2.button);
    }
  };

  GameManager.prototype.showCorrectImages = function (p1, p2) {
    var self = this;
    this.correct.reset();
    var g = this.correct;
    S.play('correct');
    /*
     * Two beats, never overlapping.
     *
     * The reward art is a glow PLUS its own plate PLUS baked-in text
     * ("That's correct! / 4 Gems"), so it is built to replace the tray. Drawing
     * it over the items buried them; drawing the items over it collided three
     * layers of text. Neither is acceptable in a counting game, where the
     * learner has to see what they counted.
     *
     *   beat 1  the tray glows green and the number labels count the items
     *           the learner just tapped  -- the answer is confirmed in place
     *   beat 2  items and numbers step aside for the reward card
     */
    g.run(function* () {
      [p1, p2].forEach(function (p) {
        p.markCorrect();
        if (p.Tray_number_obj) E.setActive(p.Tray_number_obj, true);
      });
      yield 0.75;

      [p1, p2].forEach(function (p, i) {
        if (p.Tray_number_obj) E.setActive(p.Tray_number_obj, false);
        if (p.objects) E.setActive(p.objects, false);
        p.clearCorrectGlow();          // the card brings its own glow
        E.setActive(p.correctObject, true);
        // Scaled from the badge's OWN authored scale (0.611): tweening to a
        // flat 1 blew it up to 164% and washed the screen out in yellow.
        var base = E.baseScale(p.correctObject);
        E.setScale(p.correctObject, base * 0.55);
        g.tween(0.3, 'outBack', function (t) {
          E.setScale(p.correctObject, base * (0.55 + 0.45 * t));
        }, function () { E.setScale(p.correctObject, base); });
        if (i === 0) S.play('pop', null, 20);
      });
      yield 1.15;

      [p1, p2].forEach(function (p) {
        E.setActive(p.correctObject, false);
        E.setScale(p.correctObject, E.baseScale(p.correctObject));
        if (p.objects) E.setActive(p.objects, true);    // restore for a replay
        p.settle();
        E.setActive(p.host, false);
      });
      self._resolving = false;
    });
  };

  GameManager.prototype.showIncorrectMatch = function (p1, p2) {
    var self = this;
    var g = this.incorrect;
    g.reset();
    S.play('wrong');
    p1.settle(); p2.settle();
    g.run(function* () {
      yield p1.showIncorrectSprite();
      yield p2.showIncorrectSprite();
      yield Promise.all([
        shakePosition(g, p1.host, 1, 10, 10, 90),
        shakePosition(g, p2.host, 1, 10, 10, 90)
      ]);
      yield 0.5;
      self._resolving = false;      // Try Again is the only way forward now
    });
  };

  GameManager.prototype.onClickTryAgain = function () {
    if (this._retrying) return;
    this._retrying = true;
    // tear the wrong-answer state down BEFORE re-running the instruction, so
    // nothing from the failed attempt survives into the retry
    if (this.tryAgainButton) E.setActive(this.tryAgainButton, false);
    this.incorrect.cancel();
    this.correct.cancel();
    this.handPair.cancel();
    hideAllHands();
    stopVO();
    this.setIncorrectPanel(false);
    if (this.Tray3_number_obj) E.setActive(this.Tray3_number_obj, false);
    if (this.Tray6_number_obj) E.setActive(this.Tray6_number_obj, false);

    Game.tutorial.tray_btn.forEach(function (btnHost) {
      var plate = Game.plateByHost[btnHost];
      if (plate) plate.resetPlate();
    });
    this.resetAndClearTrayItems();
    this._resolving = false;

    Game.tutorial.retryPreviousMessage();

    if (this.isSelectGame) Game.tutorial.setButtonValue(false);
    else Game.tutorial.setButtonValue(true);
    this._retrying = false;
  };

  GameManager.prototype.resetAndClearTrayItems = function () {
    for (var i = 0; i < this.clickedPlates.length; i++) {
      if (this.clickedPlates[i]) this.clickedPlates[i].resetPlate();
    }
    this.clickedPlates = [];
  };

  GameManager.prototype.tutorialCmplt = function (v) { this._isTutorialCmplt = v; };
  GameManager.prototype.showKey = function () {
    E.setActive(this.key, true);
    S.play('reward');
  };

  GameManager.prototype.storeButtonId = function (btnHostId) {
    var plate = Game.plateByHost[String(btnHostId)];
    if (plate) this.buttonId = plate.itemCount;
  };

  GameManager.prototype.onClcikYesButton = function () {
    if (this.isSelectGame) return;          // Yes/No answers exactly once
    this.isSelectGame = true;
    hideAllHands();
    S.play('wrong');                        // these two trays do NOT match
    if (this.BottonPanel) E.setActive(this.BottonPanel, false);
    if (this.Tray3_number_obj) E.setActive(this.Tray3_number_obj, true);
    if (this.Tray6_number_obj) E.setActive(this.Tray6_number_obj, true);
    this.setIncorrectPanel(true);
    if (this.BottonPanelParent) E.setActive(this.BottonPanelParent, true);
    if (this.tryAgainButton) E.setActive(this.tryAgainButton, true);

    if (Game.tutorial.tray_btn.length > 0) {
      var g = this.incorrect;
      g.reset();
      Game.tutorial.tray_btn.forEach(function (btnHost) {
        var plate = Game.plateByHost[btnHost];
        if (!plate) return;
        shakePosition(g, btnHost, 1, 10, 10, 90);
        plate.showIncorrectSprite();
      });
    }
  };

  // DOTween DOShakePosition(duration, strength, vibrato, randomness, false, false)
  function shakePosition(group, id, duration, strength, vibrato, randomness) {
    var segs = Math.max(1, Math.round(vibrato));
    var pts = [];
    for (var i = 0; i < segs; i++) {
      var ang = (i % 2 ? 180 : 0) + (Math.random() - 0.5) * randomness;
      var r = ang * Math.PI / 180;
      pts.push([Math.cos(r) * strength, Math.sin(r) * strength * 0.0]);
    }
    pts.push([0, 0]);
    return group.tween(duration, 'linear', function (t) {
      var f = t * segs;
      var i = Math.min(segs, Math.floor(f));
      var k = f - i;
      var a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)];
      E.setPixelOffset(id, a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k);
    }, function () { E.setPixelOffset(id, 0, 0); });
  }

  // ======================================================= GridLayoutManager
  function GridLayoutManager(cfg) {
    var hostId = go(cfg.__host);
    var rec = E.get(hostId);
    if (!rec || !rec.grid) return;
    // Start(): force FixedRowCount with the initial row count
    rec.grid.constraint = 2;
    rec.grid.runtimeConstraintCount = 2;
    var initialRowCount = 2, targetRowCount = 1, threshold = 2;
    E.layoutGrid(hostId);
    // Update(): row count follows the number of active children
    E.onTick(function () {
      if (!E.isActiveInHierarchy(hostId)) return;
      var active = rec.children.filter(function (c) { return c.activeSelf; }).length;
      var want = active <= threshold ? targetRowCount : initialRowCount;
      if (rec.grid.runtimeConstraintCount !== want) {
        rec.grid.runtimeConstraintCount = want;
        E.layoutGrid(hostId);
      }
    });
  }

  // =========================================================== JumpAndScaleUI
  function JumpAndScaleUI(cfg) {
    var id = go(cfg.__host);
    var grp = new E.TaskGroup('jump-' + id);
    return {
      onEnable: function () {
        grp.reset();
        // this component only drives the reward key, so its reveal IS the reward
        S.play('reward');
        var base = E.getAnchoredPos(id);
        E.setScale(id, 0, 0);
        grp.tween(0.4, 'outBack', function (t) {
          E.setScale(id, 0.6 * t, 0.6 * t);
        });
        var jumpHeight = 50, jumpDuration = 0.3;
        grp.tween(jumpDuration, 'outQuad', function (t) {
          E.setAnchoredPos(id, base[0], base[1] + jumpHeight * t);
        }, function () {
          grp.tween(jumpDuration, 'inQuad', function (t) {
            E.setAnchoredPos(id, base[0], base[1] + jumpHeight * (1 - t));
          });
        });
      },
      onDisable: function () { grp.cancel(); }
    };
  }

  // ========================================================= TypewriterEffect
  function TypewriterEffect(cfg) {
    var textId = go(cfg.chatText);
    var full = cfg.fullMessage == null ? '' : String(cfg.fullMessage);
    var speed = cfg.typingSpeed != null ? cfg.typingSpeed : 0.05;
    var hostId = go(cfg.__host);
    var grp = new E.TaskGroup('tw-' + hostId);
    return {
      onEnable: function () {
        grp.reset();
        E.setText(textId, '');
        srcPlayOwn(hostId);          // AudioSource playOnAwake on this object
        grp.run(function* () {
          var acc = '';
          for (var i = 0; i < full.length; i++) {
            acc += full[i];
            E.setText(textId, acc);
            yield speed;
          }
        });
      },
      // leaving the screen must take the line's voice-over with it
      onDisable: function () { grp.cancel(); srcStop(hostId); E.setText(textId, ''); }
    };
  }

  // ======================================================= SplashScreenLoader
  function SplashScreenLoader(cfg, onLoadScene) {
    var animId = go(cfg.objectToAnimate);
    var fadeId = go(cfg.fadePanel);
    var hostId = go(cfg.__host);
    var maxScale = cfg.maxScale != null ? cfg.maxScale : 1.2;
    var scaleDuration = cfg.scaleDuration != null ? cfg.scaleDuration : 1;
    var fadeDuration = cfg.fadeDuration != null ? cfg.fadeDuration : 0.5;
    var clickSound = audioPath(cfg.buttonClickSound);
    var clickVol = cfg.clickSoundVolume != null ? cfg.clickSoundVolume : 1;
    var grp = new E.TaskGroup('splash');
    var loading = false;

    // Awake(): fadePanel.alpha = 0; fadePanel.SetActive(false)
    if (fadeId) { E.setAlpha(fadeId, 0); E.setActive(fadeId, false); }

    function pingPong() {
      grp.tween(scaleDuration, 'inOutSine', function (t) {
        E.setScale(animId, 1 + (maxScale - 1) * t);
      }, function () {
        grp.tween(scaleDuration, 'inOutSine', function (t) {
          E.setScale(animId, maxScale - (maxScale - 1) * t);
        }, pingPong);
      });
    }
    if (animId) pingPong();

    return {
      loadNextScene: function () {
        if (loading) return;
        loading = true;
        if (clickSound) E.playOneShot(clickSound, clickVol);
        S.play('whoosh');
        if (fadeId) {
          E.setActive(fadeId, true);
          grp.tween(fadeDuration, 'linear', function (t) {
            E.setAlpha(fadeId, t);
          }, function () { grp.cancel(); onLoadScene(); });
        } else {
          grp.delayedCall(0.3, function () { grp.cancel(); onLoadScene(); });
        }
      },
      hostId: hostId
    };
  }

  // ======================================================== event dispatcher
  // Maps a scene UnityEvent persistent call onto the ported method.
  function invokeEvent(call) {
    var m = call.method, a = call.args || {};
    var td = Game.tutorial, gm = Game.gameManager;
    switch (m) {
      case 'OnTrayButtonClicked': return td && td.onTrayButtonClicked(go(a.obj));
      case 'OnClicked': {
        var p = Game.plateByComp[String(call.target)];
        return p && p.onClicked();
      }
      case 'playaudio': return td && td.playaudio(a.int);
      case 'OnPlateClicked': {
        var pl = Game.plateByComp[String(a.obj)] ||
          Game.plateByHost[go(a.obj)];
        return gm && pl && gm.onPlateClicked(pl);
      }
      case 'TryCompare': return gm && gm.tryCompare();
      case 'onClickTryAgain': return gm && gm.onClickTryAgain();
      case 'onClcikYesButton': return gm && gm.onClcikYesButton();
      case 'ShowKey': return gm && gm.showKey();
      case 'StoreButtonId': return gm && gm.storeButtonId(go(a.obj));
      case 'SetButtonValue': return td && td.setButtonValue(!!a.bool);
      case 'ContinueAfterCondition': return td && td.continueAfterCondition();
      case 'ShowNextIfNotTyping': return td && td.showNextIfNotTyping();
      case 'RetryPreviousMessage': return td && td.retryPreviousMessage();
      case 'TutorialCmplt': return gm && gm.tutorialCmplt(!!a.bool);
      case 'Play': {                       // UnityEngine.ParticleSystem.Play
        var host = go(call.target);
        if (!host) return;
        S.play('celebrate');               // the confetti burst is the payoff
        return E.playParticles(host);
      }
      case 'SetActive': {
        var h = go(call.target);
        return h && E.setActive(h, !!a.bool);
      }
      case 'LoadNextScene':
        return Game.splash && Game.splash.loadNextScene();
      default:
        if (console && console.warn) {
          console.warn('unmapped UnityEvent method: ' + m);
        }
    }
  }

  return {
    TutorialDialogue: TutorialDialogue,
    PlateItem: PlateItem,
    GameManager: GameManager,
    GridLayoutManager: GridLayoutManager,
    JumpAndScaleUI: JumpAndScaleUI,
    TypewriterEffect: TypewriterEffect,
    SplashScreenLoader: SplashScreenLoader,
    invokeEvent: invokeEvent,
    go: go, script: script, scriptsOf: scriptsOf, liveScript: liveScript,
    srcPlayOwn: srcPlayOwn, srcStop: srcStop, srcOf: srcOf, audioPath: audioPath,
    stopVO: stopVO, showHand: showHand, hideAllHands: hideAllHands,
    allHands: allHands, VO_CHANNEL: VO_CHANNEL,
    // populated by main.js
    tutorial: null, gameManager: null, splash: null,
    plateByHost: Object.create(null), plateByComp: Object.create(null)
  };
})();
