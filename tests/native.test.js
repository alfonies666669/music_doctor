/* macOS regression test: no Music Apple events and no music writes.
   osascript -l JavaScript tests/native.test.js /absolute/music-tags-tool [audio-file]
*/
ObjC.import('Foundation');
function run(argv) {
    var root = argv[0];
    if (!root || root[0] !== '/') throw new Error('Pass the absolute music-tags-tool directory');
    var source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(root + '/jxa.js'), $.NSUTF8StringEncoding, null));
    eval(source.slice(0, source.indexOf('function run(argv)')));
    var core = eval(textFile(root+'/core.js')+'\nMusicMVP;');
    var results = [], dir = ObjC.unwrap($.NSTemporaryDirectory()) + 'music-tags-native-' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
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
        var words='\ufeffExample first line\r\nExample second line\r\n';
        $(words).writeToFileAtomicallyEncodingError($(dir+'/words.txt'),true,$.NSUTF8StringEncoding,null);
        check('UTF-8 lyrics file and newline normalization',lyricsFile(dir+'/words.txt',core)==='Example first line\nExample second line');
        var png=$.NSData.alloc.initWithBase64EncodedStringOptions('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLE8AAAAASUVORK5CYII=',0);
        png.writeToFileAtomically($(dir+'/cover.png'),true);
        check('local PNG validation',imageInfo(dir+'/cover.png').format==='png');
        var request={version:1,defaults:{genre:'Custom Genre'},tracks:[{id:'2222222222222222',expect:{name:'Example Song',artist:'Example Artist'},lyrics_file:'words.txt',artwork_file:'cover.png'}]};
        core.validateRequest(request);validateAssets(request,dir+'/request.json',core);
        var metadata={};Object.keys(core.fields).forEach(function(k){metadata[k]=core.fields[k]==='string'?'':core.fields[k]==='number'?0:false;});
        metadata.name='Example Song';metadata.artist='Example Artist';
        var state={metadata:metadata,path:dir+'/fixture.mp3',sha256:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',artwork_count:1,file_artwork_present:false,duration:10};
        var fakeIO={libraryID:function(){return '1111111111111111';},snapshot:function(){return state;}};
        prepareRequest(request,dir+'/request.json',dir+'/run/plan.json',fakeIO,core);
        var plan=core.validatePlan(JSON.parse(textFile(dir+'/run/plan.json')));
        check('native prepare with TXT and cached cover, no Music writes',plan.tracks[0].set.lyrics==='Example first line\nExample second line'&&plan.tracks[0].artwork.policy==='embed_missing');
        check('cover is copied into the local plan assets',exists(plan.tracks[0].artwork.path)&&plan.tracks[0].artwork.path.indexOf(dir+'/run/plan.json.assets/')===0);
        metadata.lyrics='Existing words';
        request.tracks[0].artwork_file=undefined;request.tracks[0].lyrics_file=undefined;request.tracks[0].lyrics_url='https://example.invalid/never-fetched.txt';
        prepareRequest(request,dir+'/request.json',dir+'/run/preserve.json',fakeIO,core);
        var preserved=JSON.parse(textFile(dir+'/run/preserve.json'));
        check('existing lyrics skip network fetching and remain unchanged',preserved.tracks[0].set.lyrics===undefined);
        request.tracks[0].expect.name='Different';
        var preparationFailed=false;
        try{prepareRequest(request,dir+'/request.json',dir+'/run/fail.json',fakeIO,core);}catch(e){preparationFailed=true;}
        check('failed preparation cleans only its own temporary assets',preparationFailed&&!exists(dir+'/run/fail.json.assets')&&!exists(dir+'/run/fail.json')&&exists(dir+'/run/plan.json'));
        if (argv[1]) {
            var entries = fileMetadata(argv[1]);
            check('AVURLAsset runtime resolution and direct file read', entries.length > 0);
            var title = entries.filter(function (e) { return e.common_key === 'title'; })[0];
            if (title) check('direct file verification', verifyFile(argv[1], {name: title.value}, false).ok);
            var text=entries.filter(function(e){return /^(id3\/(USLT|ULT)|itsk\/©lyr)$/.test(e.identifier)&&typeof e.value==='string'&&e.value.trim();})[0];
            if(text)check('existing file lyrics verification',verifyFile(argv[1],{lyrics:core.normalizeLyrics(text.value)},false).ok);
        }
        return results.join('\n') + '\nNo Music fields changed.';
    } finally { if (exists(dir)) fm.removeItemAtPathError($(dir), null); }
}
