/* Request/plan version 2. This module never opens Music or files. */
var MusicCore = (function () {
    'use strict';
    var strings = ['name', 'artist', 'album', 'albumArtist', 'composer', 'genre'];
    var numbers = ['year', 'trackNumber', 'trackCount', 'discNumber', 'discCount'];
    var fields = strings.concat(numbers, ['compilation']);
    var presenceFields = fields.concat(['artwork', 'lyrics']);
    var assetKinds = ['artwork', 'lyrics'];
    var hash = /^[a-f0-9]{64}$/;
    function fail(message) { throw new Error(message); }
    function normalizeLyrics(s) { var v=s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');return v.trim()?v:''; }
    function lyricsText(s) {
        if (typeof s !== 'string' || !s.trim() || s.length > 100000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s) || /<!doctype\s+html|<html[\s>]/i.test(s)) fail('Lyrics must be nonempty plain text (up to 100000 characters)');
        return normalizeLyrics(s);
    }
    function id(value) {
        if (typeof value !== 'string' || !/^[A-Fa-f0-9]{16}$/.test(value)) fail('Invalid Persistent ID');
        return value.toUpperCase();
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
        var out = ['Music Doctor — ' + rows.length + ' tracks',
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
    function check(ok, message) { if (!ok) throw new Error(message); }
    function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
    function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function keys(row, allowed, label) {
        check(object(row), 'Expected ' + label + ' object');
        Object.keys(row).forEach(function (key) { check(allowed.indexOf(key) >= 0, 'Unknown ' + label + ' field: ' + key); });
    }
    function validString(v) { return typeof v === 'string' && v.trim() && v.length <= 2000 && !/[\x00-\x1f]/.test(v); }
    function validValue(key, value) {
        if (value === null) return true;
        if (strings.indexOf(key) >= 0) return Array.isArray(value) ?
            value.length > 0 && value.every(validString) : Boolean(validString(value));
        if (numbers.indexOf(key) >= 0) return Number.isInteger(value) && value >= 1 && value <= 9999;
        return key === 'compilation' && typeof value === 'boolean';
    }
    function tags(row, label, allowNull) {
        keys(row, fields, label);
        Object.keys(row).forEach(function (field) {
            check((allowNull || row[field] !== null) && validValue(field, row[field]), 'Invalid ' + label + '.' + field);
        });
    }
    function path(value, absolute) {
        return typeof value === 'string' && value.trim().length > 0 && !/\x00/.test(value) && (!absolute || value[0] === '/');
    }
    function sha(value) { return typeof value === 'string' && hash.test(value); }
    function assetPath(row, kind) {
        return typeof row[kind] === 'string' ? row[kind] : row[kind+'_file'] || null;
    }
    function musicIDs(track) {
        if (!own(track, 'music_ids')) return;
        var ids = track.music_ids;
        check(Array.isArray(ids) && ids.every(function (id) {return typeof id === 'string' && /^[a-fA-F0-9]{16}$/.test(id); }) &&
              new Set(ids.map(function (id) {return id.toUpperCase(); })).size === ids.length, 'Invalid music_ids');
    }
    function records(rows, label, visit) {
        check(Array.isArray(rows) && rows.length > 0, 'Expected nonempty ' + label + ' tracks');
        var paths = new Set();
        rows.forEach(function (row) {
            check(object(row) && path(row.path, true) && sha(row.sha256), 'Track requires absolute path and SHA-256');
            check(!paths.has(row.path), 'Repeated file path: ' + row.path);
            paths.add(row.path);
            musicIDs(row);
            visit(row);
        });
    }
    function request(value) {
        keys(value, ['version', 'tracks', 'description', 'defaults'], 'request');
        check(value.version === 2, 'Expected request version 2. Export a new snapshot to migrate.');
        if (own(value,'description')) check(typeof value.description === 'string','Invalid description');
        if (own(value,'defaults')) tags(value.defaults,'defaults',true);
        records(value.tracks, 'request', function (row) {
            keys(row, ['path','sha256','tags','fill','music_suggestions','music_ids','from_music','has','artwork_file','lyrics_file','lyrics_url'].concat(assetKinds), 'track');
            check(/\.(mp3|m4a)$/i.test(row.path), 'Unsupported file path: ' + row.path);
            tags(row.tags,'tags',true);
            if (own(row,'fill')) tags(row.fill,'fill',true);
            if (own(row,'music_suggestions')) tags(row.music_suggestions,'music_suggestions',false);
            if (own(row,'has')) {
                keys(row.has,assetKinds,'has');
                Object.keys(row.has).forEach(function (key) {
                    check(row.has[key] === null || typeof row.has[key] === 'boolean','Invalid has.' + key);
                });
            }
            assetKinds.forEach(function (kind) {
                var legacy = kind + '_file', value = row[kind];
                if (own(row,legacy)) check(row[legacy] === null || path(row[legacy],false), 'Invalid ' + legacy);
                if (own(row,kind)) {
                    check(value === null || typeof value === 'boolean' || path(value,false), 'Invalid ' + kind);
                    check(row[legacy] == null || row[legacy] === value, 'Conflicting ' + kind + ' and ' + legacy);
                }
            });
            if (row.lyrics_url != null) check(typeof row.lyrics_url === 'string' && /^https:\/\/[^\s\x00-\x1f]+$/i.test(row.lyrics_url) &&
                !assetPath(row,'lyrics'), 'Use a single HTTPS lyrics URL or TXT source');
            if (own(row,'from_music')) check(Array.isArray(row.from_music) && row.from_music.every(function (key) {
                return presenceFields.indexOf(key) >= 0;
            }) && new Set(row.from_music).size === row.from_music.length, 'Invalid from_music');
        });
        return value;
    }
    function equal(a,b) {
        if (a === b) return true;
        if (Array.isArray(a) || Array.isArray(b))
            return JSON.stringify(Array.isArray(a) ? a : [a]) === JSON.stringify(Array.isArray(b) ? b : [b]);
        return false;
    }
    function effective(row, defaults, actual, force) {
        var result = {};
        fields.forEach(function (key) {
            var next = row.tags[key];
            if (next == null && defaults) next = defaults[key];
            if (next == null && row.fill && actual.has[key] === false) next = row.fill[key];
            if (next != null) {
                check(actual.has[key] !== null, 'Cannot overwrite ambiguous field: ' + key);
                if (force || !equal(next,actual.tags[key])) result[key] = next;
            }
        });
        var merged = Object.assign({},actual.tags,result);
        [['trackNumber','trackCount'],['discNumber','discCount']].forEach(function (pair) {
            if (own(result,pair[0]) || own(result,pair[1]))
                check(!merged[pair[0]] || !merged[pair[1]] || merged[pair[0]] <= merged[pair[1]], pair[0] + ' exceeds ' + pair[1]);
        });
        return result;
    }
    function asset(record, label) {
        keys(record,['path','sha256','size'],'asset');
        check(path(record.path,true) && sha(record.sha256) && Number.isSafeInteger(record.size) && record.size > 0 &&
            record.size <= (label === 'artwork' ? 15000000 : 400000), 'Invalid ' + label + ' asset');
    }
    function plan(value) {
        keys(value,['version','kind','created_at','force','tracks'],'plan');
        check(value.version === 2 && value.kind === 'music-tags-file-plan' && typeof value.force === 'boolean' &&
            typeof value.created_at === 'string','Expected prepared file plan version 2');
        var identities = new Set();
        records(value.tracks,'plan',function (row) {
            keys(row,['path','sha256','identity','before','tags','artwork','lyrics','music_ids','id3_migration'],'plan track');
            check(typeof row.identity === 'string' && /^\d+:\d+$/.test(row.identity) && !identities.has(row.identity),'Repeated or invalid physical file');
            identities.add(row.identity);
            if (own(row,'id3_migration')) {
                keys(row.id3_migration,['from','to'],'ID3 migration');
                check(row.id3_migration.from === 2 && row.id3_migration.to === 3 && /\.mp3$/i.test(row.path) &&
                    (Object.keys(row.tags).length > 0 || row.artwork || row.lyrics),'Invalid ID3 migration');
            }
            check(object(row.before),'Missing source tags');
            tags(row.tags,'plan tags',false);
            ['artwork','lyrics'].forEach(function (key) { if (own(row,key)) asset(row[key],key); });
        });
        return value;
    }
    function preview(value) {
        plan(value);
        var out = ['Music Doctor — ' + value.tracks.length + ' files | force=' + value.force];
        value.tracks.forEach(function (row) {
            out.push('\n' + row.path);
            if (row.id3_migration) out.push('  ID3v2.2 → ID3v2.3');
            var keys = Object.keys(row.tags);
            keys.forEach(function (key) {
                var before = row.before[key], after = row.tags[key];
                out.push('  ' + key + ': ' + JSON.stringify(before == null ? null : before) + ' → ' + JSON.stringify(after) +
                    (equal(before,after) ? ' [forced rewrite]' : ''));
            });
            ['artwork','lyrics'].forEach(function (key) {
                if (row[key]) {
                    var old = row.before[key];
                    out.push('  ' + key + ': ' + (old ? old.size + ' B ' + old.sha256.slice(0,12) : 'missing') +
                        ' → ' + row[key].size + ' B ' + row[key].sha256.slice(0,12) +
                        (old && old.sha256 === row[key].sha256 ? ' [forced rewrite]' : ''));
                }
            });
            if (!keys.length && !row.artwork && !row.lyrics) out.push('  No changes.');
        });
        return out.join('\n');
    }
    function prepareArgs(argv) {
        var paths = [], force, seen = false;
        for (var i=0; i<argv.length; i++) {
            var arg = argv[i];
            if (arg === '--force') {
                check(!seen && (argv[i+1] === 'true' || argv[i+1] === 'false'),'--force requires exactly one true or false value');
                seen = true; force = argv[++i] === 'true';
            } else {
                check(arg.slice(0,2) !== '--','Unknown prepare option: ' + arg);
                paths.push(arg);
            }
        }
        check(paths.length === 2,'Use prepare request.json plan.json [--force true|false]');
        return {input:paths[0],output:paths[1],force:Boolean(force)};
    }
    function targetSummary(row) {
        var summary = {};
        if (row.id3_migration) summary.id3_version = {before:2,after:3};
        Object.keys(row.tags).forEach(function (key) {
            summary[key] = {before: row.before[key] == null ? null : row.before[key], after: row.tags[key]};
        });
        ['artwork','lyrics'].forEach(function (key) {
            if (row[key]) summary[key] = {before: row.before[key] || null, after:{sha256:row[key].sha256,size:row[key].size}};
        });
        return summary;
    }
    return {id:id,normalizeLyrics:normalizeLyrics,lyricsText:lyricsText,snapshotInfo:snapshotInfo,fields:fields,presenceFields:presenceFields,validValue:validValue,request:request,plan:plan,
        effective:effective,assetPath:assetPath,preview:preview,prepareArgs:prepareArgs,targetSummary:targetSummary};
}());
if (typeof module !== 'undefined') module.exports = MusicCore;
