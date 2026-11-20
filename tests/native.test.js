/* macOS regression test: no Music Apple events and no music writes.
   osascript -l JavaScript tests/native.test.js /absolute/music-mvp [audio-file]
*/
ObjC.import('Foundation');
function run(argv) {
    var root = argv[0];
    if (!root || root[0] !== '/') throw new Error('Pass the absolute music-mvp directory');
    var source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(root + '/jxa.js'), $.NSUTF8StringEncoding, null));
    eval(source.slice(0, source.indexOf('function run(argv)')));
    var results = [], dir = ObjC.unwrap($.NSTemporaryDirectory()) + 'music-mvp-native-' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
    function check(label, value) { if (!value) throw new Error('FAILED: ' + label); results.push('PASS ' + label); }
    try {
        var failedAsExpected = false;
        try { fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(dir + '/old'), true, null, null); }
        catch (e) { failedAsExpected = /NSNull.*count/.test(String(e)); }
        check('original NSNull/count regression reproduced', failedAsExpected);
        mkdir(dir); check('Objective-C nil directory creation', exists(dir));
        saveJSON(dir + '/data.json', {ok: true}, false);
        check('JSON roundtrip', JSON.parse(textFile(dir + '/data.json')).ok);
        check('NSTask launch / wait and stdout', task('/usr/bin/printf', ['native-ok']) === 'native-ok');
        check('file checksum subprocess', /^[a-f0-9]{64}$/.test(sha(dir + '/data.json')));
        var errorCaught = false;
        try { task('/usr/bin/false', []); } catch (_) { errorCaught = true; }
        check('nonzero subprocess exit is reported', errorCaught);
        if (argv[1]) {
            var entries = fileMetadata(argv[1]);
            check('AVURLAsset runtime resolution and direct file read', entries.length > 0);
            var title = entries.filter(function (e) { return e.common_key === 'title'; })[0];
            if (title) check('direct file verification', verifyFile(argv[1], {name: title.value}, false).ok);
        }
        return results.join('\n') + '\nNo Music fields changed.';
    } finally { if (exists(dir)) fm.removeItemAtPathError($(dir), null); }
}
