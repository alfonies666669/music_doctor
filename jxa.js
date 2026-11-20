/* macOS-only adapter. Run with the adjacent music-mvp launcher. */
ObjC.import('Foundation');
ObjC.import('AppKit');
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
function fetch(url, destination) {
    if (!/^https:\/\//.test(url)) throw new Error('HTTPS is required');
    task('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '30', '--max-filesize', '15000000', '--silent', '--show-error', '--output', destination, url]);
}
function jsonURL(url) {
    var path = ObjC.unwrap($.NSTemporaryDirectory()) + 'music-mvp-' + ObjC.unwrap($.NSUUID.UUID.UUIDString) + '.json';
    try { fetch(url, path); return JSON.parse(textFile(path)); }
    finally { if (exists(path)) fm.removeItemAtPathError($(path), null); }
}
function norm(s) { return String(s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim(); }
function catalogue(id) {
    var result = jsonURL('https://itunes.apple.com/lookup?id=' + encodeURIComponent(id) + '&entity=song&country=fr');
    var songs = (result.results || []).filter(function (s) { return s.kind === 'song' && s.trackId === id; });
    if (songs.length !== 1) throw new Error('Catalogue song ID not found in FR: ' + id);
    return songs[0];
}
function artwork(song, directory, pid) {
    if (!song.artworkUrl100 || !/^https:\/\/[^/]*mzstatic\.com\//.test(song.artworkUrl100)) throw new Error('No supported Apple artwork URL');
    var url = song.artworkUrl100.replace(/100x100[^/]*\.(jpg|png)(\?.*)?$/, '1000x1000bb.jpg');
    var path = directory + '/' + pid + '.jpg';
    fetch(url, path);
    var data = $.NSData.dataWithContentsOfFile($(path));
    var prefix = ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    var format = prefix.indexOf('/9j/') === 0 ? 'jpg' : (prefix.indexOf('iVBORw0KGgo') === 0 ? 'png' : null);
    var image = $.NSImage.alloc.initWithData(data);
    if (!format || !image || image.size.width < 500 || image.size.height < 500) throw new Error('Artwork must be a valid JPEG/PNG, at least 500 × 500');
    if (format === 'png') { var png = directory + '/' + pid + '.png'; task('/bin/mv', [path, png]); path = png; }
    return {path: path, sha256: sha(path), format: format, source_url: url, catalog_id: song.trackId};
}
function fileMetadata(path) {
    ObjC.import('AVFoundation');
    // Some macOS bridge metadata omits AVURLAsset; resolve its runtime class.
    var URLAsset = $.NSClassFromString('AVURLAsset');
    var asset = URLAsset.URLAssetWithURLOptions($.NSURL.fileURLWithPath($(path)), $());
    var entries = [], formats = asset.availableMetadataFormats;
    function append(items) {
        for (var i = 0; i < Number(items.count); i++) {
            var item = items.objectAtIndex(i), value = null;
            try { if (item.stringValue) value = ObjC.unwrap(item.stringValue); } catch (_) {}
            entries.push({identifier: item.identifier ? ObjC.unwrap(item.identifier) : '', common_key: item.commonKey ? ObjC.unwrap(item.commonKey) : '', value: value});
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
        discNumber: ['id3/TPOS', 'id3/TPA', 'itsk/disk'], discCount: ['id3/TPOS', 'id3/TPA', 'itsk/disk'], compilation: ['id3/TCMP', 'id3/TCP', 'itsk/cpil']
    };
    var results = {}, ok = true;
    Object.keys(values).forEach(function (k) {
        var found = entries.filter(function (e) { return aliases[k].indexOf(e.identifier) >= 0 || aliases[k].indexOf(e.common_key) >= 0; });
        var candidates = found.map(function (e) {
            var v = e.value;
            if (v === null) return null;
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
        return {metadata: values, path: path, sha256: sha(path), duration: t.duration(), artwork_count: t.artworks.length};
    }
    return {
        libraryID: function () { return core.id(library.persistentID()); },
        snapshot: snapshot,
        writeField: function (pid, k, v) { track(pid)[k] = v; },
        readField: function (pid, k) { return track(pid)[k](); },
        checkArtwork: function (a) { if (!exists(a.path) || sha(a.path) !== a.sha256) throw new Error('Artwork changed or missing: ' + a.path); },
        addArtwork: function (pid, a) { this.checkArtwork(a); task('/usr/bin/osascript', [root + '/artwork.applescript', pid, a.path, a.format]); },
        verifyFile: verifyFile,
        playlist: function (name) {
            var p = music.playlists.whose({name: name})();
            if (p.length !== 1) throw new Error('Playlist name must identify exactly one playlist');
            return p[0].tracks.persistentID();
        },
        version: function () { return music.version(); }
    };
}
function usage() {
    return 'Music MVP 0.1.1 — no external runtime/packages\n' +
        '  ./music-mvp doctor\n' +
        '  ./music-mvp snapshot "French" snapshot.json\n' +
        '  ./music-mvp search "Kaaris Mandalorian"\n' +
        '  ./music-mvp prepare examples/french-five.json plan.json\n' +
        '  ./music-mvp preview plan.json\n' +
        '  ./music-mvp apply plan.json\n' +
        '  ./music-mvp inspect plan.json\n' +
        'prepare reads Music/downloads artwork; only apply changes Music.';
}
function run(argv) {
    var root = argv.shift(), core = eval(textFile(root + '/core.js') + '\nMusicMVP;');
    var command = argv.shift();
    if (!command || command === 'help' || command === '--help') return usage();
    var required = {doctor: 0, snapshot: 2, search: 1, prepare: 2, preview: 1, apply: 1, inspect: 1};
    if (!Object.prototype.hasOwnProperty.call(required, command) || argv.length !== required[command]) throw new Error(usage());
    if (command === 'preview') return core.preview(JSON.parse(textFile(absolute(argv[0]))));
    if (command === 'search') {
        var result = jsonURL('https://itunes.apple.com/search?term=' + encodeURIComponent(argv[0]) + '&entity=song&country=fr&limit=15');
        return JSON.stringify((result.results || []).map(function (s) { return {catalog_id: s.trackId, name: s.trackName, artist: s.artistName, album: s.collectionName, date: s.releaseDate, track: s.trackNumber, tracks: s.trackCount, duration_ms: s.trackTimeMillis, source: s.trackViewUrl}; }), null, 2);
    }
    var io = musicIO(core, root);
    if (command === 'doctor') return JSON.stringify({music_version: io.version(), library_id: io.libraryID(), note: 'Connection only. Artwork writing and AVFoundation need the pilot test.'}, null, 2);
    if (command === 'snapshot') {
        var ids = io.playlist(argv[0]), seen = {}, snapshots = [];
        ids.forEach(function (pid) {
            if (seen[pid]) return; seen[pid] = true;
            try { snapshots.push({id: pid, snapshot: io.snapshot(pid)}); }
            catch (e) { snapshots.push({id: pid, error: String(e)}); }
        });
        var dest = absolute(argv[1]);
        saveJSON(dest, {version: 1, library_id: io.libraryID(), playlist: argv[0], tracks: snapshots}, false);
        return 'Snapshot: ' + dest + ' (' + snapshots.length + ' records)';
    }
    if (command === 'prepare') {
        var request = core.validateRequest(JSON.parse(textFile(absolute(argv[0]))));
        var output = absolute(argv[1]), assets = output + '.assets';
        if (exists(output) || exists(assets)) throw new Error('Plan/assets already exist; choose a new plan filename');
        mkdir(assets);
        var plan = {version: 1, kind: 'music-mvp-plan', created_at: new Date().toISOString(), library_id: io.libraryID(), tracks: []};
        request.tracks.forEach(function (t) {
            var pid = core.id(t.id), before = io.snapshot(pid);
            var updates = core.changes(t, before.metadata, request.defaults || {}), cover = null;
            if (t.artwork_catalog_id && before.artwork_count === 0) {
                var song = catalogue(t.artwork_catalog_id);
                var album = updates.album || before.metadata.album;
                if (norm(song.trackName) !== norm(updates.name || before.metadata.name) || norm(song.artistName) !== norm(updates.artist || before.metadata.artist) || norm(song.collectionName) !== norm(album)) throw new Error('Catalogue identity/edition mismatch for ' + pid);
                if (Math.abs(song.trackTimeMillis / 1000 - before.duration) > 6) throw new Error('Catalogue duration differs by more than six seconds: ' + pid);
                cover = artwork(song, assets, pid);
            }
            plan.tracks.push({id: pid, before: before, set: updates, artwork: cover, sources: t.sources || []});
        });
        core.validatePlan(plan); saveJSON(output, plan, false);
        return core.preview(plan) + '\n\nSaved: ' + output + '\nNo Music fields changed.';
    }
    var path = absolute(argv[0]), p = core.validatePlan(JSON.parse(textFile(path)));
    if (command === 'inspect') {
        return JSON.stringify(p.tracks.map(function (t) { var s = io.snapshot(t.id); return {id: t.id, music: s, file_metadata: fileMetadata(s.path)}; }), null, 2);
    }
    var journal = path + '.journal.json', backups = path + '.backups';
    if (exists(journal)) throw new Error('Journal already exists. Do not replay a partial operation; inspect it and prepare a new plan.');
    if (exists(backups)) throw new Error('Backup directory already exists');
    var lock = ObjC.unwrap($.NSTemporaryDirectory()) + 'music-mvp-' + ObjC.unwrap($.NSUserName()) + '.lock';
    task('/bin/mkdir', [lock]);
    try {
        io.record = function (log) { saveJSON(journal, log, true); };
        io.backup = function (file, index, hash) {
            mkdir(backups);
            var target = backups + '/' + index + '-' + ObjC.unwrap($(file).lastPathComponent);
            task('/bin/cp', ['-p', file, target]);
            if (sha(target) !== hash || sha(file) !== hash) throw new Error('File changed while backing up');
            return target;
        };
        var log = core.execute(p, io);
        return 'Verified: ' + log.tracks.length + ' tracks. Journal: ' + journal;
    } finally { task('/bin/rmdir', [lock]); }
}
