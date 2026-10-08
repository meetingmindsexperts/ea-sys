"""Run every venue browser test and check the results.

    python3 tests/run_all.py                 # all suites (10–20 minutes: WebGL runs in software)
    python3 tests/run_all.py filter round3   # only suites whose name contains these words

Each suite drives the real page in headless Chromium (Playwright, SwiftShader WebGL) against
a mock of the hosting runtime (tests/mock.js), prints what it saw as JSON, and this runner
checks it. The language filter unit test runs too when Node is installed.
Exit code 0 = everything passed. Frame rates are never checked: in software WebGL they mean nothing.
"""
import json, os, shutil, subprocess, sys, time

TESTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TESTS)

def no_errors(*keys):
    return [(f'no console errors ({k})', lambda d, k=k: d.get(k) == []) for k in keys]

SUITES = {
    'test_world': [
        ('15,000 random steps never pass through walls', lambda d: d['verify']['randomWalk']['penetrationViolations'] == 0 and d['verify']['randomWalk']['outOfBounds'] == 0 and d['verify']['randomWalk']['belowFloor'] == 0),
        ('pushing into every wall never crosses it', lambda d: d['verify']['wallPush']['wallsCrossed'] == 0),
        ('every door is passable', lambda d: d['verify']['doors']['failed'] == [] and d['verify']['doors']['passed'] == d['verify']['doors']['tested']),
        ('camera never inside geometry or outside the venue', lambda d: d['verify']['camera']['lensInsideGeometry'] == 0 and d['verify']['camera']['lensOutsideVenue'] == 0 and d['verify']['camera']['lensAboveCeiling'] == 0),
        ('stage height, jump and landing correct', lambda d: abs(d['verify']['verticals']['stageTop_m'] - d['verify']['verticals']['expectedStage_m']) < 0.01 and d['verify']['verticals']['landedAt_m'] == 0),
        ('every point of interest opens', lambda d: d['interactables']['failed'] == [] and d['interactables']['opened'] == d['interactables']['count']),
        ('no console errors', lambda d: d['consoleErrors'] == []),
    ],
    'test_abilities': [
        ('sit and stand on every seat type', lambda d: all(s['seated'] and s['onSeat'] and s['stoodBack'] for s in d['sit'])),
        ('all four gestures play', lambda d: sorted(d['gestures'].values()) == ['clap', 'heart', 'raise', 'wave']),
        ('applause spreads through the plenary', lambda d: d['clapPlenary'] > 50),
        ('both queues serve the player', lambda d: d['served'] == 2),
        ('walk-me-there: every room-to-room route arrives', lambda d: d['walkAllPairs']['fails'] == [] and d['walkAllPairs']['arrived'] == d['walkAllPairs']['routes'] and d['walkAllPairs']['snaps'] == 0),
        ('follow stays about 2 m behind', lambda d: d['follow']['stillFollowing'] and d['follow']['maxGap'] < 3.5),
        ('photo taken and saved', lambda d: d['photo']['bytes'] > 10000 and d['photoSaved']['type'] == 'image/jpeg'),
        ('phone action bar fits the screen', lambda d: d['mobileBarOpen'] and d['mobileBarFits'][1] <= d['mobileBarFits'][2] and d['mobileHScroll'] is False),
        *no_errors('errors', 'mobileErrors'),
    ],
    'test_social': [
        ('AI attendee greets and replies', lambda d: d['chatOpen'] and bool(d['greeting']) and bool(d['reply'])),
        ('conversation memory kept between replies', lambda d: d['memoryKept'] is True and d['secondCallTurns'] > d['turnsSent']),
        ('tags in AI replies stripped, venue facts in the prompt', lambda d: d['tagsStripped'] and d['promptHasVenue']),
        ('"Take me there" button walks you there', lambda d: d['afterGoZone'] == 'lounge'),
        ('live colleagues appear and can be talked to', lambda d: d['peersRendered'] == 2 and d['peerChatTag'] == 'Real person'),
        ('hostile presence data clamped, no injected HTML', lambda d: d['noInjectedImg'] is True and d['hostileClamped'][3] == 'Guest'),
        ('AI unavailable: pre-written answers, with a note', lambda d: bool(d['offlineReply']) and bool(d['declinedReply'])),
        *no_errors('consoleErrors', 'declinedErrors', 'mobileErrors'),
    ],
    'test_views': [
        ('four camera views cycle', lambda d: [c[0] for c in d['cycle']] == ['eye', 'close', 'wide', 'behind']),
        ('no view puts the camera inside geometry', lambda d: all(v['lensInsideGeometry'] == 0 for v in d['camSafety'].values())),
        ('eye view at eye height, moving and facing correctly', lambda d: abs(d['eye']['eyeHeight'] - 1.62) < 0.1 and d['eye']['moveDirErr'] < 0.1),
        ('view choice remembered', lambda d: d['persisted'] == 'eye'),
        ('natural voice preferred and spoken sentence by sentence', lambda d: d['voiceTier']['good'] is True and len(d['spoken']) == 3),
        ('view button is 40 px tall on a phone', lambda d: d['m_viewBtn'][1] >= 40),
        *no_errors('errors'),
    ],
    'test_event_team': [
        ('mute hides their words and persists', lambda d: d['mutedBubbleShown'] is False and 'u_a' in d['mutedPersisted']),
        ('report needs a reason, then is stored', lambda d: 'reason' in d['reportNeedsReason'] and 'Report sent' in d['reportMsg']),
        ('block hides them; unblock brings them back', lambda d: d['afterBlock'][0] == 1 and d['afterUnblock'] == 2),
        ('activity saved with consent and summarised', lambda d: d['analyticsDoc']['named'] is True and 'attendees recorded' in d['activitySummary']),
        ('CSV export cannot run formulas in Excel', lambda d: "'=HYPERLINK" in d['csvSafe']),
        ('reports listed for the owner', lambda d: len(d['reportsTab']) >= 1),
        ('recordings play on linked screens; unsafe URLs ignored', lambda d: d['videoFrames'] > 0 and d['noInjection'] is True),
        ('viewers without rights: no Event team button, report fallback', lambda d: d['viewer_teamBtnHidden'] is True and 'Copy report' in d['viewer_reportMsg']),
        ('device check runs and returns you to where you were', lambda d: d['check']['areas'] == 5 and d['check']['backInFoyer'] == 'foyer'),
        ('no sideways scroll on a phone', lambda d: d['m_startHScroll'] is False and d['m_peopleHScroll'] is False),
        *no_errors('errors', 'viewer_errors', 'check_errors', 'm_errors'),
    ],
    'test_round1': [
        ('names only from sign-in; impostors shown as Guest', lambda d: d['names'][1][2] == 'Guest'),
        ('activity kept across visits when reads are refused', lambda d: d['secondVisitSessions'] > d['loadedSessions']),
        ('reports are append-only records', lambda d: sum('/items/' in k for k in d['reportKeys']) >= 2),
        ('owner sees every report', lambda d: len(d['ownerReports']) == 3),
        *no_errors('errorsA', 'errorsB', 'errorsC'),
    ],
    'test_round2': [
        ('odd activity records cannot break the owner report', lambda d: len(d['activityRows']) >= 1 and d['errors3'] == []),
        ('recording keeps playing from the side of the plenary', lambda d: d['sideVideo']['paused'] is False),
        ('leaving pauses and mutes the recording', lambda d: d['afterLeaving'] == {'paused': True, 'muted': True, 'sound': False}),
        ('sound survives an open panel', lambda d: d['soundSurvivesPanel']['sound'] is True),
        ('photo while queuing keeps your place; you are served', lambda d: d['queuePhoto']['stillInLine'] and d['queuePhoto']['served'] == 1),
        ('Stop leaves the queue and you can rejoin', lambda d: d['stopLeavesQueue']['inLine'] is False and d['stopLeavesQueue']['canRejoin'] is True),
        ('Venue guide: current room marked, Walk and Go on one line', lambda d: d['guide']['sameLine'] and d['m_guide']['sameLine'] and d['m_guide']['hscroll'] is False),
        *no_errors('errors', 'm_errors'),
    ],
    'test_language_filter': [
        ('offensive words masked in chat; clean words untouched', lambda d: '••' in d['logShown'][1] and d['logShown'][-1] == 'see you at the cocktail reception'),
        ('three filtered messages alert the viewer', lambda d: d['flagged'] == 3 and 'keeps using' in d['toast']),
        ('your own messages are filtered before sending', lambda d: '••' in d['outgoingPresence']),
        ('owner settings saved for everyone and picked up', lambda d: '"mode":"hide"' in d['saved'] and d['attendeeCfg'] == 'hide'),
        ('hide mode hides messages and blocks sending', lambda d: 'hidden' in d['hiddenLog'][0] and 'Not sent' in d['outgoingBlocked'][0]),
        ('no sideways scroll on a phone', lambda d: d['m_hscroll'] is False),
        *no_errors('errors', 'errors2', 'm_errors'),
    ],
    'test_round3': [
        ('every panel: focus moves in, Tab stays in, Escape closes', lambda d: all(d['panels'].values())),
        ('device check cancels at once and puts you back', lambda d: d['cancelSeconds'] < 2 and d['afterCancel']['hidden'] and d['posRestored']),
        ('device check adds no visits', lambda d: d['zonesGainedDuringCheck'] == {}),
        ('20 talkers: 8 bubbles, 2 queued voices, partner always voiced', lambda d: d['bubblesShown'] <= 8 and d['voicesQueued'] <= 2 and d['targetVoiced'] is True),
        ('phone and chat buttons at least 40 px', lambda d: all(h >= 40 for _, h in d['m_hudHeights'] + d['m_chatHeights'])),
        ('name sharing can be changed in the Venue guide', lambda d: d['m_share']['first'] and d['m_share']['second'] and d['m_share']['saved'] == 'yes'),
        ('failed report explains and offers Copy report', lambda d: d['m_reportFail']['copyShown'] is True),
        ('no sideways scroll on a phone', lambda d: d['m_hscroll'] is False and d['m_guideHScroll'] is False),
        *no_errors('errors', 'm_errors'),
    ],
}

