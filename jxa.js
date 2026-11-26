/* macOS-only adapter. Run with the adjacent music-tags launcher. */
ObjC.import('Foundation');
ObjC.import('AppKit');
var TOOL_VERSION = '0.10.0';
var fm = $.NSFileManager.defaultManager;

function textFile(path) {
    var value = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
    var contents = value ? ObjC.unwrap(value) : undefined;
    if (typeof contents !== 'string') throw new Error('Cannot read UTF-8 file: ' + path);
    return contents;
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
    // A regular stderr file cannot fill a pipe while stdout is being drained.
    var errorPath=ObjC.unwrap($.NSTemporaryDirectory())+'music-doctor-stderr-'+ObjC.unwrap($.NSUUID.UUID.UUIDString);
    var attrs=$.NSDictionary.dictionaryWithObjectForKey($(384),$.NSFilePosixPermissions);
    if (!fm.createFileAtPathContentsAttributes($(errorPath),$.NSData.data,attrs)) throw new Error('Cannot capture command diagnostics');
    var errors=$.NSFileHandle.fileHandleForWritingAtPath($(errorPath));
    try {
        t.standardError=errors;
        t.launch;
        var data=pipe.fileHandleForReading.readDataToEndOfFile;
        t.waitUntilExit;
        var output=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)) || '';
        if (t.terminationStatus!==0) {
            errors.synchronizeFile;
            var detail=textFile(errorPath).trim().slice(-8192);
            throw new Error(program+' failed (exit '+t.terminationStatus+')'+(detail?': '+detail:''));
        }
        return output;
    } finally {
        errors.closeFile;
        pipe.fileHandleForReading.closeFile;
        fm.removeItemAtPathError($(errorPath),null);
    }
}
function sha(path) { return task('/usr/bin/shasum', ['-a', '256', '--', path]).slice(0, 64); }
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
function musicIO(core, root) {
    var music = Application('/System/Applications/Music.app');
    var library = music.libraryPlaylists[0];
    if (!library.exists()) throw new Error('Music library playlist is unavailable');
    function track(pid) {
        var matches = library.fileTracks.whose({persistentID: core.id(pid)})();
        if (matches.length !== 1) throw new Error('Local file track not found or not unique: ' + pid);
        return matches[0];
    }
    function scopeTracks(scope) {
        if (scope.kind === 'all') return library.tracks;
        var matches = music.playlists.whose({name: scope.value})();
        if (matches.length !== 1) throw new Error('Playlist name must identify exactly one playlist');
        return matches[0].tracks;
    }
    function favoriteValues(tracks) {
        // Music's dictionary renamed loved to favorited, keeping the same code pLov.
        var properties = ['favorited', 'loved'];
        for (var i = 0; i < properties.length; i++) {
            try {
                var values = tracks[properties[i]]();
                if (Array.isArray(values)) return {values: values, property: properties[i]};
            } catch (_) {}
        }
        return {values: null, property: null};
    }
    function filePaths() {
        var rows = new Map();
        try {
            var tracks = library.fileTracks;
            var ids = tracks.persistentID(), locations = tracks.location(), kinds = tracks.kind();
            var after = tracks.persistentID();
            if (![ids,locations,kinds,after].every(function (column) {
                return Array.isArray(column) && column.length === ids.length;
            })) return rows;
            if (new Set(ids).size !== ids.length || ids.some(function (id,index) {return id !== after[index];}))
                return rows;
            ids.forEach(function (id,index) {
                var path = locations[index] == null ? '' : String(locations[index]);
                var kind = kinds[index];
                if (path[0] === '/' && typeof kind === 'string' && kind.trim() && !/protected|Apple Music/i.test(kind))
                    rows.set(id,path);
            });
        } catch (_) {return new Map();}
        return rows;
    }
    return {
        checkArtwork: function (a) { if (!exists(a.path) || sha(a.path) !== a.sha256) throw new Error('Artwork changed or missing: ' + a.path); imageInfo(a.path, a.format); },
        candidates: function (selection, filters) {
            var tracks = scopeTracks(selection.scope), ids = tracks.persistentID();
            var needed = filters.fields(selection.filter);
            if (selection.sort_by && needed.indexOf(selection.sort_by) < 0) needed.push(selection.sort_by);
            ['name', 'artist', 'album', 'year', 'duration'].forEach(function (k) { if (needed.indexOf(k) < 0) needed.push(k); });
            var rows = ids.map(function (pid) { return {id: pid}; });
            needed.filter(function (k) { return k !== 'favorite'; }).forEach(function (k) {
                var values = tracks[k]();
                if (!Array.isArray(values) || values.length !== ids.length) throw new Error('Library changed while reading filters; take a new snapshot');
                rows.forEach(function (row, index) { row[k] = values[index]; });
            });
            var favorites = favoriteValues(tracks);
            if (!favorites.values && needed.indexOf('favorite') >= 0) throw new Error('Music does not expose favorited/loved; favorite filtering or sorting is unavailable');
            if (favorites.values && favorites.values.length !== ids.length) throw new Error('Library changed while reading favorites; take a new snapshot');
            rows.forEach(function (row, index) {
                var value = favorites.values ? favorites.values[index] : null;
                row.favorite = typeof value === 'boolean' ? value : null;
            });
            var after = tracks.persistentID();
            if (after.length !== ids.length || ids.some(function (pid, index) { return pid !== after[index]; })) throw new Error('Library order changed while reading filters; take a new snapshot');
            return {rows: rows, favorite_property: favorites.property};
        },
        filePaths: filePaths,
        filePath: function (pid) {
            var t = track(pid), path = t.location();
            if (!path || /protected|Apple Music/i.test(t.kind())) throw new Error('No supported local file');
            return String(path);
        },
        presenceForFile: function (pid, fields) {
            var t = track(pid), out = {};
            fields.forEach(function (key) {
                try {
                    var value = key === 'artwork' ? t.artworks.length : t[key]();
                    if (typeof value === 'string') out[key] = Boolean(value.trim());
                    else if (typeof value === 'number' && isFinite(value) && value >= 0) out[key] = value > 0;
                    else if (key === 'compilation' && value === true) out[key] = true;
                    else out[key] = null;
                } catch (_) {out[key] = null;}
            });
            return out;
        },
        readForFile: function (pid, fields, includeLyrics) {
            var t = track(pid), output = {tags:{},lyrics:null};
            fields.forEach(function (key) {
                try {
                    var value = t[key]();
                    // Music returns false/zero when source provenance is unavailable.
                    if (value !== undefined && value !== null && value !== false && value !== 0 && value !== '') output.tags[key]=value;
                } catch (_) {}
            });
            if (includeLyrics) {
                try {
                    var lyrics = t.lyrics();
                    if (typeof lyrics === 'string') output.lyrics = lyrics;
                } catch (_) {}
            }
            return output;
        },
        extractArtwork: function (pid, path) {
            var t = track(pid);
            var count = t.artworks.length;
            if (!count) return false;
            if (count !== 1) throw new Error('Multiple Music pictures; review manually');
            task('/usr/bin/osascript',[root+'/extract-artwork.applescript',core.id(pid),path]);
            return exists(path);
        },
        refreshFile: function (pid) {music.refresh(track(pid));},
        replaceArtwork: function (pid, artwork, expectedPath) {
            this.checkArtwork(artwork);
            var format=imageInfo(artwork.path).format;
            task('/usr/bin/osascript',[root+'/sync-artwork.applescript',core.id(pid),artwork.path,format,expectedPath]);
            var dir=ObjC.unwrap($.NSTemporaryDirectory())+'music-doctor-artwork-'+ObjC.unwrap($.NSUUID.UUID.UUIDString);
            mkdir(dir);
            try {
                var exported=dir+'/cover';
                task('/usr/bin/osascript',[root+'/extract-artwork.applescript',core.id(pid),exported]);
                if (sha(exported)!==artwork.sha256) throw new Error('Music artwork readback differs: '+pid);
            } finally {fm.removeItemAtPathError($(dir),null);}
        },
        matchesFile: function (row) {
            return row.music_ids.every(function (pid) {
                var t = track(pid);
                if (row.artwork && !t.artworks.length) return false;
                if (row.lyrics && core.normalizeLyrics(t.lyrics() || '') !== core.normalizeLyrics(textFile(row.lyrics.path))) return false;
                return Object.keys(row.tags).every(function (key) {
                    var expected = row.tags[key], current = t[key]();
                    return Array.isArray(expected) ? expected.length === 1 && expected[0] === current : expected === current;
                });
            });
        },
        version: function () { return music.version(); }
    };
}
function usage() {
    return 'Music Doctor '+TOOL_VERSION+' — macOS, local MP3/M4A, no external packages\n' +
        '  ./music-tags doctor\n' +
        '  ./music-tags --version\n' +
        '  ./music-tags snapshot --folder PATH [--recursive] [--music] [filters] [request.json]\n' +
        '  ./music-tags snapshot [--music] [--playlist "Playlist name" | --all] [filters] [request.json]\n' +
        '  ./music-tags snapshot --genre "Custom Genre" [request.json]\n' +
        '  ./music-tags snapshot --artist \'Artist A OR Artist B\' request.json\n' +
        '  ./music-tags snapshot --help\n' +
        '  ./music-tags audit request-or-snapshot.json [report.json]\n' +
        '  ./music-tags validate request.json\n' +
        '  ./music-tags prepare request.json runs/plan.json [--force true|false]\n' +
        '  ./music-tags preview runs/plan.json\n' +
        '  ./music-tags apply runs/plan.json\n' +
        '  ./music-tags status runs/plan.json\n' +
        '  ./music-tags inspect request-or-plan.json\n' +
        'Workflow: snapshot -> edit request JSON -> prepare -> preview -> apply -> status.\nOnly apply writes audio files. No snapshot path = console preview; a path = editable request.\nApply reports file verification and Music updates separately. See README.md for the complete workflow.';
}
function snapshotUsage() {
    return 'Snapshot selection (read-only):\n' +
        '  ./music-tags snapshot ["Playlist" | --playlist "Playlist" | --all] [filters] [output.json]\n' +
        '  No output path: fast console preview; file tags are read without full hashes.\n' +
        '  With output path: editable request JSON, short summary, and live <output>.log.\n' +
        '  See README.md for the workflow and docs/reference.md for request fields.\n' +
        '  --folder PATH [--recursive]   Scan local audio files without Music\n' +
        '  --music                 Use the catalog or enrich an explicit folder\n' +
        '  --has EXPR              artwork=false: missing from the file and Music\n' +
        '                          artwork=music-only: in Music, missing from the file\n' +
        '  --name / --title EXPR    Title contains text / logical expression\n' +
        '  --artist EXPR            Artist contains text, including collaborations\n' +
        '  --album EXPR             Album contains text / logical expression\n' +
        '  --album-artist EXPR      Album artist contains text / expression\n' +
        '  --genre EXPR             Exact genre / logical expression\n' +
        '  --favorite true|false    Favorite status in Music\n' +
        '  --min-duration VALUE     Duration >= seconds, M:SS or H:MM:SS\n' +
        '  --max-duration VALUE     Duration <= value (all bounds nonnegative)\n' +
        '  --sort FIELD [--desc]    name, artist, album, albumArtist, genre, favorite, duration, has.FIELD, has.file.FIELD, has.music.FIELD\n' +
        '  --show N|all             Show track rows (default 20 for preview, none for export)\n' +
        'Different flags combine with AND. Without a playlist, search the whole library.\n' +
        'Inside text arguments: uppercase AND / OR / NOT, && / || / !, parentheses.\n' +
        'Precedence: NOT > AND > OR. "Artist A NOT Artist B" means "Artist A AND NOT Artist B".\n' +
        'Quote the WHOLE expression for the shell; double-quote literal terms inside it.\n' +
        'Text matching ignores case; operator keywords must be UPPERCASE.\n' +
        'Example: ./music-tags snapshot --genre "Custom Genre" --artist \'Artist A AND NOT Artist B\' out.json';
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
function run(argv) {
    var root=argv.shift(), core=eval(textFile(root+'/core.js')+'\nMusicCore;'), command=argv.shift();
    if(!command || command==='help' || command==='--help') return usage();
    if(command==='--version' || command==='version') return TOOL_VERSION;
    if(command==='snapshot' && argv.length===1 && (argv[0]==='--help' || argv[0]==='-h')) return snapshotUsage();

    var counts={doctor:[0],snapshot:null,validate:[1],prepare:null,preview:[1],apply:[1],status:[1],inspect:[1],audit:[1,2]};
    if(!Object.prototype.hasOwnProperty.call(counts,command) || (counts[command] && counts[command].indexOf(argv.length)<0)) throw new Error(usage());
    if(['validate','audit','preview','status','apply','inspect'].indexOf(command)>=0) {
        var input=absolute(argv[0]), value=JSON.parse(textFile(input));
        if (value.version===1) {
            var legacy=eval(textFile(root+'/legacy.js')+'\nLegacy;');
            if (command==='audit') {
                var report=legacy.auditSnapshot(value);
                if (argv[1]) {
                    var output=absolute(argv[1]);
                    mkdir(ObjC.unwrap($(output).stringByDeletingLastPathComponent)); saveJSON(output,report,false);
                }
                return legacy.auditPreview(report);
            }
            if (command==='validate') {
                legacy.validateRequest(value); validateAssets(value,input,core);
                return 'Valid legacy request version 1. Export a version 2 snapshot before writing.';
            }
            if (command==='preview') return legacy.preview(value);
            if (command==='status') {
                legacy.validatePlan(value);
                var legacyJournal=input+'.journal.json';
                return exists(legacyJournal) ? textFile(legacyJournal) : JSON.stringify({status:'not_applied',total:value.tracks.length},null,2);
            }
            throw new Error('Version 1 is read-only in this release. Export a version 2 request and prepare a new plan.');
        }
    }
    var filters = command==='snapshot' ? eval(textFile(root+'/filters.js')+'\nMusicFilters;') : null;
    var files=eval(textFile(root+'/file-commands.js')+'\nFileCommands;');
    return files.run(root,command,argv,core,filters);
}
