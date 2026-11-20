/* macOS-only adapter. Run with the adjacent music-mvp launcher. */
ObjC.import('Foundation');
ObjC.import('AppKit');
var TOOL_VERSION = '0.3.0';
var fm = $.NSFileManager.defaultManager;

function textFile(path) {
    var value = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
    if (!value) throw new Error('Cannot read: ' + path);
    return ObjC.unwrap(value);
}
function absolute(path) {
    var s = $(path).stringByExpandingTildeInPath;
    if (!ObjC.unwrap(s).startsWith('/')) s = $(ObjC.unwrap(fm.currentDirectoryPath) + '/' + ObjC.unwrap(s));
    return ObjC.unwrap(s.stringByStandardizingPath);
}
function exists(path) { return Boolean(fm.fileExistsAtPath($(path))); }
function mkdir(path) {
    // Object arguments need Objective-C nil. JS null bridges to NSNull.
    if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(path), true, $(), null)) throw new Error('Cannot create directory: ' + path);
}
function saveJSON(path, value, replace) {
    if (!replace && exists(path)) throw new Error('Output already exists: ' + path);
    if (!$(JSON.stringify(value, null, 2) + '\n').writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, null)) throw new Error('Cannot write: ' + path);
}
function task(program, args) {
    var t = $.NSTask.alloc.init, pipe = $.NSPipe.pipe;
    t.launchPath = $(program); t.arguments = $(args); t.standardOutput = pipe;
    // stderr is inherited. Draining before wait avoids a full stdout pipe deadlock.
    t.launch;
    var data = pipe.fileHandleForReading.readDataToEndOfFile;
    t.waitUntilExit;
    var output = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
    if (t.terminationStatus !== 0) throw new Error(program + ' failed (exit ' + t.terminationStatus + ')');
    return output;
}
function sha(path) { return task('/usr/bin/shasum', ['-a', '256', '--', path]).slice(0, 64); }
function norm(s) { return String(s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim(); }
function imageInfo(path, expectedFormat) {
    var data = $.NSData.dataWithContentsOfFile($(path));
    if (!data || Number(data.length) > 15000000) throw new Error('Image is missing or exceeds 15 MB: ' + path);
    var prefix = ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    var format = prefix.indexOf('/9j/') === 0 ? 'jpg' : (prefix.indexOf('iVBORw0KGgo') === 0 ? 'png' : null);
    var image = $.NSImage.alloc.initWithData(data);
    if (!format || (expectedFormat && format !== expectedFormat) || !image || image.size.width <= 0 || image.size.height <= 0) throw new Error('Expected a valid JPEG/PNG: ' + path);
    return {format: format, width: image.size.width, height: image.size.height};
}
function relativeFile(requestPath, path) {
    return path[0] === '/' ? absolute(path) : absolute(ObjC.unwrap($(requestPath).stringByDeletingLastPathComponent) + '/' + path);
}
function lyricsFile(path, core) {
    var attrs = fm.attributesOfItemAtPathError($(path), null);
    if (!attrs || Number(ObjC.unwrap(attrs.objectForKey($.NSFileSize))) > 400000) throw new Error('Lyrics TXT is missing or exceeds 400 KB: ' + path);
    return core.lyricsText(textFile(path));
}
function remoteLyrics(url, core) {
    var path = ObjC.unwrap($.NSTemporaryDirectory()) + 'music-tags-lyrics-' + ObjC.unwrap($.NSUUID.UUID.UUIDString) + '.txt';
    try {
        var mime = task('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '30', '--max-filesize', '400000', '--silent', '--show-error', '--write-out', '%{content_type}', '--output', path, url]);
        if (!/^text\/plain(?:;|$)/i.test(mime.trim())) throw new Error('lyrics_url must return text/plain, not a web page');
        return lyricsFile(path, core);
    } finally { if (exists(path)) fm.removeItemAtPathError($(path), null); }
}
function fileMetadata(path) {
    ObjC.import('AVFoundation');
    // Some macOS bridge metadata omits AVURLAsset; resolve its runtime class.
    var URLAsset = $.NSClassFromString('AVURLAsset');
    var asset = URLAsset.URLAssetWithURLOptions($.NSURL.fileURLWithPath($(path)), $());
    var entries = [], formats = asset.availableMetadataFormats;
    function append(items) {
        for (var i = 0; i < Number(items.count); i++) {
            var item = items.objectAtIndex(i), value = null, number = null, binary = null;
            try { if (item.stringValue) value = ObjC.unwrap(item.stringValue); } catch (_) {}
            var identifier = item.identifier ? ObjC.unwrap(item.identifier) : '';
            try { if (item.numberValue) number = Number(ObjC.unwrap(item.numberValue)); } catch (_) {}
            if (identifier === 'itsk/trkn' || identifier === 'itsk/disk') {
                try { if (item.dataValue) binary = ObjC.unwrap(item.dataValue.base64EncodedStringWithOptions(0)); } catch (_) {}
            }
            entries.push({identifier: identifier, common_key: item.commonKey ? ObjC.unwrap(item.commonKey) : '', value: value, number_value: number, data_base64: binary});
        }
    }
    append(asset.commonMetadata);
    for (var f = 0; f < Number(formats.count); f++) append(asset.metadataForFormat(formats.objectAtIndex(f)));
    return entries;
}
function verifyFile(path, values, artAdded) {
    var entries;
    try { entries = fileMetadata(path); }
    catch (e) { return {ok: false, error: String(e), fields: {}}; }
    var aliases = {
        name: ['title', 'id3/TIT2', 'id3/TT2', 'itsk/©nam'], artist: ['artist', 'id3/TPE1', 'id3/TP1', 'itsk/©ART'],
        album: ['albumName', 'id3/TALB', 'id3/TAL', 'itsk/©alb'], albumArtist: ['id3/TPE2', 'id3/TP2', 'itsk/aART'],
        composer: ['id3/TCOM', 'id3/TCM', 'itsk/©wrt'], genre: ['type', 'id3/TCON', 'id3/TCO', 'itsk/©gen'],
        year: ['creationDate', 'id3/TDRC', 'id3/TYER', 'id3/TYE', 'itsk/©day'],
        trackNumber: ['id3/TRCK', 'id3/TRK', 'itsk/trkn'], trackCount: ['id3/TRCK', 'id3/TRK', 'itsk/trkn'],
        discNumber: ['id3/TPOS', 'id3/TPA', 'itsk/disk'], discCount: ['id3/TPOS', 'id3/TPA', 'itsk/disk'], compilation: ['id3/TCMP', 'id3/TCP', 'itsk/cpil'],
        lyrics: ['id3/USLT', 'id3/ULT', 'itsk/©lyr']
    };
    var results = {}, ok = true;
    Object.keys(values).forEach(function (k) {
        var found = entries.filter(function (e) { return aliases[k].indexOf(e.identifier) >= 0 || aliases[k].indexOf(e.common_key) >= 0; });
        var candidates = found.map(function (e) {
            var v = e.value;
            if (v === null && typeof e.number_value === 'number') v = String(e.number_value);
            if (e.data_base64 && /^(track|disc)(Number|Count)$/.test(k)) {
                var alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes=[], bits=0, buffer=0;
                e.data_base64.replace(/=+$/,'').split('').forEach(function(c){var n=alphabet.indexOf(c);if(n<0)return;buffer=(buffer<<6)|n;bits+=6;if(bits>=8){bits-=8;bytes.push((buffer>>bits)&255);}});
                if (bytes.length>=6) return /Count$/.test(k) ? bytes[4]*256+bytes[5] : bytes[2]*256+bytes[3];
            }
            if (v === null) return null;
            if (k === 'lyrics') return String(v).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\n+$/,'');
            if (k === 'year') return parseInt(v, 10);
            if (k === 'trackCount' || k === 'discCount') return parseInt(String(v).split('/')[1], 10);
            if (k === 'trackNumber' || k === 'discNumber') return parseInt(v, 10);
            if (k === 'compilation') return v === '1' || v === 'true';
            return v;
        });
        var matched = candidates.some(function (v) { return v === values[k]; });
        results[k] = {expected: values[k], observed: candidates, verified: matched}; if (!matched) ok = false;
    });
    if (artAdded) {
        results.artwork = {verified: entries.some(function (e) { return e.common_key === 'artwork' || e.identifier === 'id3/APIC' || e.identifier === 'id3/PIC' || e.identifier === 'itsk/covr'; })};
        if (!results.artwork.verified) ok = false;
    }
    return {ok: ok, fields: results, reader: 'AVFoundation (direct file, not Spotlight)'};
}
function musicIO(core, root) {
    var music = Application('com.apple.Music');
    var library = music.libraryPlaylists[0];
    if (!library.exists()) throw new Error('Music library playlist is unavailable');
    function track(pid) {
        var matches = library.fileTracks.whose({persistentID: core.id(pid)})();
        if (matches.length !== 1) throw new Error('Local file track not found or not unique: ' + pid);
        return matches[0];
    }
    function snapshot(pid) {
        var t = track(pid), location = t.location();
        if (!location) throw new Error('Track has no local file: ' + pid);
        var path = String(location);
        if (!/\.(mp3|m4a)$/i.test(path) || !exists(path) || /protected|Apple Music/i.test(t.kind())) throw new Error('Only accessible, unprotected local MP3/M4A: ' + pid);
        var values = {};
        Object.keys(core.fields).forEach(function (k) { values[k] = t[k](); });
        var fileEntries = fileMetadata(path);
        var embedded = fileEntries.some(function(e) { return e.common_key === 'artwork' || /id3\/(APIC|PIC)|itsk\/covr/.test(e.identifier); });
        var fileLyrics = fileEntries.filter(function(e) { return /^(id3\/(USLT|ULT)|itsk\/©lyr)$/.test(e.identifier) && typeof e.value === 'string' && e.value.trim(); });
        values.lyrics = core.normalizeLyrics(values.lyrics || (fileLyrics.length ? fileLyrics[0].value : ''));
        return {metadata: values, path: path, sha256: sha(path), duration: t.duration(), artwork_count: t.artworks.length, file_artwork_present: embedded};
    }
    return {
        libraryID: function () { return core.id(library.persistentID()); },
        snapshot: snapshot,
        writeField: function (pid, k, v) { track(pid)[k] = v; },
        readField: function (pid, k) { var value=track(pid)[k]();return k==='lyrics'?core.normalizeLyrics(value):value; },
        checkArtwork: function (a) { if (!exists(a.path) || sha(a.path) !== a.sha256) throw new Error('Artwork changed or missing: ' + a.path); imageInfo(a.path, a.format); },
        addArtwork: function (pid, a) { this.checkArtwork(a); task('/usr/bin/osascript', [root + '/artwork.applescript', pid, a.path, a.format, a.policy || 'missing']); },
        verifyFile: verifyFile,
        playlist: function (name) {
            if (name === '--all') return library.tracks.persistentID();
            var p = music.playlists.whose({name: name})();
            if (p.length !== 1) throw new Error('Playlist name must identify exactly one playlist');
            return p[0].tracks.persistentID();
        },
        version: function () { return music.version(); }
    };
}
function usage() {
    return 'Music Tags '+TOOL_VERSION+' — macOS, local MP3/M4A, no external packages\n' +
        '  ./music-tags doctor\n' +
        '  ./music-tags snapshot "Playlist name" snapshot.json  (or --all)\n' +
        '  ./music-tags validate request.json\n' +
        '  ./music-tags prepare request.json runs/plan.json\n' +
        '  ./music-tags preview runs/plan.json\n' +
        '  ./music-tags apply runs/plan.json\n' +
        '  ./music-tags status runs/plan.json\n' +
        '  ./music-tags inspect runs/plan.json\n' +
        'Only apply writes music. Text/cover data must be supplied in the request.';
}
function validateAssets(request, requestPath, core) {
    request.tracks.forEach(function(t) {
        if (t.artwork_file) {
            var a = typeof t.artwork_file === 'string' ? {path:t.artwork_file} : t.artwork_file;
            var path = relativeFile(requestPath,a.path);
            imageInfo(path,a.format);
            if(a.sha256 && sha(path)!==a.sha256) throw new Error('Artwork checksum mismatch: '+t.id);
        }
        if(t.lyrics_file) lyricsFile(relativeFile(requestPath,t.lyrics_file),core);
    });
}
function prepareRequest(request, requestPath, output, io, core) {
    var assets=output+'.assets';
    if(exists(output)||exists(assets)) throw new Error('Output already exists; choose a new plan filename');
    mkdir(ObjC.unwrap($(output).stringByDeletingLastPathComponent));
    mkdir(assets);
    var plan={version:1,kind:'music-tags-plan',created_at:new Date().toISOString(),library_id:io.libraryID(),tracks:[]};
    try {
        request.tracks.forEach(function(original,index) {
            var t=JSON.parse(JSON.stringify(original)),pid=core.id(t.id);
            console.log('Preparing '+(index+1)+'/'+request.tracks.length+' ['+pid+']');
            try {
                var before=io.snapshot(pid);
                if((t.lyrics_file||t.lyrics_url) && (!before.metadata.lyrics.trim()||t.lyrics_policy==='replace')) {
                    var lyrics=t.lyrics_file?lyricsFile(relativeFile(requestPath,t.lyrics_file),core):remoteLyrics(t.lyrics_url,core);
                    var mode=t.lyrics_policy==='replace'?'set':'fill';
                    t[mode]=t[mode]||{};t[mode].lyrics=lyrics;
                    if(t.lyrics_url){t.sources=t.sources||[];if(t.sources.indexOf(t.lyrics_url)<0)t.sources.push(t.lyrics_url);}
                }
                var updates=core.changes(t,before.metadata,request.defaults||{}),cover=null;
                if(t.artwork_file && !before.file_artwork_present) {
                    if(before.artwork_count>1) throw new Error('Multiple Music pictures; review manually');
                    var local=typeof t.artwork_file==='string'?{path:t.artwork_file}:t.artwork_file;
                    var albumName=updates.album||before.metadata.album;
                    if(local.album && norm(local.album)!==norm(albumName)) throw new Error('Artwork album does not match target album');
                    var sourcePath=relativeFile(requestPath,local.path),info=imageInfo(sourcePath,local.format),hash=sha(sourcePath);
                    if(local.sha256 && local.sha256!==hash) throw new Error('Artwork checksum mismatch');
                    var copy=assets+'/'+pid+'.'+info.format;
                    task('/bin/cp',[sourcePath,copy]);
                    if(sha(copy)!==hash) throw new Error('Artwork changed while copying');
                    cover={path:copy,sha256:hash,format:info.format,policy:'embed_missing'};
                    if(local.source_url)cover.source_url=local.source_url;
                }
                plan.tracks.push({id:pid,before:before,set:updates,artwork:cover,sources:t.sources||[]});
            } catch(e) { throw new Error('Track '+pid+': '+String(e.message||e)); }
        });
        core.validatePlan(plan);
        saveJSON(output,plan,false);
        return core.preview(plan)+'\n\nSaved: '+output+'\nNo Music fields changed.';
    } catch(e) {
        // This directory was created by this invocation; never remove user data.
        fm.removeItemAtPathError($(assets),null);
        throw e;
    }
}
function run(argv) {
    var root=argv.shift(),core=eval(textFile(root+'/core.js')+'\nMusicMVP;'),command=argv.shift();
    if(!command||command==='help'||command==='--help')return usage();
    if(command==='--version'||command==='version')return TOOL_VERSION;
    var required={doctor:0,snapshot:2,validate:1,prepare:2,preview:1,apply:1,status:1,inspect:1};
    if(!Object.prototype.hasOwnProperty.call(required,command)||argv.length!==required[command])throw new Error(usage());
    if(command==='validate'||command==='prepare') {
        var requestPath=absolute(argv[0]),request=core.validateRequest(JSON.parse(textFile(requestPath)));
        validateAssets(request,requestPath,core);
        if(command==='validate')return 'Valid request: '+request.tracks.length+' tracks. No Music access or changes.';
        return prepareRequest(request,requestPath,absolute(argv[1]),musicIO(core,root),core);
    }
    if(command==='preview')return core.preview(JSON.parse(textFile(absolute(argv[0]))));
    if(command==='status') {
        var planPath=absolute(argv[0]),plan=core.validatePlan(JSON.parse(textFile(planPath))),journalPath=planPath+'.journal.json';
        if(!exists(journalPath))return JSON.stringify({status:'not_applied',total:plan.tracks.length},null,2);
        var log=JSON.parse(textFile(journalPath));
        return JSON.stringify({status:log.status,verified:log.tracks.filter(function(t){return t.status==='verified';}).length,total:plan.tracks.length,plan_matches:log.plan_sha256===sha(planPath),error:log.error||null},null,2);
    }
    var io;
    if(command==='doctor'||command==='snapshot')io=musicIO(core,root);
    if(command==='doctor')return JSON.stringify({tool_version:TOOL_VERSION,music_version:io.version(),library_playlist_id:io.libraryID(),note:'Connection only; not a unique library fingerprint.'},null,2);
    if(command==='snapshot') {
        var ids=io.playlist(argv[0]),seen={},rows=[];
        ids.forEach(function(pid,index) {
            if(seen[pid])return;seen[pid]=true;
            if(index%25===0)console.log('Reading '+(index+1)+'/'+ids.length);
            try{rows.push({id:pid,snapshot:io.snapshot(pid)});}
            catch(e){rows.push({id:pid,error:String(e.message||e)});}
        });
        var destination=absolute(argv[1]);
        mkdir(ObjC.unwrap($(destination).stringByDeletingLastPathComponent));
        saveJSON(destination,{version:1,library_playlist_id:io.libraryID(),playlist:argv[0],tracks:rows},false);
        return 'Snapshot: '+destination+' ('+rows.length+' records)';
    }
    var path=absolute(argv[0]),p=core.validatePlan(JSON.parse(textFile(path)));
    if(command==='inspect'){
        io=musicIO(core,root);
        return JSON.stringify(p.tracks.map(function(t){var s=io.snapshot(t.id);return{id:t.id,music:s,file_metadata:fileMetadata(s.path)};}),null,2);
    }
    var journal=path+'.journal.json',backups=path+'.backups',planHash=sha(path);
    if(exists(journal)) {
        var old=JSON.parse(textFile(journal));
        if(old.status==='complete'&&old.plan_sha256===planHash)return 'Already complete; no changes applied. Journal: '+journal;
        throw new Error('Journal exists. Inspect status and prepare a NEW plan after a partial failure.');
    }
    if(exists(backups))throw new Error('Backup directory already exists');
    io=musicIO(core,root);
    var lock=ObjC.unwrap($.NSTemporaryDirectory())+'music-tags-'+ObjC.unwrap($.NSUserName())+'.lock';
    task('/bin/mkdir',[lock]);
    try {
        io.record=function(log){log.plan_sha256=planHash;saveJSON(journal,log,true);};
        io.backup=function(file,index,hash){
            mkdir(backups);var target=backups+'/'+index+'-'+ObjC.unwrap($(file).lastPathComponent);
            task('/bin/cp',['-p',file,target]);
            if(sha(target)!==hash||sha(file)!==hash)throw new Error('File changed while backing up');
            return target;
        };
        var log=core.execute(p,io);
        return 'Verified: '+log.tracks.length+' tracks. Journal: '+journal;
    } finally {task('/bin/rmdir',[lock]);}
}
