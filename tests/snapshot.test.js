'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
const core=require('../core'),filters=require('../filters');
const pid=n=>String(n).padStart(16,'0');
const context=vm.createContext({ObjC:{import(){}},$:{NSFileManager:{defaultManager:{}}},console:{log(){}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../jxa.js'),'utf8'),context);
const plain=value=>JSON.parse(JSON.stringify(value));
function displayColumns(n) {
    return {name: () => Array(n).fill('Song'), artist: () => Array(n).fill('Artist'), album: () => Array(n).fill(''), year: () => Array(n).fill(0), duration: () => Array(n).fill(180)};
}

test('snapshot CLI accepts genre, playlist and all-library forms, and rejects incomplete flags', () => {
    const selection = filters.parse(['--genre', 'Custom Hip-Hop', 'out.json']);
    assert.equal(selection.kind, 'genre'); assert.equal(selection.value, 'Custom Hip-Hop'); assert.equal(selection.output, 'out.json');
    assert.deepEqual(selection.filter, {genre: {eq: 'Custom Hip-Hop'}});
    assert.equal(filters.parse(['French', 'out.json']).kind, 'playlist');
    assert.equal(filters.parse(['--all', 'out.json']).kind, 'all');
    assert.throws(() => filters.parse(['--genre']), /Missing value/);
    assert.throws(() => filters.parse(['French', 'one', 'two']), /Use snapshot/);
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
test('console display handles unknowns and neutralizes terminal control characters', () => {
    const output = core.snapshotInfo([{name: 'Song\u001b[31m\nNext', artist: 'Artist', duration: null, favorite: null}], null);
    assert.doesNotMatch(output, /\u001b/); assert.match(output, /unknown: 1/); assert.match(output, /<no album>/);
});
