/* JXA coordinator for file requests/plans. Shared Foundation helpers live in jxa.js. */
var FileCommands = (function () {
    'use strict';
    function check(ok, message) { if (!ok) throw new Error(message); }
    function label(e) { return String(e.message || e); }
    function parent(path) { return ObjC.unwrap($(path).stringByDeletingLastPathComponent); }
    function tmp() { return ObjC.unwrap($.NSTemporaryDirectory()).replace(/\/$/, ''); }
    function privateDir(folder, prefix) {
        return task('/usr/bin/mktemp',['-d',folder+'/'+prefix+'-XXXXXXXX']).trim();
    }
    function makeDir(path) { task('/bin/mkdir',['-m','700',path]); }
    function remove(path) {
        if (exists(path)) check(fm.removeItemAtPathError($(path),null), 'Could not remove ' + path);
    }
    function writeText(path, value) {
        check($(value).writeToFileAtomicallyEncodingError($(path),true,$.NSUTF8StringEncoding,null), 'Cannot write ' + path);
    }
    function assetInfo(path) {
        var attrs = fm.attributesOfItemAtPathError($(path),null);
        var length = !ObjC.unwrap(attrs) ? null : ObjC.unwrap(attrs.objectForKey($.NSFileSize));
        if (typeof length !== 'number') {
            var data = $.NSData.dataWithContentsOfFile($(path));
            length = Number(data.length);
        }
        return {path:path,sha256:sha(path),size:length};
    }
    function localAsset(requestPath, value) { return relativeFile(requestPath,value); }
    function helper(root) {
        var paths = [root+'/bin/music-tags-file',root+'/build/bin/music-tags-file'];
        return paths.find(function (p) {return fm.isExecutableFileAtPath($(p)); }) || null;
    }
    function startNative(root, payload) {
        var bin = helper(root);
        check(bin, 'Missing music-tags-file. Use the macOS release or build the native target (see README).');
        // Regular-file input avoids a pipe deadlock with a large batch.
        var dir = privateDir(tmp(),'music-doctor-stdin');
        try {
            var input = dir+'/request.json';
            writeText(input, JSON.stringify(Object.assign({protocol:1},payload)));
            var proc = $.NSTask.alloc.init, pipe = $.NSPipe.pipe;
            proc.launchPath = $(bin);
            proc.standardInput = $.NSFileHandle.fileHandleForReadingAtPath($(input));
            proc.standardOutput = pipe;
            proc.launch;
            return {
                read: function () {
                    var data = pipe.fileHandleForReading.readDataToEndOfFile;
                    proc.waitUntilExit;
                    var response = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding));
                    check(proc.terminationStatus === 0,'Native file module failed with exit ' + proc.terminationStatus);
                    var value = JSON.parse(response);
                    check(value.ok, value.error || 'Native file operation failed');
                    return value.result;
                },
                close: function () {
                    try {
                        pipe.fileHandleForReading.closeFile;
                        if (proc.running) proc.terminate;
                        proc.waitUntilExit;
                    } finally { remove(dir); }
                }
            };
        } catch (e) { remove(dir); throw e; }
    }
    function native(root, payload) {
        var job = startNative(root,payload);
        try { return job.read(); } finally { job.close(); }
    }
    function captureSnapshot(root, chosen, visit) {
        var offset = 0;
        while (offset < chosen.length) {
            var jobs = [];
            try {
                // Bound the number of processes and the size of base64 replies.
                while (jobs.length < 3 && offset < chosen.length) {
                    var paths = [], bytes = 0;
                    while (paths.length < 8 && offset < chosen.length) {
                        var file = chosen[offset].file;
                        var size = (file.artwork ? file.artwork.size : 0) + (file.lyrics ? file.lyrics.size : 0);
                        if (paths.length && bytes + size > 8 * 1024 * 1024) break;
                        bytes += size;
                        paths.push(file.path);
                        offset++;
                    }
                    jobs.push(startNative(root,{op:'capture',paths:paths,extract:true}));
                }
                jobs.forEach(function (job) {job.read().rows.forEach(visit);});
            } finally {
                jobs.forEach(function (job) {job.close();});
            }
        }
    }
    function readMany(root, paths, capture, onBatch) {
        var out = [];
        for (var i=0;i<paths.length;i+=128) {
            out = out.concat(native(root,{op:capture?'capture':'read', paths:paths.slice(i,i+128)}).rows);
            if (onBatch) onBatch(out.length);
        }
        return out;
    }
    function fromFolder(folder, recursive) {
        var standard = $(absolute(folder)).stringByResolvingSymlinksInPath;
        var resolved = ObjC.unwrap(standard);
        var contents = fm.contentsOfDirectoryAtPathError(standard,null);
        check(Boolean(ObjC.unwrap(contents)),'Cannot read folder: '+resolved);
        var names = recursive ? fm.enumeratorAtPath(standard).allObjects : contents;
        return ObjC.deepUnwrap(names).filter(function (name) {return /\.(mp3|m4a)$/i.test(name); })
            .sort().map(function (name) {return resolved+'/'+name;});
    }
    function musicPath(path) {
        return ObjC.unwrap($(path).stringByResolvingSymlinksInPath);
    }
    function favoritesRequired(selection, filters) {
        return selection.sort_by === 'favorite' || filters.fields(selection.filter).indexOf('favorite') >= 0;
    }
    function catalog(io, selection, filters, errors, folderPaths, report) {
        var required = favoritesRequired(selection,filters);
        var setting = Object.assign({},selection,{sort_by: selection.sort_by && selection.sort_by.indexOf('has.') !== 0 ? selection.sort_by : null});
        if (folderPaths) setting = Object.assign(setting,{scope:{kind:'all'},filter:null,sort_by:required?'favorite':null});
        var wanted = folderPaths ? new Set(folderPaths) : null;
        var candidates = io.candidates(setting,filters);
        if (required) check(candidates.favorite_property,'Music does not expose favorites');
        var eligible = wanted ? candidates.rows : candidates.rows.filter(function (row) {
            var match = filters.evaluate(selection.filter,row);
            if (match === null) errors.push(row.id + ': catalog filter unknown');
            return match === true;
        });
        var batch = new Map();
        if (eligible.length > 1 && typeof io.filePaths === 'function') {
            report.progress('Reading Music file paths');
            batch = io.filePaths();
        }
        var paths = new Map(), ordered = [], batched = 0, single = 0;
        eligible.forEach(function (row,index) {
            report.progress('Checking Music catalog',index,eligible.length);
            var path;
            try {
                if (batch.has(row.id)) {
                    batched++;
                    path = musicPath(batch.get(row.id));
                } else {
                    single++;
                    path = musicPath(io.filePath(row.id));
                }
            }
            catch (e) {
                if (!wanted) errors.push(row.id + ': ' + label(e));
                return;
            }
            if (wanted && !wanted.has(path)) return;
            if (!paths.has(path)) {
                paths.set(path,{ids:[],row:row});
                ordered.push(path);
            }
            var matchPath = paths.get(path);
            if (matchPath.ids.indexOf(row.id) < 0) matchPath.ids.push(row.id);
        });
        report.progress('Checking Music catalog',eligible.length,eligible.length);
        report.log('Music paths: ' + batched + ' batched, ' + single + ' checked individually');
        return {paths:paths,ordered:ordered};
    }
    function musicCandidate(io, ids, actual, presence, errors) {
        var fields = FileCore.fields.filter(function (key) {return actual.has[key] === false;});
        if (ids.length !== 1) {
            if (ids.length > 1) errors.push(actual.path + ': multiple Music records, enrichment skipped');
            return {tags:{},lyrics:null};
        }
        try {
            var result = io.readForFile(ids[0], fields, actual.has.lyrics === false && presence.lyrics !== false);
            if (actual.has.lyrics === false && typeof result.lyrics === 'string')
                presence.lyrics = Boolean(result.lyrics.trim());
            return result;
        }
        catch(e) { errors.push(actual.path + ': Music enrichment unavailable: ' + label(e)); return {tags:{},lyrics:null}; }
    }
    function comparable(row) {
        return JSON.stringify([row.identity,row.tags,row.has,row.artwork || null,row.lyrics || null],
            function (key,value) {
                if (key === 'base64' || key === 'text') return undefined;
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    var sorted = {};
                    Object.keys(value).sort().forEach(function (k) { sorted[k]=value[k]; });
                    return sorted;
                }
                return value;
            });
    }
    function exportSnapshot(root, chosen, output, io, core, errors, report) {
        check(!exists(output),'Output already exists: '+output);
        var assetRoot = output+'.assets';
        var request = {version:2,tracks:[]};
        var assetFields = [{source:'combined',tag:'artwork'}, {source:'combined',tag:'lyrics'}];
        var owned = false;
        function getAssetDir() {
            if (!owned) {makeDir(assetRoot); owned=true;}
            return assetRoot;
        }
        function rel(path) { return ObjC.unwrap($(assetRoot).lastPathComponent)+'/'+ObjC.unwrap($(path).lastPathComponent); }
        function savePicture(data, format, number) {
            var path = getAssetDir()+'/'+number+'.'+format;
            check(data && data.writeToFileAtomically($(path),true),'Cannot export artwork');
            imageInfo(path,format);
            var target = getAssetDir()+'/'+sha(path)+'.'+format;
            if (!exists(target)) task('/bin/mv',[path,target]); else remove(path);
            return rel(target);
        }
        function saveLyrics(value) {
            var normalized = core.lyricsText(value);
            var data = $(normalized).dataUsingEncoding($.NSUTF8StringEncoding);
            check(Number(data.length) <= 400000,'Lyrics text exceeds 400 KB');
            var path = getAssetDir()+'/lyrics-'+request.tracks.length+'.tmp';
            writeText(path,normalized);
            var target = getAssetDir()+'/'+sha(path)+'.txt';
            if (!exists(target)) task('/bin/mv',[path,target]); else remove(path);
            return rel(target);
        }
        try {
            mkdir(parent(output));
            report.progress('Exporting snapshot',0,chosen.length);
            captureSnapshot(root, chosen, function (actual) {
                var index = request.tracks.length, entry = chosen[index];
                var before = entry.file;
                check(!actual.error,before.path+': '+actual.error);
                check(actual.path === before.path,'Unexpected native snapshot order');
                check(comparable(actual) === comparable(before),before.path+': tags changed during snapshot');
                var row = {tags:{},artwork:null,lyrics:null};
                var ids = entry.music ? entry.music.ids : [];
                var suggestions = {}, assetsFromMusic = [];
                var fallback = io && ids.length ? musicCandidate(io,ids,actual,entry.musicPresence,errors) : {tags:{},lyrics:null};
                FileCore.fields.forEach(function (key) {
                    var value = actual.has[key] === true && FileCore.validValue(key,actual.tags[key]) ? actual.tags[key] : null;
                    var suggested = fallback.tags[key];
                    if (value === null && actual.has[key] === false && suggested != null && FileCore.validValue(key,suggested)) {
                        suggestions[key] = suggested;
                    }
                    if (actual.has[key] === true && value === null) errors.push(actual.path + ': ' + key + ' needs review');
                    row.tags[key] = value;
                });
                if (actual.artwork && actual.artwork.base64) {
                    try {row.artwork = savePicture($.NSData.alloc.initWithBase64EncodedStringOptions($(actual.artwork.base64),0),actual.artwork.format,index);}
                    catch(e) {errors.push(actual.path + ': ' + label(e));}
                } else if (io && ids.length === 1 && actual.has.artwork === false && entry.musicPresence.artwork !== false) {
                    var extraction = privateDir(tmp(),'music-doctor-cover');
                    try {
                        var raw = extraction+'/picture';
                        if (io.extractArtwork(ids[0], raw)) {
                            var info = imageInfo(raw);
                            row.artwork = savePicture($.NSData.dataWithContentsOfFile($(raw)),info.format,index);
                            assetsFromMusic.push('artwork');
                        }
                    } catch(e) {errors.push(actual.path+': Music artwork: '+label(e));}
                    finally {remove(extraction);}
                }
                var lyrics = actual.lyrics && actual.lyrics.text;
                if (!lyrics && actual.has.lyrics === false) lyrics = fallback.lyrics;
                if (lyrics) {
                    try {
                        row.lyrics = saveLyrics(lyrics);
                        if (actual.has.lyrics === false) assetsFromMusic.push('lyrics');
                    } catch(e) {errors.push(actual.path + ': ' + label(e));}
                }
                var observed = {
                    artwork: Boolean(row.artwork),
                    lyrics: typeof lyrics === 'string' && Boolean(lyrics.trim())
                };
                readPresence(io,entry.music,actual,assetFields.filter(function (field) {
                    return !observed[field.tag];
                }),entry.musicPresence);
                assetFields.forEach(function (field) {
                    var key = field.tag;
                    if (row[key]) return;
                    row[key] = observed[key] ? true :
                        combinedPresence(actual.has[key],entry.musicPresence[key],Boolean(io && entry.music));
                    if (row[key] === true)
                        errors.push(actual.path + ': ' + key + ' present but no asset exported');
                });
                var suggestedFields = Object.keys(suggestions);
                if (suggestedFields.length) {
                    row.music_suggestions = suggestions;
                    report.log(actual.path + ': Music tag suggestions: ' + suggestedFields.join(', '));
                }
                if (assetsFromMusic.length) report.log(actual.path + ': assets exported from Music: ' + assetsFromMusic.join(', '));
                row.path = actual.path;
                row.sha256 = actual.sha256;
                if (ids.length) row.music_ids = ids;
                request.tracks.push(row);
                report.progress('Exporting snapshot',request.tracks.length,chosen.length);
            });
            FileCore.request(request);
            saveJSON(output,request,false);
            return request.tracks;
        } catch(e) {
            if (owned) remove(assetRoot);
            throw e;
        }
    }
    function combinedPresence(stored, fromMusic, useMusic) {
        if (!useMusic) return stored;
        if (stored === true || fromMusic === true) return true;
        if (stored === false && fromMusic === false) return false;
        return null;
    }
    function assignPresence(row, file, fields, useMusic, musicPresence) {
        fields.forEach(function (field) {
            var stored = file.has[field.tag];
            var fromMusic = Object.prototype.hasOwnProperty.call(musicPresence,field.tag) ? musicPresence[field.tag] : null;
            var value = stored;
            if (field.source === 'music') value = fromMusic;
            if (field.source === 'combined') value = combinedPresence(stored,fromMusic,useMusic);
            row[field.key] = value;
        });
    }
    function readPresence(io, linked, file, fields, cache) {
        if (!io || !linked) return;
        var wanted = fields.filter(function (field) {
            return field.source === 'music' || (field.source === 'combined' && file.has[field.tag] !== true);
        }).map(function (field) {return field.tag;});
        var pending = Array.from(new Set(wanted)).filter(function (key) {
            return !Object.prototype.hasOwnProperty.call(cache,key);
        });
        if (!pending.length) return;
        var reports = linked.ids.map(function (id) {
            try {return io.presenceForFile(id,pending);}
            catch (_) {return {};}
        });
        pending.forEach(function (key) {
            if (reports.some(function (report) {return report[key] === true;})) cache[key]=true;
            else if (reports.length && reports.every(function (report) {return report[key] === false;})) cache[key]=false;
            else cache[key]=null;
        });
    }
    function presenceFields(keys, filters) {
        return keys.map(function (key) {
            var field = filters.presenceField(key);
            return field ? Object.assign({key:key},field) : null;
        }).filter(Boolean);
    }
    function snapshotReporter(output) {
        var path = output ? output + '.log' : null, logHandle = null;
        if (path) {
            mkdir(parent(path));
            if (!exists(path)) writeText(path,'');
            logHandle = $.NSFileHandle.fileHandleForWritingAtPath($(path));
            check(Boolean(ObjC.unwrap(logHandle)),'Cannot open snapshot log: ' + path);
            logHandle.seekToEndOfFile;
        }
        var terminal = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey($('MUSIC_TAGS_TTY'))) === '1';
        var started = Date.now(), phase = null, lastLog = 0, lastDraw = 0, drawn = false;
        function write(handle, line) {handle.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));}
        function elapsed() {return Math.floor((Date.now()-started)/1000) + 's';}
        function log(line) {
            if (logHandle) write(logHandle,new Date().toISOString() + '  ' + line.replace(/[\x00-\x1f\x7f-\x9f]/g,' ') + '\n');
        }
        log('Snapshot started');
        return {
            path: path, elapsed: elapsed, log: log,
            progress: function (stage, done, total) {
                var now = Date.now(), changed = stage !== phase, finished = total !== undefined && done === total;
                var line = stage + (total === undefined ? '…' : ' ' + done + '/' + total) + '  |  ' + elapsed();
                phase = stage;
                if (changed || finished || now-lastLog >= 1000) {
                    log(line); lastLog = now;
                }
                if (terminal && (changed || finished || now-lastDraw >= 150)) {
                    write($.NSFileHandle.fileHandleWithStandardError,'\r\x1b[2K'+line);
                    drawn = true; lastDraw = now;
                }
            },
            close: function () {
                if (drawn) write($.NSFileHandle.fileHandleWithStandardError,'\r\x1b[2K');
                if (logHandle) logHandle.closeFile;
            }
        };
    }
    function snapshot(root, argv, filters, core) {
        var selection = filters.parse(argv);
        var output = selection.output ? absolute(selection.output) : null;
        if (output) check(!exists(output),'Output already exists: '+output);
        var report = snapshotReporter(output), errors = [];
        try { return collectSnapshot(root,selection,output,filters,core,report,errors); }
        catch (e) {
            errors.forEach(function (issue) {report.log('Warning: ' + issue);});
            report.log('Failed: ' + label(e));
            if (!report.path) throw e;
            throw new Error(label(e) + '\nLog: ' + report.path);
        } finally { report.close(); }
    }
    function collectSnapshot(root, selection, output, filters, core, report, errors) {
        var io = null, paths, music;
        var useCatalog = !selection.folder;
        var filterFields = presenceFields(filters.fields(selection.presence),filters);
        var sortFields = presenceFields(selection.sort_by ? [selection.sort_by] : [],filters);
        var needsMusic = favoritesRequired(selection,filters) || filterFields.concat(sortFields).some(function (field) {
            return field.source === 'music';
        });
        var expression = selection.presence;
        if (!useCatalog && selection.filter) expression = expression ?
            {all:[selection.filter,expression]} : selection.filter;
        report.progress(useCatalog ? 'Reading Music catalog' : 'Looking for audio files');
        if (useCatalog || selection.music) {
            try {io = musicIO(core,root);}
            catch(e) {
                if (useCatalog || needsMusic) throw new Error('Music source unavailable: '+label(e));
                errors.push('Optional Music unavailable: '+label(e));
            }
        }
        if (selection.folder) {
            paths = fromFolder(selection.folder,selection.recursive);
            try { if (io) music=catalog(io,selection,filters,errors,paths,report); }
            catch(e) {
                if (needsMusic) throw e;
                errors.push('Optional Music unavailable: '+label(e)); io=null;
            }
        } else {
            music=catalog(io,selection,filters,errors,null,report);
            paths=music.ordered;
        }
        var entries = [], seen = new Set(), failed = [];
        report.progress('Reading file tags',0,paths.length);
        var files = readMany(root,paths,false,function (done) {report.progress('Reading file tags',done,paths.length);});
        files.forEach(function (file,index) {
            report.progress('Filtering tracks',index,files.length);
            if (file.error) {failed.push(file.path+': '+file.error); return;}
            var linked = music && music.paths.get(file.path);
            var row = Object.assign({},useCatalog ? linked.row : file.tags,{id:file.path,
                duration:file.duration,favorite:linked ? linked.row.favorite : null});
            // A known missing text tag is an empty string for text comparisons.
            ['name','artist','album','albumArtist','genre'].forEach(function (key) {
                if (!useCatalog && file.has[key] === false) row[key]='';
                if (!useCatalog && file.has[key] === null) row[key]=null;
            });
            var useMusic = Boolean(io && linked);
            var musicPresence = {};
            assignPresence(row,file,filterFields,useMusic,musicPresence);
            var result = filters.evaluate(expression,row);
            if (result === null && useMusic && filterFields.length) {
                readPresence(io,linked,file,filterFields,musicPresence);
                assignPresence(row,file,filterFields,useMusic,musicPresence);
                result = filters.evaluate(expression,row);
            }
            if (result === null) {
                var unknown = filterFields.filter(function (field) {return row[field.key] == null;})
                    .map(function (field) {return field.key.slice(4);});
                var reason = file.issues.slice();
                if (unknown.length) reason.push('unconfirmed: ' + unknown.join(', '));
                errors.push(file.path + ': filter could not be evaluated' +
                    (reason.length ? ' (' + reason.join(', ') + ')' : ''));
            }
            if (result !== true || seen.has(file.identity)) return;
            readPresence(io,linked,file,sortFields,musicPresence);
            assignPresence(row,file,sortFields,useMusic,musicPresence);
            seen.add(file.identity);
            file.issues.forEach(function (issue) {errors.push(file.path+': '+issue);});
            row.file=file; row.music=linked; row.musicPresence=musicPresence; entries.push(row);
        });
        report.progress('Filtering tracks',files.length,files.length);
        failed.forEach(function (issue) {errors.push(issue);});
        if (output && failed.length) throw new Error('Snapshot export blocked by ' + failed.length + ' file read errors');
        var chosen = filters.sort(entries,selection.sort_by,selection.descending);
        var summary;
        if (output) {
            var exported = chosen.length ? exportSnapshot(root,chosen,output,io,core,errors,report) : [];
            var artwork = exported.filter(function (row) {return typeof row.artwork === 'string';}).length;
            var lyrics = exported.filter(function (row) {return typeof row.lyrics === 'string';}).length;
            summary = chosen.length ? 'Snapshot saved — ' + chosen.length + ' tracks | Artwork: ' + artwork +
                ' | Lyrics: ' + lyrics + ' | ' + report.elapsed() + '\n' + output :
                'No matching files. No request created.';
            errors.forEach(function (issue) {report.log('Warning: ' + issue);});
            report.log(summary);
            summary += (errors.length ? '\nWarnings: ' + errors.length : '') + '\nLog: ' + report.path;
            if (!selection.show_explicit || selection.show_limit === 0) return summary;
        }
        var display = chosen.map(function (entry) {
            var row = Object.assign({},entry.file.tags,{duration:entry.file.duration,favorite:entry.favorite});
            ['name','artist','album'].forEach(function(key) {if(Array.isArray(row[key])) row[key]=row[key].join(' / ');});
            return row;
        });
        if (output) return summary + '\n\n' + core.snapshotInfo(display,selection.show_limit);
        summary = 'Source: ' + (useCatalog ? 'Music catalog, verified file tags' : 'folder, file tags') + '\n' +
            (filterFields.length || sortFields.length ? 'Presence: ' + (io ? 'file + Music for unqualified fields' : 'file') + '\n' : '') +
            core.snapshotInfo(display,selection.show_limit);
        return summary + (errors.length ? '\n\nDiagnostics:\n'+errors.join('\n') : '');
    }
    function validateAssetsV2(input, request, core) {
        request.tracks.forEach(function (row) {
            var artwork = FileCore.assetPath(row,'artwork'), lyrics = FileCore.assetPath(row,'lyrics');
            if (artwork) imageInfo(localAsset(input,artwork));
            if (lyrics) lyricsFile(localAsset(input,lyrics),core);
        });
    }
    function prepare(root, argv, core) {
        var options=FileCore.prepareArgs(argv), input=absolute(options.input), out=absolute(options.output);
        var request=FileCore.request(JSON.parse(textFile(input)));
        validateAssetsV2(input,request,core);
        var assets=out+'.assets';
        check(!exists(out)&&!exists(assets),'Plan or assets already exist');
        mkdir(parent(out)); makeDir(assets);
        var plan={version:2,kind:'music-tags-file-plan',created_at:new Date().toISOString(),force:options.force,tracks:[]};
        try {
            var before=readMany(root,request.tracks.map(function (row) {return row.path;}),true);
            request.tracks.forEach(function (track,index) {
                var actual=before[index];
                check(!actual.error,track.path+': '+actual.error);
                check(actual.sha256===track.sha256,'Stale snapshot: '+track.path);
                var row={path:track.path,sha256:actual.sha256,identity:actual.identity,before:Object.assign({},actual.tags),
                    tags:FileCore.effective(track,request.defaults,actual,options.force)};
                if (track.music_ids && track.music_ids.length) row.music_ids=track.music_ids;
                if (actual.artwork) row.before.artwork=actual.artwork;
                if (actual.lyrics) row.before.lyrics=actual.lyrics;
                var artwork=FileCore.assetPath(track,'artwork'), lyrics=FileCore.assetPath(track,'lyrics');
                if (artwork) {
                    var source=localAsset(input,artwork), img=imageInfo(source), frozen=assets+'/'+index+'.'+img.format;
                    var sourceHash=sha(source);
                    if (options.force || !actual.artwork || actual.artwork.sha256!==sourceHash) {
                        task('/bin/cp',['-p',source,frozen]);
                        imageInfo(frozen,img.format);
                        row.artwork=assetInfo(frozen);
                        check(row.artwork.sha256===sourceHash,'Artwork changed during prepare');
                    }
                }
                if (lyrics || track.lyrics_url) {
                    var content=lyrics ? lyricsFile(localAsset(input,lyrics),core) : remoteLyrics(track.lyrics_url,core);
                    var file=assets+'/'+index+'.txt';
                    writeText(file,content);
                    var info=assetInfo(file);
                    if (options.force || !actual.lyrics || actual.lyrics.sha256!==info.sha256) row.lyrics=info;
                    else remove(file);
                }
                preflight(root,row,true);
                plan.tracks.push(row);
            });
            FileCore.plan(plan);
            saveJSON(out,plan,false);
            return FileCore.preview(plan)+'\n\nSaved: '+out;
        } catch(e) {remove(assets); throw e;}
    }
    function target(row, path, operation, force) {
        var request={op:operation,path:path,tags:row.tags,force:force};
        ['artwork','lyrics'].forEach(function (key) {
            if(row[key]) {request[key+'_path']=row[key].path; request[key+'_sha256']=row[key].sha256;}
        });
        return request;
    }
    function changing(row) {return Object.keys(row.tags).length>0 || Boolean(row.artwork || row.lyrics);}
    function preflight(root,row,planning) {
        var result;
        try {
            result=native(root,{op:'preflight',path:row.path,sha256:row.sha256,identity:row.identity,write:changing(row)});
        } catch(e) {throw new Error(row.path+': '+label(e));}
        if (planning && result.id3_migration) row.id3_migration=result.id3_migration;
        var expected=row.id3_migration, actual=result.id3_migration;
        check((!expected && !actual) || (expected && actual && expected.from===actual.from && expected.to===actual.to),
            row.path+': ID3 migration differs from plan; prepare a new plan');
        ['artwork','lyrics'].forEach(function(key) {
            if(row[key]) check(sha(row[key].path)===row[key].sha256,'Changed '+key+' asset for '+row.path);
        });
    }
    function withLock(fn) {
        ObjC.bindFunction('open',['int',['char *','int']]);
        ObjC.bindFunction('flock',['int',['int','int']]);
        ObjC.bindFunction('close',['int',['int']]);
        var lock = tmp()+'/music-doctor-file-apply-v2.lock';
        task('/usr/bin/touch',[lock]);
        var fd=$.open(lock,0x0100);
        check(fd>=0,'Cannot open apply lock');
        try {check($.flock(fd,2|4)===0,'Another Music Doctor apply is running'); return fn();}
        finally {$.close(fd);}
    }
    function apply(root,path,plan,core) {
        return withLock(function () {
            var journal=path+'.journal.json', planHash=sha(path);
            if (exists(journal)) {
                var prior=JSON.parse(textFile(journal));
                if (prior.status==='complete' && prior.plan_sha256===planHash) return 'Already complete. Journal: '+journal;
                throw new Error('Journal exists. Use status to reconcile '+journal+' before preparing a new plan.');
            }
            check(JSON.stringify(JSON.parse(textFile(path)))===JSON.stringify(plan),'Plan changed on disk');
            plan.tracks.forEach(function (row) {preflight(root,row);});
            var log={version:2,kind:'music-tags-file-journal',plan_sha256:planHash,force:plan.force,status:'started',tracks:[]};
            function record() {saveJSON(journal,log,true); native(root,{op:'sync',path:journal});}
            record();
            var io, musicAttempted=false;
            for (var i=0;i<plan.tracks.length;i++) {
                var row=plan.tracks[i], entry={path:row.path,before_sha256:row.sha256,time:new Date().toISOString(),
                    changes:FileCore.targetSummary(row),file_status:'preflight',music_status:'not_requested'};
                log.tracks.push(entry);
                try {
                    preflight(root,row);
                    if (!changing(row)) {
                        entry.file_status='unchanged'; entry.after_sha256=row.sha256; record(); continue;
                    }
                    var stage=privateDir(parent(row.path),'.music-doctor');
                    var ext=row.path.toLowerCase().slice(-4);
                    entry.work_dir=stage;
                    entry.backup=stage+'/original'+ext;
                    entry.temp=stage+'/working'+ext;
                    record();
                    task('/bin/cp',['-p',row.path,entry.backup]);
                    check(sha(entry.backup)===row.sha256,'Backup checksum differs');
                    native(root,{op:'sync',path:entry.backup});
                    task('/bin/cp',['-p',entry.backup,entry.temp]);
                    entry.file_status='writing_temp'; record();
                    native(root,target(row,entry.temp,'write',plan.force));
                    var verify=target(row,entry.temp,'verify',plan.force);
                    verify.original=entry.backup;
                    entry.expected_sha256=native(root,verify).sha256;
                    entry.file_status='committing'; record();
                    native(root,{op:'commit',path:row.path,temp:entry.temp,sha256:row.sha256,
                        identity:row.identity,target_sha256:entry.expected_sha256});
                    entry.after_sha256=sha(row.path);
                    check(entry.after_sha256===entry.expected_sha256,'Final file differs from verified temporary copy');
                    if (row.music_ids && row.music_ids.length) {
                        try {
                            if (!musicAttempted) {musicAttempted=true; io=musicIO(core,root);}
                            check(io,'Music unavailable');
                            row.music_ids.forEach(function (id) {
                                check(musicPath(io.filePath(id))===musicPath(row.path),'Music entry points to a different file');
                                io.refreshFile(id);
                            });
                            entry.music_status=io.matchesFile(row) ? 'refreshed' : 'different_display_values';
                        } catch(e) {entry.music_status='unavailable_or_failed'; entry.music_error=label(e);}
                        check(sha(row.path)===entry.after_sha256,'File changed during Music refresh');
                    }
                    entry.file_status='verified'; record();
                    try {remove(stage); entry.cleanup='removed';}
                    catch(e) {entry.cleanup='failed'; entry.cleanup_error=label(e);}
                    record();
                } catch(e) {
                    entry.previous_stage=entry.file_status;
                    entry.file_status='failed';
                    entry.error=label(e);
                    log.status='failed';
                    try {record();} catch(logError) {console.log('Journal save failed: '+label(logError));}
                    throw new Error(row.path+': '+label(e)+'\nJournal: '+journal+(entry.backup?'\nRecovery copy if created: '+entry.backup:''));
                }
            }
            log.status='complete';record();
            return 'Verified: '+log.tracks.length+' files. Journal: '+journal;
        });
    }
    function audit(input, request) {
        var rows=request.tracks.map(function (row) {
            return {path:row.path,missing:FileCore.fields.filter(function (key) {
                return row.tags[key] == null && (!request.defaults || request.defaults[key] == null) &&
                    (!row.fill || row.fill[key] == null);
            }).concat(!FileCore.assetPath(row,'artwork')?['artwork']:[],!FileCore.assetPath(row,'lyrics')&&!row.lyrics_url?['lyrics']:[])};
        });
        return {version:2,kind:'request_completeness',input:input,tracks:rows};
    }
    function run(root,command,argv,core,filters) {
        if (command==='doctor') {
            var report={tool_version:TOOL_VERSION};
            try {report.file_module=native(root,{op:'version'});} catch(e) {report.file_error=label(e);}
            try {var io=musicIO(core,root);report.music_version=io.version();report.music_status='available';}
            catch(e) {report.music_status='unavailable';report.music_error=label(e);}
            return JSON.stringify(report,null,2);
        }
        if (command==='snapshot') return snapshot(root,argv,filters,core);
        if (command==='prepare') return prepare(root,argv,core);
        var input=absolute(argv[0]), value=JSON.parse(textFile(input));
        if (command==='validate') {
            FileCore.request(value); validateAssetsV2(input,value,core);
            return 'Valid version 2 request: '+value.tracks.length+' files.';
        }
        if (command==='audit') {
            var report=audit(input,FileCore.request(value));
            if(argv[1]) {var output=absolute(argv[1]);mkdir(parent(output));saveJSON(output,report,false);}
            return JSON.stringify(report,null,2);
        }
        if (command==='inspect') {
            if (value.version===2 && value.kind==='music-tags-file-plan') FileCore.plan(value);
            else FileCore.request(value);
            var rows=readMany(root,value.tracks.map(function(row){return row.path;}),false);
            return JSON.stringify({kind:'actual_file_tags',tracks:rows},null,2);
        }
        var plan=FileCore.plan(value);
        if (command==='preview') return FileCore.preview(plan);
        if (command==='status') {
            var journalPath=input+'.journal.json';
            var log=exists(journalPath)?JSON.parse(textFile(journalPath)):{status:'not_applied',tracks:[]};
            if (log.plan_sha256) log.plan_matches=log.plan_sha256===sha(input);
            log.tracks.forEach(function(entry) {
                if (entry.file_status!=='verified' && entry.file_status!=='unchanged') {
                    try {
                        var hash=sha(entry.path);
                        entry.observed_sha256=hash;
                        if (entry.expected_sha256===hash && entry.before_sha256===hash) entry.observed_state='before_and_after_bytes_equal';
                        else entry.observed_state=entry.expected_sha256===hash?'matches_verified_temp':entry.before_sha256===hash?'matches_original':'different';
                    } catch(e) {entry.observed_state='unavailable';}
                }
            });
            return JSON.stringify(log,null,2);
        }
        return apply(root,input,plan,core);
    }
    return {run:run};
}());
