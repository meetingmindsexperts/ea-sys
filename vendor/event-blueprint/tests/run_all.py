"""Run every Event Blueprint browser test and check the results.

    python3 tests/run_all.py            # all suites
    python3 tests/run_all.py flow owners  # only suites whose name contains these words

Each suite drives the real page in headless Chromium (Playwright) against a mock of the
hosting runtime (tests/mock.js), prints what it saw as JSON, and this runner checks it.
Exit code 0 = everything passed.
"""
import json, os, re, subprocess, sys, time

TESTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TESTS)

def no_errors(*keys):
    return [(f'no console errors ({k})', lambda d, k=k: d.get(k) == []) for k in keys]

SUITES = {
    'test_mic': [  # EA-SYS (Oct 9 2026): the Speak button in Talk it through, with a fake speech engine
        ('listening: Stop shown, language locked, continuous with live words', lambda d: d['listening']['btn'] == 'Stop' and d['listening']['pressed'] == 'true' and d['listening']['langOff'] is True and d['listening']['continuous'] is True and d['listening']['interim'] is True and d['listening']['lang'] == 'en-GB'),
        ('words appear as heard, after what was typed', lambda d: d['interim']['text'] == 'Gala dinner. for four hundred' and d['final']['text'] == 'Gala dinner. for four hundred guests in Dubai '),
        ('a pause does not stop listening', lambda d: d['afterPause']['started'] == 2 and d['afterPause']['btn'] == 'Stop'),
        ('Stop stops it and keeps the words', lambda d: d['stopped']['btn'] == 'Speak' and d['stopped']['stopped'] == 1 and d['stopped']['langOff'] is False and 'four hundred guests' in d['stopped']['text']),
        ('the spoken words reach the AI', lambda d: d['promptHasSpeech'] is True),
        ('Arabic is passed to the browser', lambda d: d['arabic']['lang'] == 'ar-AE'),
        ('closing the box stops listening', lambda d: d['closed']['stopped'] >= 1 and d['closed']['hidden'] is True),
        ('a blocked microphone says so and does not retry', lambda d: 'blocked' in d['blocked']['note'] and d['blocked']['btn'] == 'Speak' and d['blocked']['started'] == 1),
        ('no speech recognition: dictation hint, no button', lambda d: d['unsupported'] == {'button': False, 'hint': True}),
        *no_errors('errors'),
    ],
    'test_flow': [  # quick fill from a PDF and an image, submission, change tracking, approvals, templates, device-only mode
        ('quick fill sends the typed words', lambda d: d['qfPromptHasWords'] is True),
        ('quick fill reads the PDF text', lambda d: d['qfPromptHasPdfText'] is True),
        ('AI answer applied (type, spaces, programme)', lambda d: d['applied']['type'] == 'gala' and d['applied']['spaces'] == 2 and d['applied']['prog'] == 3),
        ('unknown language from the AI is dropped', lambda d: 'Klingon' not in d['languagesFiltered']),
        ('submission gets a reference', lambda d: re.match(r'^EB-\d{6}-[A-Z0-9]{3}$', d['ack']['ref'] or '') is not None),
        ('tracker shows Submitted', lambda d: d['trackerNow'] == 'Submitted'),
        ('a later edit is listed as not yet sent', lambda d: len(d['pending']) == 1 and 'Attendance' in d['pending'][0]),
        ('sending the update clears it', lambda d: d['pendingAfter'] == 0),
        ('build team can approve', lambda d: d['afterApprove'][0] == 'building'),
        ('no sideways scroll on a phone', lambda d: d['hScroll'] is False),
        *no_errors('errors', 'mErrors'),
    ],
    'test_checks_sketch': [  # starter packs, reality checks, layout sketch
        ('starter pack fills 5 programme items', lambda d: d['packFilled']['prog'] == 5),
        ('a too-small ballroom is flagged', lambda d: any('Ballroom' in c[1] for c in d['spaceChecks'])),
        ('sketch draws every room', lambda d: d['sketchRooms'] == 5),
        ('room rotate, drag and keyboard move are saved', lambda d: d['rotSaved'].get('rot') is True and 'x' in d['dragSaved'] and 'x' in d['keySaved']),
        ('sketch downloads as a PNG', lambda d: d['png']['bytes'] > 10000),
        ('brief includes the checks', lambda d: d['mdHasChecks'] is True),
        ('no sideways scroll (desktop and phone)', lambda d: d['hscroll'] is False and d['m_hscroll'] is False),
        *no_errors('errors', 'm_errors'),
    ],
    'test_security': [  # first audit: planted markup in templates and blueprints, other people's templates
        ('planted template cannot run code', lambda d: d['pwned_template'] == 0),
        ('planted blueprint cannot run code', lambda d: d['pwned_blueprint'] == 0),
        ("other people's templates are not listed", lambda d: d['otherOwnersTemplateListed'] is False),
        *no_errors('errors'),
    ],
    'test_checks_edge': [  # first audit: accepted checks reopen when worse, duplicate names, date reading
        ('accepted check reopens when it gets worse', lambda d: any('changed since you accepted' in x for x in d['afterWorse'])),
        ('duplicate space names flagged', lambda d: any('Two or more spaces' in x for x in d['dupes'])),
        ('dates read correctly (12/03/2027)', lambda d: 'March 2027' in d['when:12/03/2027']),
        ('no sideways scroll', lambda d: d['hscroll'] is False),
        *no_errors('errors'),
    ],
    'test_owners': [  # section owners
        ('bad email refused', lambda d: 'look right' in (d['badEmail'] or '')),
        ('owner shows in steps and table', lambda d: d['badge'] and len(d['table']) == 2),
        ('owners in the brief', lambda d: d['md'] is True and d['m_md'] is True),
        ('change list names owner changes', lambda d: any('Owner of' in x for x in d['pending'])),
        ('loaded owners are sanitised', lambda d: 'javascript' not in d['sanitised']),
        ('no sideways scroll (desktop and phone)', lambda d: d['hscroll'] is False and d['m_hscroll'] is False),
        *no_errors('errors', 'm_errors'),
    ],
    'test_round3': [  # second audit, round 3
        ('typing stays smooth with 40 spaces and 300 partners (4x slower CPU)', lambda d: max(d['typing']['longtasks'] or [0]) < 100),
        ('off-screen sketch catches up when scrolled to', lambda d: d['sketchCatchesUp'] is True),
        ('owner form: focus in, Escape cancels, focus back', lambda d: d['formFocus'] == 'Owner name' and d['escape']['formGone'] and d['escape']['noOwner'] and d['afterSaveFocus'] == 'Change'),
        ('same-name owners kept apart', lambda d: len(d['table']) == 2 and len(set(d['table'])) == 2),
        ('email-only owner change is tracked', lambda d: any('email' in x for x in d['pendingEmail'])),
        ('long owner names wrap', lambda d: d['m_ownerOverflow'] is False),
        ('all tap targets at least 40 px on a phone', lambda d: d['m_small'] == []),
        ('no sideways scroll on a phone', lambda d: d['m_hscroll'] is False),
        *no_errors('errors1', 'errors2', 'm_errors'),
    ],
}

def run(name):
    t0 = time.time()
    p = subprocess.run([sys.executable, os.path.join(TESTS, name + '.py')], cwd=ROOT, capture_output=True, text=True, timeout=900)
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
