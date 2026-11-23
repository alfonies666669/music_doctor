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
    var filters = eval(textFile(root+'/filters.js')+'\nMusicFilters;');
    var results = [], dir = ObjC.unwrap($.NSTemporaryDirectory()) + 'music-tags-native-' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
    function check(label, value) { if (!value) throw new Error('FAILED: ' + label); results.push('PASS ' + label); }
    try {
        var failedAsExpected = false;
        try { fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(dir + '/old'), true, null, null); }
        catch (e) { failedAsExpected = /NSNull.*count/.test(String(e)); }
        check('original NSNull/count regression reproduced', failedAsExpected);
        mkdir(dir); check('Objective-C nil directory creation', exists(dir));
        check('native genre normalization and exact matching', core.genreIDs(['1111111111111111','2222222222222222'],['Custom Hip-Hop','Russian Custom Hip-Hop'],' custom hip-hop ')[0]==='1111111111111111'&&core.genreIDs(['1111111111111111','2222222222222222'],['Custom Hip-Hop','Russian Custom Hip-Hop'],' custom hip-hop ').length===1);
        check('native genre CLI parsing', filters.parse(['--genre','Custom Hip-Hop',dir+'/genre.json']).kind==='genre');
        check('native preview without output and display limit',filters.parse(['--artist','1.kla$ OR Czar','--show','all']).output===null&&filters.parse(['--show','0']).show_limit===0);
        check('native console formatting',/1:02:03/.test(core.snapshotInfo([{name:'Song',artist:'Artist',duration:3723,favorite:true}],null)));
        var logical={all:[{any:[{artist:{contains:'1.kla$'}},{artist:{contains:'Czar'}}]},{not:{name:{contains:'remix'}}},{duration:{gte:0}}]};
        filters.validate(logical);
        check('native nested logical filter with literal dollar sign', filters.evaluate(logical,{artist:'1.Kla$ & Czar',name:'Example',duration:180})===true&&filters.evaluate(logical,{artist:'Czar',name:'Example Remix',duration:180})===false);
        var inlineArtists=filters.parse(['--artist','Bushido OR Fler',dir+'/or.json']).filter;
        var inlineExclude=filters.parse(['--artist','Bushido NOT Fler',dir+'/not.json']).filter;
        check('native inline OR includes both artists',filters.evaluate(inlineArtists,{artist:'Bushido'})===true&&filters.evaluate(inlineArtists,{artist:'Fler'})===true);
        check('native inline NOT excludes collaborations only',filters.evaluate(inlineExclude,{artist:'Bushido & Sido'})===true&&filters.evaluate(inlineExclude,{artist:'Bushido & Fler'})===false&&filters.evaluate(inlineExclude,{artist:'Fler'})===false);
        check('native duration parsing and stable sorting',filters.duration('3:00')===180&&filters.sort([{duration:3},{duration:1}],'duration',false)[0].duration===1);
        check('native negative duration rejection', (function(){try{filters.parse(['--min-duration','-1',dir+'/bad.json']);return false;}catch(_){return true;}}()));
        check('retired JSON filter option rejected before Music access', (function(){try{filters.parse(['--filter',dir+'/missing.json',dir+'/bad.json']);return false;}catch(e){return /Unknown snapshot option: --filter/.test(String(e));}}()));
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
        var audited=core.auditSnapshot({version:1,tracks:[{id:'2222222222222222',snapshot:state}]});
        check('native audit distinguishes cached Music cover and absent embedded cover',audited.artwork.inMusic===1&&audited.artwork.missingEmbedded===1&&audited.missing.compilation===0);
        var fakeIO={libraryID:function(){return '1111111111111111';},snapshot:function(){return state;}};
        fakeIO.candidates=function(){return {rows:[{id:'2222222222222222',name:metadata.name,artist:metadata.artist,album:'',year:0,duration:10,favorite:false}],favorite_property:'favorited'};};
        fakeIO.capture=function(){return state;};
        var exported=snapshotCommand(filters.parse(['--all','--show','0',dir+'/editable.json']),fakeIO,core,filters);
        var draft=core.validateRequest(JSON.parse(textFile(dir+'/editable.json')));
        check('native snapshot exports a directly editable request',/Saved editable request/.test(exported)&&draft.tracks[0].set.album===null&&draft.tracks[0].set.lyrics===null&&draft.tracks[0].info.duration===10);
        draft.tracks[0].set.album='Correct Album';
        prepareRequest(draft,dir+'/editable.json',dir+'/run/editable-plan.json',fakeIO,core);
        var draftPlan=core.validatePlan(JSON.parse(textFile(dir+'/run/editable-plan.json')));
        check('native request roundtrip plans only the explicit album edit',JSON.stringify(draftPlan.tracks[0].set)===JSON.stringify({album:'Correct Album'})&&draftPlan.tracks[0].artwork===null);
        draftPlan.tracks[0].set.album=null;
        check('execution plans still reject null writes',(function(){try{core.validatePlan(draftPlan);return false;}catch(e){return /invalid type/.test(String(e));}}()));
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
