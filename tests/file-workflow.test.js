'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const filters = require('../filters');
const core = require('../core');

test('presence expressions treat read errors as unknown and sort unknown last', () => {
    const query = filters.parse(['--folder', '/music', '--has', '(artwork=false OR composer=false) AND NOT name=false',
        '--sort', 'has.artwork', '--desc', 'request.json']);
    const missing = {'has.artwork': false, 'has.composer': true, 'has.name': true};
    const unknown = {'has.artwork': null, 'has.composer': true, 'has.name': true};
    const present = {'has.artwork': true};
    assert.equal(filters.evaluate(query.presence, missing), true);
    assert.equal(filters.evaluate(query.presence, unknown), null);
    assert.deepEqual(filters.sort([unknown, missing, present], query.sort_by, true), [present, missing, unknown]);
    assert.throws(() => filters.parse(['--folder', '/music', '--favorite', 'false']), /Favorite requires Music/);
    assert.throws(() => filters.parse(['--folder', '/music', '--playlist', 'Mix']), /primary source/);
    assert.throws(() => filters.parse(['--has', 'favorite=false']), /FIELD/);
    const scoped = filters.parse(['--music','--has','file.artwork=false AND music.artwork=true',
        '--sort','has.file.artwork']);
    const savedInMusic = {'has.file.artwork':false,'has.music.artwork':true};
    assert.deepEqual(filters.inline('has','artwork=music-only'),scoped.presence);
    assert.equal(filters.evaluate(scoped.presence,savedInMusic),true);
    assert.equal(filters.evaluate(scoped.presence,{'has.file.artwork':false,'has.music.artwork':null}),null);
    assert.throws(() => filters.parse(['--folder','/music','--has','music.artwork=true']), /requires --music/);
    assert.throws(() => filters.parse(['--folder','/music','--has','artwork=music-only']), /requires --music/);
    assert.throws(() => filters.inline('has','file.artwork=music-only'), /without a source prefix/);
    assert.equal(filters.evaluate(filters.inline('artist', 'Czar'), {artist: ['Kla$', 'Czar']}), true);
});

test('force includes equal goals, honors fill and ignores suggestions', () => {
    const actual = {tags: {genre:'Rap', compilation:false}, has:{genre:true, compilation:true, composer:false}};
    const track = {tags:{genre:'Rap', compilation:false, composer:null}, fill:{composer:'Composer'},
        music_suggestions:{album:'Music album'}};
    assert.deepEqual(core.effective(track, {}, actual, false), {composer:'Composer'});
    assert.deepEqual(core.effective(track, {}, actual, true), {genre:'Rap', compilation:false, composer:'Composer'});
    assert.throws(() => core.prepareArgs(['req','plan','--force','true','--force','false']), /exactly one/);
    assert.throws(() => core.prepareArgs(['req','plan','--force','yes']), /true or false/);
});