def run(name):
    t0 = time.time()
    p = subprocess.run([sys.executable, os.path.join(TESTS, name + '.py')], cwd=ROOT, capture_output=True, text=True, timeout=1500)
    out = p.stdout
    try:
        data = json.loads(out[out.index('{'):])
    except Exception:
        return None, (p.stderr or out)[-2000:], time.time() - t0
    return data, None, time.time() - t0

def main():
    want = sys.argv[1:]
    names = [n for n in SUITES if not want or any(w in n for w in want)]
    failed = 0
    if (not want or any(w in 'filter_unit' for w in want)) and shutil.which('node'):
        p = subprocess.run(['node', os.path.join(TESTS, 'filter_unit.js')], capture_output=True, text=True)
        ok = p.returncode == 0; failed += not ok
        print(f"\nfilter_unit\n  {'pass' if ok else 'FAIL'}  language filter catches every listed case and passes clean words")
    for n in names:
        data, err, secs = run(n)
        print(f'\n{n}  ({secs:.0f} s)')
        if data is None:
            failed += 1; print('  FAIL  suite did not finish\n' + '\n'.join('        ' + l for l in err.splitlines()[-15:])); continue
        for label, check in SUITES[n]:
            try: ok = bool(check(data))
            except Exception as e: ok = False; label += f'  ({type(e).__name__}: {e})'
            failed += not ok
            print(f"  {'pass' if ok else 'FAIL'}  {label}")
    print(f"\n{'All checks passed.' if not failed else f'{failed} check(s) failed.'}")
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
