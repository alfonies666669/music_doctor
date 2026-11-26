'use strict';
const assert = require('node:assert/strict');
const filters = require('../filters.js');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function match(query, row) { filters.validate(query); return filters.evaluate(query, row); }
const artists = {any: [{artist: {contains: '1.kla$'}}, {artist: {contains: 'Czar'}}]};
test('OR includes both solo artists and their collaborations; AND includes collaborations only', () => {
    const names = ['1.kla$', 'Czar', '1.Kla$ & Czar', 'Czar feat. Other', 'Other'];
    assert.deepEqual(names.map(artist => match(artists, {artist})), [true, true, true, true, false]);
    assert.deepEqual(names.map(artist => match({all: artists.any}, {artist})), [false, false, true, false, false]);
});
test('nested top-level logic combines fields and excludes title variants', () => {
    const query = {all: [artists, {not: {name: {contains: 'remix'}}}, {duration: {gte: 180, lt: 600}}, {favorite: true}]};
    const row = {artist: '1.kla$ & Czar', name: 'Example', duration: 180, favorite: true};
    assert.equal(match(query, row), true);
    assert.equal(match(query, {...row, name: 'Example Remix'}), false);
    assert.equal(match(query, {...row, duration: 600}), false);
    assert.equal(match(query, {...row, favorite: false}), false);
});
test('text operators are literal, case insensitive and Unicode normalized', () => {
    assert.equal(match({name: {contains: 'a.*$'}}, {name: 'A.*$ Song'}), true);
    assert.equal(match({name: {contains: 'a.*$'}}, {name: 'Another Song'}), false);
    assert.equal(match({album: {eq: 'Café  Album'}}, {album: 'Cafe\u0301 Album'}), true);
    assert.equal(match({artist: {startsWith: 'Czar', endsWith: 'Other'}}, {artist: 'CZAR feat. Other'}), true);
    assert.equal(match({genre: {eq: 'German Hip-Hop'}}, {genre: 'Russian German Hip-Hop'}), false);
    assert.equal(match({album: {eq: ''}}, {album: ''}), true);
});
test('NOT never turns missing favorite or duration data into a positive match', () => {
    assert.equal(match({not: {favorite: true}}, {}), null);
    assert.equal(match({not: {duration: {gt: 10}}}, {}), null);
    assert.equal(match({favorite: false}, {favorite: null}), null);
    assert.equal(match({favorite: false}, {favorite: false}), true);
    assert.equal(match({duration: {gte: 0}}, {duration: -1}), null);
});
test('unknown values use three-valued AND/OR logic', () => {
    const unknown = {favorite: true}, yes = {artist: {eq: 'A'}}, no = {artist: {eq: 'B'}};
    assert.equal(match({all: [unknown, no]}, {artist: 'A'}), false);
    assert.equal(match({all: [unknown, yes]}, {artist: 'A'}), null);
    assert.equal(match({any: [unknown, yes]}, {artist: 'A'}), true);
    assert.equal(match({any: [unknown, no]}, {artist: 'A'}), null);
});
test('duration supports fractions, zero, and explicit inclusive or exclusive bounds', () => {
    assert.equal(match({duration: {eq: 0}}, {duration: 0}), true);
    assert.equal(match({duration: {gt: 1.5, lte: 2}}, {duration: 2}), true);
    assert.equal(match({duration: {gt: 1.5}}, {duration: 1.5}), false);
    assert.equal(filters.duration('3:00'), 180); assert.equal(filters.duration('1:02:03.5'), 3723.5);
    assert.equal(filters.duration('180.5'), 180.5); assert.equal(filters.duration('0'), 0);
    for (const s of ['-1', 'Infinity', 'NaN', '1:60', '1:60:00', '', '3m']) assert.throws(() => filters.duration(s));
});
test('bad field names, ambiguous nodes and wrong types fail before any data read', () => {
    for (const q of [{}, {all: []}, {any: []}, {not: []}, {artist: 'A'}, {favorite: 'false'}, {duration: {gt: -1}}, {duration: {gte: '180'}}, {duration: {gt: Infinity}}, {name: {regex: '.*'}}, {artist: {contains: ''}}, {favorite: true, genre: {eq: 'Rap'}}, JSON.parse('{"__proto__":{}}')]) assert.throws(() => filters.validate(q));
});
test('recursive filters have bounded depth and node count', () => {
    let query = {favorite: true}; for (let i = 0; i < 18; i++) query = {not: query};
    assert.throws(() => filters.validate(query), /deeply/);
    assert.throws(() => filters.validate({all: Array.from({length: 1025}, () => ({favorite: true}))}), /large/);
});
test('simple CLI flags combine with AND and support playlist scope', () => {
    const s = filters.parse(['--playlist', 'French', '--genre', 'French Hip-Hop', '--artist', 'Leto', '--name', 'Paris', '--album', '100', '--favorite', 'false', '--min-duration', '0', '--max-duration', '3:30', 'out.json']);
    assert.equal(s.scope.kind, 'playlist'); assert.equal(s.scope.value, 'French'); assert.equal(s.filter.all.length, 7);
    assert.equal(filters.evaluate(s.filter, {genre: 'French Hip-Hop', artist: 'Leto & Niska', name: 'Paris', album: '100 visages', favorite: false, duration: 210}), true);
});
test('CLI aliases and old snapshot forms keep their meaning', () => {
    assert.equal(filters.parse(['French', 'out.json']).scope.value, 'French');
    assert.equal(filters.parse(['--all', 'out.json']).kind, 'all');
    assert.equal(filters.parse(['--genre', 'Rap', 'out.json']).kind, 'genre');
    assert.deepEqual(filters.parse(['--title', 'Song', 'out.json']).filter, {name: {contains: 'Song'}});
    assert.deepEqual(filters.parse(['--album-artist', 'Group', 'out.json']).filter, {albumArtist: {contains: 'Group'}});
    assert.equal(Object.hasOwn(filters.parse(['--artist', 'Bushido', 'out.json']), 'filter_file'), false);
});
test('invalid ranges, repeated flags, unknown flags and conflicting scopes are rejected', () => {
    const bad = [['--artist'], ['--favorite', 'yes', 'out.json'], ['--min-duration', '-1', 'out.json'], ['--min-duration', '5:00', '--max-duration', '2:00', 'out.json'], ['--artist', 'A', '--artist', 'B', 'out.json'], ['--name', 'A', '--title', 'B', 'out.json'], ['--all', '--playlist', 'French', 'out.json'], ['French', '--all', 'out.json'], ['--desc', '--all', 'out.json'], ['--sort', 'invalid', 'out.json'], ['--unknown', 'X', 'out.json']];
    bad.forEach(argv => assert.throws(() => filters.parse(argv), undefined, JSON.stringify(argv)));
});
test('sorting is stable and keeps unknown values last in either direction', () => {
    const rows = [{id: 'one', duration: 3}, {id: 'two', duration: 1}, {id: 'three', duration: null}, {id: 'four', duration: 3}, {id: 'zero', duration: 0}];
    assert.deepEqual(filters.sort(rows, 'duration', false).map(x => x.id), ['zero', 'two', 'one', 'four', 'three']);
    assert.deepEqual(filters.sort(rows, 'duration', true).map(x => x.id), ['one', 'four', 'two', 'zero', 'three']);
    assert.equal(rows[0].id, 'one');
    assert.deepEqual(filters.sort([{name: 'b'}, {name: 'A'}], 'name', false).map(x => x.name), ['A', 'b']);
    assert.deepEqual(filters.sort([{favorite: true}, {favorite: false}], 'favorite', false).map(x => x.favorite), [false, true]);
});
test('filter dependencies are deduplicated', () => {
    assert.deepEqual(filters.fields({all: [artists, {not: {favorite: true}}, {duration: {gte: 0}}, {artist: {eq: 'A'}}]}), ['artist', 'favorite', 'duration']);
});
test('retired JSON filter option is rejected instead of being silently accepted', () => {
    assert.throws(() => filters.parse(['--filter', 'query.json', 'out.json']), /Unknown snapshot option: --filter/);
    assert.throws(() => filters.parse(['--artist', 'Bushido', '--filter', 'query.json', 'out.json']), /Unknown snapshot option: --filter/);
});
test('inline artist OR and NOT include solo tracks and exclude the requested collaborations', () => {
    const rows = ['Bushido', 'Fler', 'Bushido & Fler', 'Bushido & Sido', 'Sido'].map(artist => ({artist}));
    const query = value => filters.parse(['--artist', value, 'out.json']).filter;
    assert.deepEqual(rows.map(row => filters.evaluate(query('Bushido OR Fler'), row)), [true, true, true, true, false]);
    for (const expression of ['Bushido NOT Fler', 'Bushido AND NOT Fler', 'Bushido && !Fler']) {
        assert.deepEqual(rows.map(row => filters.evaluate(query(expression), row)), [true, false, false, true, false]);
    }
    assert.deepEqual(rows.map(row => filters.evaluate(query('Bushido AND Fler'), row)), [false, false, true, false, false]);
});
test('inline symbolic OR and parentheses use NOT > AND > OR precedence', () => {
    const row = {artist: 'Bushido & Sido'};
    assert.equal(filters.evaluate(filters.inline('artist', 'Bushido OR Fler AND NOT Sido'), row), true);
    assert.equal(filters.evaluate(filters.inline('artist', '(Bushido OR Fler) AND NOT Sido'), row), false);
    assert.equal(filters.evaluate(filters.inline('artist', '(Bushido||Fler)&&!Sido'), row), false);
    assert.equal(filters.evaluate(filters.inline('artist', 'NOT (Fler OR Sido)'), row), false);
});
test('quoted terms support multiword artists, literal operator words, parentheses and escapes', () => {
    assert.equal(filters.evaluate(filters.inline('artist', '"AK Ausserkontrolle" OR Fler'), {artist: 'AK Ausserkontrolle & Bushido'}), true);
    assert.equal(filters.evaluate(filters.inline('name', '"LOVE AND WAR" OR "NOT TODAY"'), {name: 'LOVE AND WAR'}), true);
    assert.equal(filters.evaluate(filters.inline('name', '"Song (Remix)" AND NOT "Live"'), {name: 'Song (Remix)'}), true);
    assert.equal(filters.evaluate(filters.inline('name', '"He said \\"Hello\\"" OR Other'), {name: 'He said "Hello"'}), true);
    assert.deepEqual(filters.inline('name', '"NOT"'), {name: {contains: 'NOT'}});
});
test('ordinary titles keep literal spaces, parentheses, apostrophes, case and punctuation', () => {
    for (const title of ['Or Noir', 'Not Afraid', 'Me And You', "I'm Not Afraid", 'Song (Part II)', 'Wow!', 'or and not', '1.kla$']) {
        assert.deepEqual(filters.inline('name', title), {name: {contains: title}});
    }
    assert.deepEqual(filters.inline('artist', '1.kla$ OR Czar'), {any: [{artist: {contains: '1.kla$'}}, {artist: {contains: 'Czar'}}]});
});
test('expressions work in every text flag, retaining exact matching for each genre term', () => {
    const selection = filters.parse(['--genre', 'German Hip-Hop OR French Hip-Hop', '--artist', 'Bushido NOT Fler', '--title', 'Intro OR Outro', '--album', 'Album NOT Deluxe', '--album-artist', 'Bushido OR Leto', '--favorite', 'true', 'out.json']);
    const row = {genre: 'German Hip-Hop', artist: 'Bushido', name: 'Intro', album: 'Album', albumArtist: 'Bushido', favorite: true};
    assert.equal(filters.evaluate(selection.filter, row), true);
    assert.equal(filters.evaluate(selection.filter, {...row, genre: 'Russian German Hip-Hop'}), false);
    assert.equal(filters.evaluate(selection.filter, {...row, artist: 'Bushido & Fler'}), false);
});
test('malformed inline logic is rejected rather than silently changing the query meaning', () => {
    for (const expression of ['OR Bushido', 'Bushido OR', 'Bushido AND OR Fler', 'Bushido OR (Fler', 'Bushido OR Fler)', 'NOT', 'Bushido OR "Fler', 'Bushido AND ()', 'Bushido AND ""', 'Bushido OR " "']) {
        assert.throws(() => filters.parse(['--artist', expression, 'out.json']), undefined, expression);
    }
    assert.throws(() => filters.inline('artist', 'NOT '.repeat(18) + 'Fler'), /deeply/);
});
test('omitting output selects console preview without changing query semantics', () => {
    const args = ['--artist', '1.kla$ OR Czar'];
    assert.equal(filters.parse(args).output, null);
    assert.deepEqual(filters.parse(args).filter, filters.parse([...args, 'out.json']).filter);
    assert.equal(filters.parse([]).scope.kind, 'all');
    assert.equal(filters.parse(['French', '--sort', 'name']).scope.value, 'French');
    assert.equal(filters.parse(['--playlist', 'French.json']).output, null);
    assert.equal(filters.parse(['out.json']).output, 'out.json');
});
test('display limits never enter the filter and reject invalid values', () => {
    const args = ['--artist', 'A OR B'];
    assert.equal(filters.parse(args).show_limit, 20);
    assert.equal(filters.parse([...args, '--show', 'all']).show_limit, null);
    assert.equal(filters.parse([...args, '--show', '0', 'out.json']).show_limit, 0);
    assert.deepEqual(filters.parse([...args, '--show', '1']).filter, filters.parse(args).filter);
    for (const value of ['-1', '1.5', 'Infinity', '9007199254740992', '']) assert.throws(() => filters.parse(['--show', value]));
});
console.log('\n' + passed + ' logical filter tests passed. No Music calls were made.');
