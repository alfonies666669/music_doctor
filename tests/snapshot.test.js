'use strict';
// Read-only selection and audit regressions; no real Music Apple events.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const core = require('../core.js');
const filters = require('../filters.js');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
const pid = n => n.toString(16).padStart(16, '0').toUpperCase();
function state() {
    const metadata = Object.fromEntries(Object.entries(core.fields).map(([k, t]) => [k, t === 'string' ? 'Filled' : t === 'number' ? 1 : false]));
    return {metadata, duration: 180, artwork_count: 1, file_artwork_present: true};
}
function document(rows) { return {version: 1, tracks: rows}; }
test('genre selection is case/space insensitive and never includes a prefixed genre', () => {
    const genres = ['Custom Hip-Hop', 'Russian Custom Hip-Hop', ' custom   hip-hop ', '', null];
    assert.deepEqual(core.genreIDs(genres.map((_, i) => pid(i + 1)), genres, 'CUSTOM HIP-HOP'), [pid(1), pid(3)]);
    assert.deepEqual(core.genreIDs([pid(1)], ['Custom Hip Hop'], 'Custom Hip-Hop'), []);
});
test('Unicode equivalents match; empty genres and inconsistent bulk reads fail', () => {
    assert.deepEqual(core.genreIDs([pid(1)], ['Cafe\u0301 Rap'], 'Café Rap'), [pid(1)]);
    assert.throws(() => core.genreIDs([], [], ' '), /nonempty/);
    assert.throws(() => core.genreIDs([pid(1)], [], 'Rap'), /Library changed/);
});
test('complete metadata includes compilation=false and has no review issues', () => {
    const data = document([{id: pid(1), snapshot: state()}]);
    const original = JSON.stringify(data), result = core.auditSnapshot(data);
    assert.equal(result.readable, 1); assert.equal(result.missing.compilation, 0);
    assert.equal(result.issues.length, 0); assert.equal(JSON.stringify(data), original);
});
test('cached Music artwork is distinct from artwork embedded in the audio file', () => {
    const cached = state(); cached.file_artwork_present = false;
    cached.metadata.album = ''; cached.metadata.year = 0; cached.metadata.lyrics = '  ';
    const result = core.auditSnapshot(document([{id: pid(1), snapshot: cached}]));
    assert.equal(result.artwork.inMusic, 1); assert.equal(result.artwork.missingEmbedded, 1);
    assert.equal(result.missing.album, 1); assert.equal(result.missing.year, 1);
    assert.equal(result.lyrics.missing, 1); assert.deepEqual(result.issues[0].missing, ['album', 'year']);
});
test('old snapshots retain unknown artwork flags rather than being reported as missing', () => {
    const old = state(); delete old.file_artwork_present; delete old.artwork_count;
    const result = core.auditSnapshot(document([{id: pid(1), snapshot: old}]));
    assert.equal(result.artwork.unknownEmbedded, 1); assert.equal(result.artwork.missingEmbedded, 0);
    assert.equal(result.artwork.unknownInMusic, 1);
});
test('unreadable files are reported separately and not counted as metadata gaps', () => {
    const result = core.auditSnapshot(document([{id: pid(1), snapshot: state()}, {id: pid(2), error: 'Missing local file'}]));
    assert.equal(result.total, 2); assert.equal(result.readable, 1); assert.equal(result.errors.length, 1);
    assert.equal(result.artwork.embedded, 1); assert.equal(result.missing.album, 0);
});
test('empty legacy snapshots and editable requests are auditable; plans and duplicate IDs are rejected', () => {
    assert.equal(core.auditSnapshot(document([])).total, 0);
    const report = core.auditSnapshot({version: 1, tracks: [{id: pid(1), expect: {name: 'Song', artist: 'Artist'}, set: {album: 'Draft Album'}}]});
    assert.equal(report.basis, 'request'); assert.equal(report.missing.album, 0);
    assert.equal(report.lyrics.unknown, 1); assert.equal(report.lyrics.missing, 0);
    assert.throws(() => core.auditSnapshot({version: 1, kind: 'music-tags-plan', tracks: []}), /snapshot JSON/);
    const row = {id: pid(1), snapshot: state()};
    assert.throws(() => core.auditSnapshot(document([row, row])), /Duplicate/);
});
const context = vm.createContext({ObjC: {import() {}}, $: {NSFileManager: {defaultManager: {}}}, console: {log() {}}});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../jxa.js'), 'utf8'), context);
const plain = value => JSON.parse(JSON.stringify(value));
test('snapshot CLI accepts genre, playlist and all-library forms, and rejects incomplete flags', () => {
    const selection = filters.parse(['--genre', 'Custom Hip-Hop', 'out.json']);
    assert.equal(selection.kind, 'genre'); assert.equal(selection.value, 'Custom Hip-Hop'); assert.equal(selection.output, 'out.json');
    assert.deepEqual(selection.filter, {genre: {eq: 'Custom Hip-Hop'}});
    assert.equal(filters.parse(['French', 'out.json']).kind, 'playlist');
    assert.equal(filters.parse(['--all', 'out.json']).kind, 'all');
    assert.throws(() => filters.parse(['--genre']), /Missing value/);
    assert.throws(() => filters.parse(['French', 'one', 'two']), /Use snapshot/);
});
test('genre adapter reads IDs and genres in bulk', () => {
    const calls = [];
    context.Application = () => ({libraryPlaylists: [{exists: () => true, tracks: {
        persistentID: () => {calls.push('ids'); return [pid(1), pid(2)];},
        genre: () => {calls.push('genres'); return ['Custom Hip-Hop', 'Russian Custom Hip-Hop'];}
    }}]});
    assert.deepEqual(context.musicIO(core, '/tool').genre('custom hip-hop'), [pid(1)]);
    assert.deepEqual(calls, ['ids', 'genres']);
});
test('collection deduplicates IDs, records read failures and rejects a genre changed during reading', () => {
    const selection = filters.parse(['--genre', 'Custom Hip-Hop', 'out.json']), checked = [];
    const io = {candidates: () => ({favorite_property: 'favorited', rows: [pid(1), pid(1), pid(2), pid(3)].map(id => ({id, genre: selection.value, favorite: false}))}), libraryID: () => pid(100), snapshot: id => {
        checked.push(id);
        if (id === pid(2)) throw Error('Missing local file');
        const s = state(); s.metadata.genre = id === pid(3) ? 'Other' : selection.value; return s;
    }};
    const result = plain(context.collectSnapshot(selection, io, core, filters));
    assert.equal(result.tracks.length, 3); assert.equal(checked.length, 3);
    assert.equal(result.genre, selection.value); assert.equal(result.selection.kind, 'genre');
    assert.match(result.tracks[1].error, /Missing local file/); assert.match(result.tracks[2].error, /Filter fields changed/);
});
test('playlist snapshots retain their previous playlist field and audit output separates unknowns', () => {
    const selection = filters.parse(['French', 'out.json']);
    const result = plain(context.collectSnapshot(selection, {candidates: s => {assert.equal(s.scope.value, 'French'); return {rows: [], favorite_property: null};}, libraryID: () => pid(100)}, core, filters));
    assert.equal(result.playlist, 'French'); assert.equal(result.tracks.length, 0);
    assert.match(context.auditPreview(core.auditSnapshot(result)), /readable: 0/);
});
test('navigation bulk reads display and filter columns once without using per-track properties', () => {
    const calls = [], tracks = {
        persistentID: () => {calls.push('ids'); return [pid(1), pid(2)];},
        artist: () => {calls.push('artist'); return ['A', 'B'];},
        name: () => {calls.push('name'); return ['Song A', 'Song B'];},
        album: () => {calls.push('album'); return ['', 'Album B'];},
        year: () => {calls.push('year'); return [0, 2020];},
        duration: () => {calls.push('duration'); return [90, 300];},
        favorited: () => {calls.push('favorited'); return [true, false];}
    };
    context.Application = () => ({libraryPlaylists: [{exists: () => true, tracks}]});
    const result = plain(context.musicIO(core, '/tool').candidates(filters.parse(['--artist', 'A', '--sort', 'duration', 'out.json']), filters));
    assert.equal(result.favorite_property, 'favorited');
    assert.equal(calls.filter(x => x === 'ids').length, 2);
    for (const key of ['name', 'artist', 'album', 'year', 'duration', 'favorited']) assert.equal(calls.filter(x => x === key).length, 1);
    assert.deepEqual(result.rows[0], {id: pid(1), name: 'Song A', artist: 'A', album: '', year: 0, duration: 90, favorite: true});
});
function displayColumns(n) {
    return {name: () => Array(n).fill('Song'), artist: () => Array(n).fill('Artist'), album: () => Array(n).fill(''), year: () => Array(n).fill(0), duration: () => Array(n).fill(180)};
}
test('favorite adapter supports the previous loved property and fails explicitly when neither is available', () => {
    let tracks = {...displayColumns(1), persistentID: () => [pid(1)], loved: () => [true]};
    context.Application = () => ({libraryPlaylists: [{exists: () => true, tracks}]});
    const selection = filters.parse(['--favorite', 'true', 'out.json']);
    assert.equal(context.musicIO(core, '/tool').candidates(selection, filters).favorite_property, 'loved');
    tracks = {...displayColumns(1), persistentID: () => [pid(1)]};
    assert.throws(() => context.musicIO(core, '/tool').candidates(selection, filters), /does not expose/);
    assert.equal(context.musicIO(core, '/tool').candidates(filters.parse(['--all', 'out.json']), filters).rows[0].favorite, null);
});
test('navigation rejects a reordered library rather than aligning mismatched bulk columns', () => {
    let reads = 0;
    const tracks = {...displayColumns(2), persistentID: () => ++reads === 1 ? [pid(1), pid(2)] : [pid(2), pid(1)], favorited: () => [true, false]};
    context.Application = () => ({libraryPlaylists: [{exists: () => true, tracks}]});
    assert.throws(() => context.musicIO(core, '/tool').candidates(filters.parse(['--all', 'out.json']), filters), /order changed/);
});
test('bulk Music paths are matched by stable file track IDs and fall back on inconsistent data', () => {
    const ids = [pid(2), pid(1), pid(3), pid(4)];
    const calls = [];
    const tracks = {
        persistentID: () => {calls.push('ids'); return ids;},
        location: () => {calls.push('paths'); return [{toString: () => '/two.mp3'}, '/one.m4a', '/stream.m4a', null];},
        kind: () => {calls.push('kinds'); return ['MPEG audio file', 'AAC audio file', 'Apple Music AAC audio file', 'AAC audio file'];}
    };
    context.Application = () => ({libraryPlaylists: [{exists: () => true, fileTracks: tracks}]});
    const io = context.musicIO(core, '/tool');
    assert.deepEqual(Array.from(io.filePaths(), pair => Array.from(pair)), [[pid(2), '/two.mp3'], [pid(1), '/one.m4a']]);
    assert.deepEqual(calls, ['ids', 'paths', 'kinds', 'ids']);
    let reads = 0;
    tracks.persistentID = () => ++reads === 1 ? ids : ids.slice().reverse();
    assert.equal(io.filePaths().size, 0);
    tracks.persistentID = () => ids;
    tracks.location = () => ['/two.mp3'];
    assert.equal(io.filePaths().size, 0);
    tracks.location = () => {throw new Error('Bulk paths unavailable');};
    assert.equal(io.filePaths().size, 0);
});
test('combined collection sorts selected tracks, exports favorite separately and rechecks it', () => {
    const selection = filters.parse(['--favorite', 'true', '--sort', 'duration', '--desc', 'out.json']);
    const fixture = state(), before = JSON.stringify(fixture), queried = [];
    const result = plain(context.collectSnapshot(selection, {
        candidates: () => ({favorite_property: 'favorited', rows: [{id: pid(1), duration: 90, favorite: true}, {id: pid(2), duration: 300, favorite: true}, {id: pid(3), duration: 400, favorite: false}]}),
        libraryID: () => pid(100), favorite: id => id !== pid(1), snapshot: id => {queried.push(id); return fixture;}
    }, core, filters));
    assert.deepEqual(queried, [pid(2), pid(1)]); assert.equal(result.tracks[0].snapshot.favorite, true);
    assert.match(result.tracks[1].error, /Filter fields changed/); assert.equal(JSON.stringify(fixture), before);
});
test('light console preview never reads audio, hashes or creates files', () => {
    const forbidden = () => {throw Error('Forbidden in light mode');};
    context.absolute = context.exists = context.mkdir = context.saveJSON = context.sha = context.fileMetadata = forbidden;
    const rows = [
        {id: pid(1), artist: '1.kla$', name: 'Solo', album: '', year: 0, duration: 90, favorite: false},
        {id: pid(2), artist: 'Czar', name: 'Other', album: 'Album', year: 2020, duration: 180, favorite: true},
        {id: pid(3), artist: 'Other', name: 'Excluded'}
    ];
    const output = context.snapshotCommand(filters.parse(['--artist', '1.kla$ OR Czar', '--show', '1']), {
        candidates: () => ({rows, favorite_property: 'favorited'}), capture: forbidden, snapshot: forbidden, libraryID: forbidden
    }, core, filters);
    assert.match(output, /2 tracks/); assert.match(output, /Showing 1\/2/); assert.match(output, /1\.kla\$ — Solo/);
    assert.match(output, /Duration: 4:30/); assert.doesNotMatch(output, /Czar — Other/);
    assert.match(output, /Console preview only/);
});
test('editable export preserves metadata, emits null gaps and prepares only explicit edits', () => {
    const before = state(); before.metadata.album = ''; before.metadata.year = 0; before.metadata.lyrics = 'Existing\nlyrics';
    const original = JSON.stringify(before), request = core.editableSnapshot(document([{id: pid(1), snapshot: before}]));
    const row = request.tracks[0];
    assert.equal(JSON.stringify(before), original); assert.equal(row.set.album, null); assert.equal(row.set.year, null);
    assert.equal(row.set.compilation, false); assert.equal(row.set.lyrics, null);
    assert.equal(row.artwork_file, null); assert.equal(row.lyrics_file, null); assert.equal(row.info.lyrics_present, true);
    assert.deepEqual(core.changes(row, before.metadata, {}), {});
    row.set.album = 'Correct Album'; row.set.year = 2024; row.info.favorite = true;
    assert.deepEqual(core.changes(core.validateRequest(request).tracks[0], before.metadata, {}), {album: 'Correct Album', year: 2024});
    assert.throws(() => core.validateRequest({...request, tracks: [{...row, info: {genre: 'Cannot write here'}}]}), /unsupported/);
    assert.throws(() => core.validateRequest({...request, tracks: [{...row, info: {artwork_count: -1}}]}), /Invalid info/);
    assert.throws(() => core.validateRequest({...request, defaults: {genre: null}}), /invalid type/);
    assert.throws(() => core.validateRequest({...request, tracks: [{...row, set: {album: ''}}]}), /invalid text/);
    assert.throws(() => core.changes(row, {...before.metadata, artist: 'Different'}, {}), /Identity differs/);
});
test('null lyrics placeholders allow one external source while real source conflicts remain rejected', () => {
    const request = core.editableSnapshot(document([{id: pid(1), snapshot: state()}]));
    const row = request.tracks[0]; row.lyrics_file = 'lyrics/song.txt';
    assert.doesNotThrow(() => core.validateRequest(request));
    row.set.lyrics = 'Inline words'; assert.throws(() => core.validateRequest(request), /cannot be combined/);
    row.set.lyrics = null; row.lyrics_url = 'https://example.test/song.txt';
    assert.throws(() => core.validateRequest(request), /one lyrics source/);
});
test('export ignores display limits, uses capture without hashes and refuses partial or existing output', () => {
    const saves = [], selections = filters.parse(['--all', '--show', '0', 'out.json']);
    context.absolute = x => '/tmp/' + x;
    context.exists = () => false; context.mkdir = () => {};
    context.$ = value => ({stringByDeletingLastPathComponent: path.dirname(value)});
    context.ObjC.unwrap = x => x;
    context.saveJSON = (destination, value) => saves.push({destination, value: plain(value)});
    let captures = 0;
    const io = {
        candidates: () => ({rows: [1, 2].map(n => ({id: pid(n), ...state().metadata, duration: 180, favorite: false})), favorite_property: 'favorited'}),
        libraryID: () => pid(100),
        snapshot: () => {throw Error('Hashed snapshot must not run');},
        capture: () => {captures++; return state();}
    };
    assert.match(context.snapshotCommand(selections, io, core, filters), /Showing 0\/2/);
    assert.equal(captures, 2); assert.equal(saves.length, 1); assert.equal(saves[0].value.tracks.length, 2);
    core.validateRequest(saves[0].value); assert.equal(Object.hasOwn(saves[0].value.tracks[0], 'snapshot'), false);
    io.capture = id => {if (id === pid(2)) throw Error('Missing local audio'); return state();};
    assert.throws(() => context.snapshotCommand(selections, io, core, filters), /no partial request saved[\s\S]*Missing local audio/);
    assert.equal(saves.length, 1);
    io.candidates = () => ({rows: [], favorite_property: null});
    assert.match(context.snapshotCommand(selections, io, core, filters), /No matches/); assert.equal(saves.length, 1);
    context.exists = () => true;
    assert.throws(() => context.snapshotCommand(selections, io, core, filters), /already exists/);
});
test('console display handles unknowns and neutralizes terminal control characters', () => {
    const output = core.snapshotInfo([{name: 'Song\u001b[31m\nNext', artist: 'Artist', duration: null, favorite: null}], null);
    assert.doesNotMatch(output, /\u001b/); assert.match(output, /unknown: 1/); assert.match(output, /<no album>/);
});
test('draft audit keeps metadata edits separate from media presence at export', () => {
    const before = state(); before.metadata.album = ''; before.metadata.lyrics = '';
    const request = core.editableSnapshot(document([{id: pid(1), snapshot: before}]));
    request.tracks[0].set.album = 'Draft album'; request.tracks[0].lyrics_file = 'lyrics/new.txt';
    const report = core.auditSnapshot(request);
    assert.equal(report.basis, 'request'); assert.equal(report.missing.album, 0);
    assert.equal(report.lyrics.missing, 1); assert.match(context.auditPreview(report), /status is from info at export/);
});
console.log('\n' + passed + ' snapshot/audit tests passed. No Music calls were made.');
