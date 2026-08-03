/* analytics.js -- preserves the exact contract from
 * Assets/Plugins/WebGL/TrackingPlugin.jslib:
 *
 *   window.quizAnswerSubmitted(q_id, selected, correct, isCorrect, attempt)
 *
 * The game must keep working when the host page provides no hook.
 */
'use strict';
var Analytics = (function () {
  var log = [];
  function submitQuizAnswer(questionId, selectedNumber, correctNumber,
                            isCorrect, attemptNumber) {
    var rec = [questionId, selectedNumber, correctNumber,
               Boolean(isCorrect), attemptNumber];
    log.push({ t: Date.now(), args: rec });
    if (typeof window.quizAnswerSubmitted === 'function') {
      try {
        window.quizAnswerSubmitted(questionId, selectedNumber, correctNumber,
                                   Boolean(isCorrect), attemptNumber);
      } catch (e) { if (console && console.warn) console.warn(e); }
    } else if (console && console.log) {
      console.log('[DEBUG] quizAnswerSubmitted: Q_id=' + questionId +
        ', selected=' + selectedNumber + ', correct=' + correctNumber +
        ', is_correct=' + Boolean(isCorrect) + ', attempt=' + attemptNumber);
    }
  }
  return { submitQuizAnswer: submitQuizAnswer,
           log: function () { return log.slice(); } };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Analytics;