const root = path.resolve(__dirname, '..');
const native = path.join(root, 'build/bin/music-tags-file');
function execute(bin,args,options={}) {
    const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer:4*1024*1024,...options});
    if (r.error) throw r.error;
    assert.equal(r.status,0,[bin,args.join(' '),r.stdout,r.stderr].join('\n'));
    return r.stdout;
}
function cli(...args) { return execute(path.join(root,'music-tags'),args); }
function sha(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function json(file,obj) { if(obj) fs.writeFileSync(file,JSON.stringify(obj,null,2)); else return JSON.parse(fs.readFileSync(file)); }

test('filesystem-only CLI round trip for MP3 v2.3/v2.4 and M4A AAC/ALAC', {
    skip: !fs.existsSync(native) && 'Build the native target first'
}, t => {
    const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-test-'));
    t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
    const media=path.join(temp,'media');
    fs.mkdirSync(media);
    const formats = [
        ['id3-v23.mp3',['-c:a','libmp3lame','-id3v2_version','3']],
        ['id3-v24.mp3',['-c:a','libmp3lame','-id3v2_version','4']],
        ['aac.m4a',['-c:a','aac']],
        ['alac.m4a',['-c:a','alac']]
    ];
    formats.forEach(([name,opts]) => execute('ffmpeg',['-v','error','-y','-f','lavfi','-i',
        'sine=frequency=500:duration=0.35',...opts,'-metadata','title=Français',
        '-metadata','artist=Исполнитель','-metadata','track=1/12','-metadata','comment=Keep me',
        path.join(media,name)]));
    const protectedAttrFile = path.join(media,'id3-v23.mp3');
    execute('/usr/bin/xattr',['-w','com.music-doctor.fixture','retain this',protectedAttrFile]);
    const request=path.join(temp,'request.json'), plan=path.join(temp,'plan.json');
    const initial = formats.map(([name]) => sha(path.join(media,name))).sort();
    assert.match(cli('snapshot','--folder',media,'--has','artwork=false OR composer=false','--show','1',request),/Showing 1\/4/);
    const draft=json(request);
    assert.equal(draft.tracks.length,4);
    assert.deepEqual(draft.tracks.map(row=>row.sha256).sort(),initial);
    assert.ok(draft.tracks.every(row=>row.tags.trackCount===12 && row.tags.composer===null));
    assert.ok(draft.tracks.every(row=>row.artwork===false && row.lyrics===false &&
        !('has' in row) && !('artwork_file' in row) && !('lyrics_file' in row) && !('music_suggestions' in row)));
    fs.writeFileSync(path.join(temp,'words.txt'),'Тестовый текст\nDeutsch\n');
    fs.writeFileSync(path.join(temp,'cover.png'),Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLE8AAAAASUVORK5CYII=','base64'));
    draft.tracks.forEach((row,index)=>{
        row.tags={genre:'French Hip-Hop',trackNumber:3,compilation:false,albumArtist:'Группа',
            year:2024,discNumber:1,discCount:2,composer:'Композитор'};
        if (index===0) {
            delete row.artwork;
            delete row.lyrics;
            row.has={artwork:false,lyrics:false};
            row.artwork_file='cover.png';
            row.lyrics_file='words.txt';
        } else {
            row.artwork='cover.png';
            row.lyrics='words.txt';
        }
    });
    json(request,draft);
    cli('validate',request);
    cli('prepare',request,plan);
    cli('preview',plan);
    assert.deepEqual(formats.map(([name])=>sha(path.join(media,name))).sort(),initial);
    assert.match(cli('apply',plan),/Verified: 4/);
    assert.equal(execute('/usr/bin/xattr',['-p','com.music-doctor.fixture',protectedAttrFile]).trim(),'retain this');
    const actual=JSON.parse(cli('inspect',plan)).tracks;
    assert.ok(actual.every(row=>row.tags.genre==='French Hip-Hop' && row.tags.composer==='Композитор' &&
        row.tags.trackNumber===3 && row.tags.trackCount===12 && row.has.compilation===true &&
        row.tags.compilation===false && row.has.artwork===true && row.has.lyrics===true));
    assert.ok(actual.every(row=>row.artwork.sha256===sha(path.join(temp,'cover.png'))));
    assert.deepEqual(fs.readdirSync(media).sort(),formats.map(x=>x[0]).sort());
    const firstResult=actual.map(row=>sha(row.path));
    const req2=path.join(temp,'request2.json'), noOp=path.join(temp,'noop.json'), force=path.join(temp,'force.json');
    const summary=cli('snapshot','--folder',media,'--has','artwork=true AND lyrics=true',req2);
    assert.match(summary,/Snapshot saved — 4 tracks \| Artwork: 4 \| Lyrics: 4/);
    assert.doesNotMatch(summary,/Showing|Français/);
    const exportLog=fs.readFileSync(req2+'.log','utf8');
    assert.match(exportLog,/Exporting snapshot 0\/4/);
    assert.match(exportLog,/Exporting snapshot 4\/4/);
    const updated=json(req2);
    assert.equal(updated.tracks.length,4);
    assert.ok(updated.tracks.every(row=>row.artwork.startsWith('request2.json.assets/') &&
        row.lyrics.startsWith('request2.json.assets/')));
    assert.match(cli('prepare',req2,noOp),/No changes/);
    assert.match(cli('apply',noOp),/Verified: 4/);
    assert.deepEqual(actual.map(row=>sha(row.path)),firstResult);
    assert.match(cli('prepare',req2,force,'--force','true'),/forced rewrite/);
    assert.match(cli('preview',force),/force=true/);
    assert.match(cli('apply',force),/Verified: 4/);
    assert.match(cli('apply',force),/Already complete/);
    const log=JSON.parse(cli('status',force));
    assert.equal(log.status,'complete');
    assert.equal(log.force,true);
    assert.ok(log.tracks.every(row=>row.file_status==='verified' && row.cleanup==='removed' && !fs.existsSync(row.backup)));
    assert.deepEqual(fs.readdirSync(media).sort(),formats.map(x=>x[0]).sort());

    const fresh=path.join(temp,'fresh.json'), stale=path.join(temp,'stale.json');
    cli('snapshot','--folder',media,fresh);
    cli('prepare',fresh,stale,'--force','true');
    const frozen=json(stale).tracks[0].lyrics.path;
    fs.appendFileSync(frozen,'altered');
    const rejected=spawnSync(path.join(root,'music-tags'),['apply',stale],{encoding:'utf8'});
    assert.notEqual(rejected.status,0);
    assert.match(rejected.stderr,/Changed lyrics asset/);
    assert.ok(!fs.existsSync(stale+'.journal.json'));
    fs.appendFileSync(actual[0].path,'stale');
    const staleOutput=spawnSync(path.join(root,'music-tags'),['prepare',fresh,path.join(temp,'another.json'),'--force','true'],{encoding:'utf8'});
    assert.notEqual(staleOutput.status,0);
    assert.match(staleOutput.stderr,/Stale snapshot/);
});


test('Presence uses file and Music and Music-only lyrics are written with force=false', {
    skip: !fs.existsSync(native) && 'Build the native target first'
}, t => {
    const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-music-test-'));
    t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
    const runtime=path.join(temp,'runtime'), media=path.join(temp,'media');
    fs.mkdirSync(runtime);
    fs.mkdirSync(media);
    fs.mkdirSync(path.join(runtime,'bin'));
    for(const f of ['music-tags','core.js','filters.js','file-commands.js'])
        fs.copyFileSync(path.join(root,f),path.join(runtime,f));
    fs.copyFileSync(native,path.join(runtime,'bin','music-tags-file'));
    const run=(...args) => execute(path.join(runtime,'music-tags'),args);
    const track=path.join(media,'test.mp3'), lyrics='Test words from Music\nSecond line';
    execute('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=330:duration=0.35',
        '-c:a','libmp3lame','-metadata','title=Local title',track]);
    const missing=path.join(media,'missing.mp3'), unknown=path.join(media,'unknown.mp3');
    fs.copyFileSync(track,missing);
    fs.copyFileSync(track,unknown);
    const records=[track,missing,unknown].map((file,index) => ({
        id:String(index+1).padStart(16,'0'), name:'Music title', path:file, favorite:false
    }));
    const fake = [
        'function musicIO() {',
        '  var records='+JSON.stringify(records)+';',
        '  var refreshed = new Set();',
        '  function record(id) { return records.find(function (row) {return row.id===id;}); }',
        '  return {',
        "    candidates: function () { return {rows:records,favorite_property:'favorited'}; },",
        '    filePaths: function () { return new Map(records.slice(0,2).reverse().map(function (row) {return [row.id,row.path];})); },',
        '    filePath: function (id) { return id===records[1].id ? records[2].path : record(id).path; },',
        '    presenceForFile: function (id, fields) {',
        "      if (id===records[2].id) throw new Error('Music lookup failed');",
        '      var out={}; fields.forEach(function (key) {out[key]=id===records[0].id;}); return out;',
        '    },',
        '    readForFile: function (id) {',
        "      if (id===records[2].id) throw new Error('Music enrichment failed');",
        "      return {tags:{name:'Music title',album:'Music album'},lyrics:id===records[0].id ? "+JSON.stringify(lyrics)+" : null};",
        '    },',
        '    extractArtwork: function () { return false; },',
        '    refreshFile: function (id) { refreshed.add(id); },',
        '    matchesFile: function (row) { return row.music_ids.every(function (id) {return refreshed.has(id);}); }',
        '  };',
        '}'
    ].join('\n');
    const adapter=fs.readFileSync(path.join(root,'jxa.js'),'utf8');
    fs.writeFileSync(path.join(runtime,'jxa.js'),adapter.replace('function run(argv) {',fake+'\nfunction run(argv) {'));
    const request=path.join(temp,'request.json'), plan=path.join(temp,'plan.json');
    const gaps = run('snapshot','--music','--has','artwork=false');
    assert.match(gaps,/— 1 tracks/);
    assert.match(gaps,/unknown\.mp3: filter could not be evaluated/);
    assert.match(run('snapshot','--music','--has','file.artwork=false'),/— 3 tracks/);
    assert.match(run('snapshot','--music','--has','file.artwork=false AND music.artwork=true'),/— 1 tracks/);
    assert.match(run('snapshot','--music','--has','artwork=true OR lyrics=true'),/— 1 tracks/);
    const all=path.join(temp,'all.json');
    const summary=run('snapshot','--music',all);
    assert.match(summary,/Snapshot saved — 3 tracks/);
    assert.match(summary,/Warnings: \d/);
    assert.doesNotMatch(summary,/artwork present|Music tag suggestions|assets exported from Music|Showing/);
    const log=fs.readFileSync(all+'.log','utf8');
    assert.match(log,/Music paths: 2 batched, 1 checked individually/);
    assert.match(log,/test\.mp3: artwork present but no asset exported/);
    assert.match(log,/test\.mp3: Music tag suggestions: album/);
    assert.match(log,/test\.mp3: assets exported from Music: lyrics/);
    const allRows=json(all).tracks;
    assert.deepEqual(allRows.map(row=>fs.realpathSync(row.path)),[track,missing,unknown].map(file=>fs.realpathSync(file)));
    assert.deepEqual(allRows.map(row=>row.artwork),[true,false,null]);
    assert.match(allRows[0].lyrics,/\.txt$/);
    assert.deepEqual(allRows.slice(1).map(row=>row.lyrics),[false,null]);
    assert.match(run('snapshot','--folder',media,'--music','--has','lyrics=music-only AND artwork=music-only',request),/— 1 tracks/);
    const exported=json(request), row=exported.tracks[0];
    assert.deepEqual(Object.keys(row),['tags','artwork','lyrics','music_suggestions','path','sha256','music_ids']);
    assert.equal(row.tags.name,'Local title');
    assert.equal(row.tags.album,null);
    assert.deepEqual(row.music_suggestions,{album:'Music album'});
    assert.ok(!('from_music' in row));
    assert.equal(row.artwork,true);
    assert.equal(fs.readFileSync(path.join(temp,row.lyrics),'utf8'),lyrics);
    run('validate',request);
    const unreviewedPlan=path.join(temp,'unreviewed.json');
    run('prepare',request,unreviewedPlan);
    assert.deepEqual(json(unreviewedPlan).tracks[0].tags,{});
    row.tags.album=row.music_suggestions.album;
    allRows[1].tags.album='Local album despite mismatched Music path';
    exported.tracks.push(allRows[1]);
    json(request,exported);
    assert.match(run('prepare',request,plan),/force=false/);
    assert.deepEqual(json(plan).tracks[0].tags,{album:'Music album'});
    assert.match(run('apply',plan),/Verified: 2/);
    const updated=JSON.parse(run('inspect',plan)).tracks[0];
    assert.equal(updated.tags.album,'Music album');
    assert.equal(updated.lyrics.sha256,sha(path.join(temp,row.lyrics)));
    const status=JSON.parse(run('status',plan));
    assert.equal(status.tracks[0].file_status,'verified');
    assert.equal(status.tracks[0].music_status,'refreshed');
    assert.equal(status.tracks[0].cleanup,'removed');
    assert.equal(status.tracks[1].file_status,'verified');
    assert.equal(status.tracks[1].music_status,'unavailable_or_failed');
    assert.match(status.tracks[1].music_error,/different file/);
});
