/* Pure ES5: shared by macOS JXA and the development tests. No packages. */
var MusicMVP = (function () {
    'use strict';
    var fields = {
        name: 'string', artist: 'string', album: 'string', albumArtist: 'string',
        composer: 'string', genre: 'string', year: 'number', trackNumber: 'number',
        trackCount: 'number', discNumber: 'number', discCount: 'number', compilation: 'boolean'
    };
    function fail(message) { throw new Error(message); }
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function object(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
    function keysOnly(o, allowed, label) {
        if (!object(o)) fail(label + ': expected object');
        Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) fail(label + ': unsupported field ' + k); });
    }
    function id(value) {
        if (typeof value !== 'string' || !/^[A-Fa-f0-9]{16}$/.test(value)) fail('Invalid Persistent ID');
        return value.toUpperCase();
    }
    function patch(o) {
        keysOnly(o, Object.keys(fields), 'metadata');
        Object.keys(o).forEach(function (k) {
            var v = o[k];
            if (typeof v !== fields[k]) fail(k + ': invalid type');
            if (typeof v === 'string' && (!v.trim() || v.length > 2000 || /[\x00-\x1f]/.test(v))) fail(k + ': invalid text');
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
        keysOnly(r.defaults || {}, ['genre'], 'defaults'); patch(r.defaults || {});
        if (!Array.isArray(r.tracks) || !r.tracks.length || r.tracks.length > 20) fail('MVP accepts 1–20 tracks');
        var seen = {};
        r.tracks.forEach(function (t) {
            keysOnly(t, ['id', 'expect', 'set', 'fill', 'artwork_catalog_id', 'sources'], 'track');
            var pid = id(t.id); if (seen[pid]) fail('Duplicate track ' + pid); seen[pid] = true;
            keysOnly(t.expect, ['name', 'artist'], 'expect');
            if (!t.expect.name || !t.expect.artist) fail('Both expect.name and expect.artist are required');
            patch(t.expect); patch(t.set || {}); patch(t.fill || {});
            if (t.artwork_catalog_id !== undefined && (!Number.isSafeInteger(t.artwork_catalog_id) || t.artwork_catalog_id < 1)) fail('Invalid catalogue ID');
            if (t.sources !== undefined && (!Array.isArray(t.sources) || t.sources.some(function (u) { return typeof u !== 'string' || !/^https:\/\//.test(u); }))) fail('Invalid sources');
        });
        return r;
    }
    function changes(t, before, defaults) {
        if (t.expect.name !== before.name || t.expect.artist !== before.artist) fail('Identity differs for ' + t.id + '; inspect the current track');
        var desired = {}, result = {}, combined = {};
        Object.keys(before).forEach(function (k) { combined[k] = before[k]; });
        Object.keys(t.fill || {}).forEach(function (k) { if (before[k] === '' || before[k] === 0 || before[k] === null) desired[k] = t.fill[k]; });
        Object.keys(defaults || {}).forEach(function (k) { desired[k] = defaults[k]; });
        Object.keys(t.set || {}).forEach(function (k) { desired[k] = t.set[k]; });
        Object.keys(desired).forEach(function (k) { combined[k] = desired[k]; if (before[k] !== desired[k]) result[k] = desired[k]; });
        ranges(combined);
        return result;
    }
    function validatePlan(p) {
        keysOnly(p, ['version', 'kind', 'created_at', 'library_id', 'tracks'], 'plan');
        if (p.version !== 1 || p.kind !== 'music-mvp-plan') fail('Invalid plan');
        id(p.library_id);
        if (!Array.isArray(p.tracks) || !p.tracks.length || p.tracks.length > 20) fail('Invalid plan size');
        var ids = {}, paths = {};
        p.tracks.forEach(function (t) {
            keysOnly(t, ['id', 'before', 'set', 'artwork', 'sources'], 'plan track');
            var pid = id(t.id); if (ids[pid]) fail('Duplicate ID'); ids[pid] = true;
            keysOnly(t.before, ['metadata', 'path', 'sha256', 'artwork_count', 'duration'], 'before');
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
                keysOnly(t.artwork, ['path', 'sha256', 'format', 'source_url', 'catalog_id'], 'artwork');
                if (t.before.artwork_count !== 0) fail('MVP only adds missing artwork');
                if (typeof t.artwork.path !== 'string' || t.artwork.path[0] !== '/' || !/^[a-f0-9]{64}$/.test(t.artwork.sha256) || ['jpg', 'png'].indexOf(t.artwork.format) < 0) fail('Invalid artwork asset');
            }
        });
        return p;
    }
    function sameSnapshot(a, b) {
        return a.path === b.path && a.sha256 === b.sha256 && a.artwork_count === b.artwork_count &&
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
        var log = {version: 1, kind: 'music-mvp-journal', status: 'started', started_at: new Date().toISOString(), library_id: p.library_id, tracks: []};
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
                        io.writeField(t.id, k, t.set[k]);
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
                if (entry.after.artwork_count !== t.before.artwork_count + (t.artwork ? 1 : 0)) fail('Unexpected artwork count');
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
        var out = ['Music MVP — ' + p.tracks.length + ' tracks; library ' + p.library_id];
        p.tracks.forEach(function (t) {
            out.push('\n' + t.before.metadata.artist + ' — ' + t.before.metadata.name + ' [' + t.id + ']');
            Object.keys(t.set).forEach(function (k) { out.push('  ' + k + ': ' + JSON.stringify(t.before.metadata[k]) + ' → ' + JSON.stringify(t.set[k])); });
            if (t.artwork) out.push('  artwork: missing → ' + t.artwork.path);
            if (!Object.keys(t.set).length && !t.artwork) out.push('  No changes.');
        });
        return out.join('\n');
    }
    return {fields: fields, id: id, validateRequest: validateRequest, changes: changes, validatePlan: validatePlan, sameSnapshot: sameSnapshot, execute: execute, preview: preview};
}());
if (typeof module !== 'undefined') module.exports = MusicMVP;
