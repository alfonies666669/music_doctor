/* Platform-independent validation and execution. No packages. */
var MusicMVP = (function () {
    'use strict';
    var fields = {
        name: 'string', artist: 'string', album: 'string', albumArtist: 'string',
        composer: 'string', genre: 'string', year: 'number', trackNumber: 'number',
        trackCount: 'number', discNumber: 'number', discCount: 'number', compilation: 'boolean', lyrics: 'string'
    };
    function fail(message) { throw new Error(message); }
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function object(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
    function normalizeLyrics(s) { var v=s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');return v.trim()?v:''; }
    function lyricsText(s) {
        if (typeof s !== 'string' || !s.trim() || s.length > 100000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s) || /<!doctype\s+html|<html[\s>]/i.test(s)) fail('Lyrics must be nonempty plain text (up to 100000 characters)');
        return normalizeLyrics(s);
    }
    function keysOnly(o, allowed, label) {
        if (!object(o)) fail(label + ': expected object');
        Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) fail(label + ': unsupported field ' + k); });
    }
    function id(value) {
        if (typeof value !== 'string' || !/^[A-Fa-f0-9]{16}$/.test(value)) fail('Invalid Persistent ID');
        return value.toUpperCase();
    }
    function patch(o, allowNull) {
        keysOnly(o, Object.keys(fields), 'metadata');
        Object.keys(o).forEach(function (k) {
            var v = o[k];
            if (allowNull && v === null) return;
            if (typeof v !== fields[k]) fail(k + ': invalid type');
            if (k === 'lyrics') lyricsText(v);
            else if (typeof v === 'string' && (!v.trim() || v.length > 2000 || /[\x00-\x1f]/.test(v))) fail(k + ': invalid text');
            if (typeof v === 'number' && (!isFinite(v) || v % 1 || v < 1 || v > 9999)) fail(k + ': invalid number');
        });
        return o;
    }
    function ranges(o) {
        [['trackNumber', 'trackCount'], ['discNumber', 'discCount']].forEach(function (p) {
            if (o[p[0]] && o[p[1]] && o[p[0]] > o[p[1]]) fail(p[0] + ' exceeds ' + p[1]);
        });
    }
    function validateRequest(r) {
        keysOnly(r, ['version', 'description', 'defaults', 'tracks'], 'request');
        if (r.version !== 1) fail('Unsupported request version');
        keysOnly(r.defaults || {}, Object.keys(fields).filter(function(k){return k!=='lyrics';}), 'defaults');patch(r.defaults || {});
        if (!Array.isArray(r.tracks) || !r.tracks.length) fail('Request must contain at least one track');
        var seen = {};
        r.tracks.forEach(function (t) {
            keysOnly(t, ['id', 'expect', 'set', 'fill', 'artwork_file', 'lyrics_file', 'lyrics_url', 'lyrics_policy', 'sources', 'info'], 'track');
            var pid = id(t.id); if (seen[pid]) fail('Duplicate track ' + pid); seen[pid] = true;
            keysOnly(t.expect, ['name', 'artist'], 'expect');
            ['name','artist'].forEach(function(k){if(typeof t.expect[k]!=='string'||t.expect[k].length>2000||/[\x00-\x1f]/.test(t.expect[k]))fail('expect.'+k+' must be the current string (empty is allowed)');});
            patch(t.set || {}, true); patch(t.fill || {}, true);
            if (own(t, 'info')) {
                keysOnly(t.info, ['duration', 'favorite', 'artwork_count', 'file_artwork_present', 'lyrics_present'], 'info');
                Object.keys(t.info).forEach(function (k) {
                    var v = t.info[k]; if (v === null) return;
                    if (k === 'duration' || k === 'artwork_count') {
                        if (typeof v !== 'number' || !isFinite(v) || v < 0 || (k === 'artwork_count' && !Number.isInteger(v))) fail('Invalid info.' + k);
                    } else if (typeof v !== 'boolean') fail('Invalid info.' + k);
                });
            }
            if (own(t, 'artwork_file') && t.artwork_file !== null) {
                if (typeof t.artwork_file === 'string') { if (!t.artwork_file.trim()) fail('Empty artwork path'); }
                else {
                    keysOnly(t.artwork_file, ['path', 'sha256', 'format', 'source_url', 'album'], 'artwork_file');
                    var a = t.artwork_file;
                    if (typeof a.path !== 'string' || !a.path.trim() || (a.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(a.sha256)) || (a.format !== undefined && ['jpg','png'].indexOf(a.format) < 0) || (a.source_url !== undefined && (typeof a.source_url !== 'string' || !/^https:\/\//.test(a.source_url))) || (a.album !== undefined && (typeof a.album !== 'string' || !a.album.trim()))) fail('Invalid local artwork');
                }
            }
            function active(o, k) { return own(o || {}, k) && o[k] !== null; }
            var fileLyrics = active(t, 'lyrics_file'), urlLyrics = active(t, 'lyrics_url');
            if (fileLyrics && (typeof t.lyrics_file !== 'string' || !t.lyrics_file.trim())) fail('lyrics_file must be a TXT path');
            if (urlLyrics && (typeof t.lyrics_url !== 'string' || !/^https:\/\//.test(t.lyrics_url))) fail('lyrics_url must use HTTPS');
            var externalLyrics = fileLyrics || urlLyrics;
            if (fileLyrics && urlLyrics) fail('Use one lyrics source');
            if (externalLyrics && (active(t.set,'lyrics') || active(t.fill,'lyrics'))) fail('External and inline lyrics cannot be combined');
            if (active(t.set,'lyrics') && active(t.fill,'lyrics')) fail('Choose set.lyrics or fill.lyrics');
            if (t.lyrics_policy !== undefined && t.lyrics_policy !== null && (!externalLyrics || ['fill','replace'].indexOf(t.lyrics_policy)<0)) fail('lyrics_policy is fill or replace for an external source');
            if (t.sources !== undefined && (!Array.isArray(t.sources) || t.sources.some(function (u) { return typeof u !== 'string' || !/^https:\/\//.test(u); }))) fail('Invalid sources');
        });
        return r;
    }
    function changes(t, before, defaults) {
        ['name', 'artist'].forEach(function (k) {
            var current = before[k].normalize('NFC');
            var original = t.expect[k].normalize('NFC');
            var corrected = t.set && typeof t.set[k] === 'string' ? t.set[k].normalize('NFC') : (defaults && typeof defaults[k]==='string'?defaults[k].normalize('NFC'):original);
            if (current !== original && current !== corrected) fail('Identity differs for ' + t.id + '; inspect the current track');
        });
        var desired = {}, result = {}, combined = {};
        Object.keys(before).forEach(function (k) { combined[k] = before[k]; });
        Object.keys(t.fill || {}).forEach(function (k) { if (t.fill[k] !== null && (before[k] === '' || before[k] === 0 || before[k] === null)) desired[k] = t.fill[k]; });
        Object.keys(defaults || {}).forEach(function (k) { desired[k] = defaults[k]; });
        Object.keys(t.set || {}).forEach(function (k) { if (t.set[k] !== null) desired[k] = t.set[k]; });
        Object.keys(desired).forEach(function (k) {
            var value = k === 'lyrics' ? lyricsText(desired[k]) : desired[k];
            combined[k] = value;
            if (before[k] !== value) result[k] = value;
        });
        ranges(combined);
        return result;
    }
    function validatePlan(p) {
        keysOnly(p, ['version', 'kind', 'created_at', 'library_id', 'tracks'], 'plan');
        if (p.version !== 1 || p.kind !== 'music-tags-plan') fail('Invalid plan; prepare a new plan with this tool');
        id(p.library_id);
        if (!Array.isArray(p.tracks) || !p.tracks.length) fail('Invalid plan size');
        var ids = {}, paths = {};
        p.tracks.forEach(function (t) {
            keysOnly(t, ['id', 'before', 'set', 'artwork', 'sources'], 'plan track');
            var pid = id(t.id); if (ids[pid]) fail('Duplicate ID'); ids[pid] = true;
            keysOnly(t.before, ['metadata', 'path', 'sha256', 'artwork_count', 'file_artwork_present', 'duration'], 'before');
            if (t.before.file_artwork_present !== undefined && typeof t.before.file_artwork_present !== 'boolean') fail('Invalid file artwork flag');
            keysOnly(t.before.metadata, Object.keys(fields), 'before metadata');
            Object.keys(fields).forEach(function (k) { if (typeof t.before.metadata[k] !== fields[k]) fail('Incomplete before metadata: ' + k); });
            if (typeof t.before.path !== 'string' || t.before.path[0] !== '/' || !/\.(mp3|m4a)$/i.test(t.before.path)) fail('Only local MP3/M4A files are supported');
            if (!/^[a-f0-9]{64}$/.test(t.before.sha256)) fail('Invalid original checksum');
            if (!Number.isInteger(t.before.artwork_count) || t.before.artwork_count < 0) fail('Invalid artwork count');
            if (typeof t.before.duration !== 'number' || !isFinite(t.before.duration) || t.before.duration <= 0) fail('Invalid duration');
            if (paths[t.before.path]) fail('Multiple Music entries refer to the same file'); paths[t.before.path] = true;
            patch(t.set);
            var combined = {}; Object.keys(t.before.metadata).forEach(function (k) { combined[k] = t.before.metadata[k]; });
            Object.keys(t.set).forEach(function (k) { combined[k] = t.set[k]; }); ranges(combined);
            if (t.artwork !== null) {
                keysOnly(t.artwork, ['path', 'sha256', 'format', 'source_url', 'policy'], 'artwork');
                if (t.artwork.policy === 'embed_missing') {
                    if (t.before.file_artwork_present !== false || t.before.artwork_count > 1) fail('Embedded artwork already exists or Music has multiple pictures');
                } else if (t.artwork.policy !== undefined || t.before.artwork_count !== 0) fail('Only missing artwork can be added');
                if (typeof t.artwork.path !== 'string' || t.artwork.path[0] !== '/' || !/^[a-f0-9]{64}$/.test(t.artwork.sha256) || ['jpg', 'png'].indexOf(t.artwork.format) < 0) fail('Invalid artwork asset');
            }
        });
        return p;
    }
    function sameSnapshot(a, b) {
        return a.path === b.path && a.sha256 === b.sha256 && a.artwork_count === b.artwork_count &&
            (a.file_artwork_present === undefined || a.file_artwork_present === b.file_artwork_present) &&
            a.duration === b.duration && Object.keys(fields).every(function (k) { return a.metadata[k] === b.metadata[k]; });
    }
    function execute(p, io) {
        validatePlan(p);
        if (io.libraryID() !== p.library_id) fail('Another Music library is open');
        // All tracks and assets pass preflight before the first Music write.
        p.tracks.forEach(function (t) {
            if (!sameSnapshot(t.before, io.snapshot(t.id))) fail('Stale plan: ' + t.id + '. Prepare a new plan.');
            if (t.artwork) io.checkArtwork(t.artwork);
        });
        var log = {version: 1, kind: 'music-tags-journal', status: 'started', started_at: new Date().toISOString(), library_id: p.library_id, tracks: []};
        io.record(log);
        try {
            p.tracks.forEach(function (t, index) {
                if (!sameSnapshot(t.before, io.snapshot(t.id))) fail('Track changed after preflight: ' + t.id);
                var entry = {id: t.id, before: t.before, requested: t.set, artwork: t.artwork, status: 'started', steps: []};
                log.tracks.push(entry); io.record(log);
                if (Object.keys(t.set).length || t.artwork) {
                    entry.backup = io.backup(t.before.path, index, t.before.sha256); io.record(log);
                    Object.keys(t.set).forEach(function (k) {
                        entry.steps.push({field: k, value: t.set[k], status: 'attempting'}); io.record(log);
                        try { io.writeField(t.id, k, t.set[k]); }
                        catch (e) { fail('Track ' + t.id + ', field ' + k + ': ' + String(e.message || e)); }
                        if (io.readField(t.id, k) !== t.set[k]) fail('Music did not retain ' + k + ' for ' + t.id);
                        entry.steps[entry.steps.length - 1].status = 'music_verified'; io.record(log);
                    });
                    if (t.artwork) {
                        entry.steps.push({field: 'artwork', status: 'attempting'}); io.record(log);
                        io.addArtwork(t.id, t.artwork);
                        if (io.snapshot(t.id).artwork_count !== 1) fail('Artwork was not added');
                        entry.steps[entry.steps.length - 1].status = 'music_verified'; io.record(log);
                    }
                }
                entry.after = io.snapshot(t.id);
                Object.keys(fields).forEach(function (k) {
                    var expected = own(t.set, k) ? t.set[k] : t.before.metadata[k];
                    if (entry.after.metadata[k] !== expected) fail('Unexpected final value: ' + k);
                });
                if (entry.after.artwork_count !== (t.artwork ? Math.max(1, t.before.artwork_count) : t.before.artwork_count)) fail('Unexpected artwork count');
                entry.file_verification = io.verifyFile(entry.after.path, t.set, Boolean(t.artwork));
                if (!entry.file_verification.ok) fail('File verification failed; inspect the journal.');
                entry.status = 'verified'; io.record(log);
            });
            log.status = 'complete'; log.finished_at = new Date().toISOString(); io.record(log);
            return log;
        } catch (e) {
            if (log.tracks.length && log.tracks[log.tracks.length - 1].status === 'started') log.tracks[log.tracks.length - 1].status = 'failed';
            log.status = 'failed'; log.error = String(e.message || e); io.record(log); throw e;
        }
    }
    function preview(p) {
        validatePlan(p);
        var out = ['Music Tags — ' + p.tracks.length + ' tracks'];
        p.tracks.forEach(function (t) {
            out.push('\n' + t.before.metadata.artist + ' — ' + t.before.metadata.name + ' [' + t.id + ']');
            Object.keys(t.set).forEach(function (k) {
                if (k === 'lyrics') out.push('  lyrics: ' + t.before.metadata[k].length + ' → ' + t.set[k].length + ' characters (full text in plan)');
                else out.push('  ' + k + ': ' + JSON.stringify(t.before.metadata[k]) + ' → ' + JSON.stringify(t.set[k]));
            });
            if (t.artwork) out.push('  artwork: missing in file → ' + t.artwork.path);
            if (!Object.keys(t.set).length && !t.artwork) out.push('  No changes.');
        });
        return out.join('\n');
    }
    function genreKey(value) {
        if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\x00-\x1f]/.test(value)) fail('Genre must be a nonempty string');
        return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    }
    function genreIDs(ids, genres, genre) {
        var wanted = genreKey(genre);
        if (!Array.isArray(ids) || !Array.isArray(genres) || ids.length !== genres.length) fail('Library changed while reading genres; take a new snapshot');
        return ids.filter(function (_, i) { return typeof genres[i] === 'string' && genres[i].trim() && genreKey(genres[i]) === wanted; });
    }
    function auditSnapshot(s) {
        if (!object(s) || s.version !== 1 || !Array.isArray(s.tracks) || own(s, 'kind')) fail('Expected a snapshot JSON or editable request, not an execution plan');
        var draft = s.tracks.some(function (row) { return object(row) && own(row, 'expect'); });
        if (draft && s.tracks.length) validateRequest(s);
        var report = {version: 1, kind: 'music-tags-audit', basis: draft ? 'request' : 'snapshot', total: s.tracks.length, readable: 0, errors: [],
            artwork: {embedded: 0, missingEmbedded: 0, unknownEmbedded: 0, inMusic: 0, missingInMusic: 0, unknownInMusic: 0},
            lyrics: {present: 0, missing: 0, unknown: 0}, missing: {}, issues: []};
        var checked = Object.keys(fields).filter(function (k) { return k !== 'lyrics'; }), seen = {};
        checked.forEach(function (k) { report.missing[k] = 0; });
        s.tracks.forEach(function (row) {
            if (!object(row)) fail('Invalid snapshot row');
            var pid = id(row.id); if (seen[pid]) fail('Duplicate snapshot ID: ' + pid); seen[pid] = true;
            if (row.error) { report.errors.push({id: pid, error: String(row.error)}); return; }
            if (!draft && (!object(row.snapshot) || !object(row.snapshot.metadata))) fail('Snapshot row has no metadata: ' + pid);
            var before = draft ? row.info || {} : row.snapshot, m = draft ? {} : before.metadata, missing = [];
            if (draft) {
                m.name = row.expect.name; m.artist = row.expect.artist;
                [row.fill || {}, s.defaults || {}, row.set || {}].forEach(function (values) {
                    Object.keys(values).forEach(function (k) { if (values[k] !== null) m[k] = values[k]; });
                });
            }
            report.readable++;
            checked.forEach(function (k) {
                var value = m[k], absent = typeof value !== fields[k];
                if (!absent && fields[k] === 'string') absent = !value.trim();
                if (!absent && fields[k] === 'number') absent = !isFinite(value) || value <= 0;
                if (absent) { report.missing[k]++; missing.push(k); }
            });
            var embedded = typeof before.file_artwork_present === 'boolean' ? before.file_artwork_present : null;
            var inMusic = Number.isInteger(before.artwork_count) && before.artwork_count >= 0 ? before.artwork_count > 0 : null;
            report.artwork[embedded === null ? 'unknownEmbedded' : embedded ? 'embedded' : 'missingEmbedded']++;
            report.artwork[inMusic === null ? 'unknownInMusic' : inMusic ? 'inMusic' : 'missingInMusic']++;
            var lyrics = draft ? (typeof before.lyrics_present === 'boolean' ? before.lyrics_present : null) : typeof m.lyrics === 'string' && Boolean(m.lyrics.trim());
            report.lyrics[lyrics === null ? 'unknown' : lyrics ? 'present' : 'missing']++;
            if (missing.length || embedded !== true || inMusic !== true || !lyrics) report.issues.push({id: pid, name: m.name || '', artist: m.artist || '', missing: missing, artworkInFile: embedded, artworkInMusic: inMusic, lyrics: lyrics});
        });
        return report;
    }
    function editableSnapshot(s) {
        if (!s.tracks.length) fail('No tracks to export');
        var checked = auditSnapshot(s);
        if (checked.errors.length) fail('Export blocked: ' + checked.errors.length + ' selected tracks could not be read; no partial request saved\n' + checked.errors.map(function (e) { return '[' + e.id + '] ' + e.error; }).join('\n'));
        var request = {version: 1, description: 'Editable snapshot. Edit set values in this file; null means leave unchanged. info is read-only context at export. Attach covers/lyrics with relative paths. Existing lyrics are not copied into set.', tracks: []};
        s.tracks.forEach(function (row) {
            var source = row.snapshot, m = source.metadata, values = {};
            Object.keys(fields).forEach(function (k) {
                var v = m[k], known = typeof v === fields[k];
                if (fields[k] === 'string') known = known && Boolean(v.trim());
                if (fields[k] === 'number') known = known && isFinite(v) && v > 0;
                values[k] = k === 'lyrics' || !known ? null : v;
            });
            request.tracks.push({id: row.id, expect: {name: m.name, artist: m.artist}, set: values, fill: {},
                artwork_file: null, lyrics_file: null, lyrics_policy: null,
                info: {duration: typeof source.duration === 'number' ? source.duration : null, favorite: typeof source.favorite === 'boolean' ? source.favorite : null,
                    artwork_count: typeof source.artwork_count === 'number' ? source.artwork_count : null, file_artwork_present: typeof source.file_artwork_present === 'boolean' ? source.file_artwork_present : null,
                    lyrics_present: typeof m.lyrics === 'string' && Boolean(m.lyrics.trim())}});
        });
        return validateRequest(request);
    }
    function snapshotInfo(rows, limit) {
        if (limit === undefined) limit = 20;
        if (limit !== null && (!Number.isInteger(limit) || limit < 0)) fail('Invalid display limit');
        function safe(value, fallback) { return typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim() : fallback; }
        function time(value) {
            if (typeof value !== 'number' || !isFinite(value) || value < 0) return '?';
            var n = Math.floor(value), seconds = String(n % 60).padStart(2, '0'), minutes = Math.floor(n / 60);
            return minutes < 60 ? minutes + ':' + seconds : Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') + ':' + seconds;
        }
        var total = 0, unknownTime = 0, favorites = 0, unknownFavorites = 0;
        rows.forEach(function (row) {
            if (typeof row.duration === 'number' && isFinite(row.duration) && row.duration >= 0) total += row.duration; else unknownTime++;
            if (row.favorite === true) favorites++; else if (row.favorite !== false) unknownFavorites++;
        });
        var count = limit === null ? rows.length : Math.min(limit, rows.length);
        var out = ['Music Tags — ' + rows.length + ' tracks',
            'Duration: ' + time(total) + (unknownTime ? ' (unknown: ' + unknownTime + ')' : '') + ' | Favorites: ' + favorites + (unknownFavorites ? ' (unknown: ' + unknownFavorites + ')' : ''),
            '\nShowing ' + count + '/' + rows.length + ':'];
        rows.slice(0, count).forEach(function (row, index) {
            var year = typeof row.year === 'number' && row.year > 0 ? String(row.year) : '?';
            out.push('  ' + (index + 1) + '. ' + safe(row.artist, '<no artist>') + ' — ' + safe(row.name, '<untitled>') +
                ' | ' + time(row.duration) + ' | ' + safe(row.album, '<no album>') + ' (' + year + ')' +
                ' | fav:' + (row.favorite === true ? '+' : row.favorite === false ? '-' : '?'));
        });
        if (count < rows.length) out.push('  ... ' + (rows.length - count) + ' more; use --show all to display every track.');
        return out.join('\n');
    }
    return {fields: fields, id: id, normalizeLyrics: normalizeLyrics, lyricsText: lyricsText, validateRequest: validateRequest, changes: changes, validatePlan: validatePlan, sameSnapshot: sameSnapshot, execute: execute, preview: preview, genreKey: genreKey, genreIDs: genreIDs, auditSnapshot: auditSnapshot, editableSnapshot: editableSnapshot, snapshotInfo: snapshotInfo};
}());
if (typeof module !== 'undefined') module.exports = MusicMVP;
