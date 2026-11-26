/* Read-only support for version 1 documents. No file or Music writes. */
var Legacy = (function (core) {
    'use strict';
    var fields = {
        name: 'string', artist: 'string', album: 'string', albumArtist: 'string',
        composer: 'string', genre: 'string', year: 'number', trackNumber: 'number',
        trackCount: 'number', discNumber: 'number', discCount: 'number', compilation: 'boolean', lyrics: 'string'
    };
    var id=core.id, lyricsText=core.lyricsText;
    function fail(message) { throw new Error(message); }
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function object(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
    function keysOnly(o, allowed, label) {
        if (!object(o)) fail(label + ': expected object');
        Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) fail(label + ': unsupported field ' + k); });
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
    function preview(p) {
        validatePlan(p);
        var out = ['Music Doctor — ' + p.tracks.length + ' tracks'];
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
    function auditPreview(report) {
        var a = report.artwork, out = ['Music Doctor audit — ' + report.total + ' records; readable: ' + report.readable + '; errors: ' + report.errors.length,
            'Embedded artwork: ' + a.embedded + '; missing: ' + a.missingEmbedded + '; unknown: ' + a.unknownEmbedded,
            'Artwork in Music: ' + a.inMusic + '; missing: ' + a.missingInMusic + '; unknown: ' + a.unknownInMusic,
            'Lyrics: ' + report.lyrics.present + '; missing: ' + report.lyrics.missing + '; unknown: ' + report.lyrics.unknown,
            '\nMissing metadata (readable records only):'];
        if (report.basis === 'request') out.splice(1, 0, 'Editable request: metadata uses draft values; media/lyrics status is from info at export.');
        var gaps = Object.keys(report.missing).filter(function (k) { return report.missing[k] > 0; });
        gaps.forEach(function (k) { out.push('  ' + k + ': ' + report.missing[k]); });
        if (!gaps.length) out.push('  None.');
        if (report.issues.length) out.push('\nTracks to review:');
        report.issues.forEach(function (t) {
            var issues = t.missing.slice();
            if (t.artworkInFile === false) issues.push('embedded artwork missing');
            if (t.artworkInFile === null) issues.push('embedded artwork unknown');
            if (t.artworkInMusic === false) issues.push('Music artwork missing');
            if (t.artworkInMusic === null) issues.push('Music artwork unknown');
            if (t.lyrics !== true) issues.push(t.lyrics === null ? 'lyrics unknown' : 'lyrics missing');
            out.push('  ' + t.artist + ' — ' + t.name + ' [' + t.id + ']: ' + issues.join(', '));
        });
        report.errors.forEach(function (e) { out.push('  ERROR [' + e.id + ']: ' + e.error); });
        out.push('\nPresence check only; metadata correctness and cover quality are not verified.');
        return out.join('\n');
    }
    return {validateRequest:validateRequest,validatePlan:validatePlan,preview:preview,auditSnapshot:auditSnapshot,auditPreview:auditPreview};
}(MusicCore));
if (typeof module !== 'undefined') module.exports = Legacy;
