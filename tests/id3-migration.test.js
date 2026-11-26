'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const core = require('../file-core');
const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'bin/music-tags-file');
function run(bin, args, input) {
    return spawnSync(bin, args, {input, encoding:'utf8', maxBuffer:8*1024*1024});
}
function ok(bin, args, input) {
    const result = run(bin,args,input);
    assert.equal(result.status,0, result.error || result.stderr || result.stdout);
    return result.stdout;
}
function cli(...args) { return ok(path.join(root,'music-tags'),args); }
function native(payload) {
    return JSON.parse(ok(helper,[],JSON.stringify({protocol:1,...payload})));
}
function json(file, data) {
    if (data) fs.writeFileSync(file,JSON.stringify(data,null,2));
    else return JSON.parse(fs.readFileSync(file));
}
function sha(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function synchsafe(n) { return Buffer.from([n>>>21&127,n>>>14&127,n>>>7&127,n&127]); }
function frame(id, data) {
    const head=Buffer.alloc(6);
    head.write(id);head.writeUIntBE(data.length,3,3);
    return Buffer.concat([head,data]);
}
function text(value) { return Buffer.concat([Buffer.from([1,255,254]),Buffer.from(value,'utf16le')]); }
function audio(file) {
    const data=fs.readFileSync(file);
    if (data.subarray(0,3).toString()!=='ID3') return data;
    let n=0; for (const b of data.subarray(6,10)) n=n*128+b;
    return data.subarray(10+n);
}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=','base64');
function fixture(dir, extra=[], flags=0) {
    const file=path.join(dir,'track.mp3');
    ok('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=500:duration=0.35',
        '-c:a','libmp3lame','-id3v2_version','0','-write_id3v1','0',file]);
    const body=Buffer.concat([
        frame('TT2',text('Песня')),frame('TP1',text('Исполнитель')),
        frame('TYE',Buffer.from('\x002001')),frame('TRK',Buffer.from('\x002/12')),
        frame('COM',Buffer.from('\x00eng\x00'+'Keep comment '.repeat(40))),
        frame('TXX',Buffer.from('\x00CUSTOM\x00Keep custom text')),
        frame('ULT',Buffer.concat([Buffer.from([1]),Buffer.from('rus'),Buffer.from([255,254,0,0,255,254]),Buffer.from('Старый текст '.repeat(40),'utf16le')])),
        frame('PIC',Buffer.concat([Buffer.from([0]),Buffer.from('PNG'),Buffer.from([3,0]),png])),
        frame('PIC',Buffer.concat([Buffer.from([0]),Buffer.from('PNG'),Buffer.from([4,0]),png])),
        ...extra,Buffer.alloc(64)
    ]);
    fs.writeFileSync(file,Buffer.concat([Buffer.from([73,68,51,2,0,flags]),synchsafe(body.length),body,audio(file)]));
    return file;
}

test('plan validates and previews only the supported explicit migration', () => {
    const row={path:'/fixture.mp3',sha256:'a'.repeat(64),identity:'1:2',before:{name:'Old'},tags:{name:'New'},id3_migration:{from:2,to:3}};
    const plan={version:2,kind:'music-tags-file-plan',created_at:'now',force:false,tracks:[row]};
    assert.match(core.preview(plan),/ID3v2.2 → ID3v2.3/);
    assert.deepEqual(core.targetSummary(row).id3_version,{before:2,after:3});
    for (const invalid of [{from:2,to:4},{from:3,to:3},{from:2,to:3,force:true}]) {
        row.id3_migration=invalid; assert.throws(()=>core.plan(plan),/migration/);
    }
    row.id3_migration={from:2,to:3};row.tags={};
    assert.throws(()=>core.plan(plan),/Invalid ID3 migration/);
});

test('ID3v2.2 migration preserves audio, comments, custom fields, lyrics and back cover', {
    skip: process.platform!=='darwin' || !fs.existsSync(helper)
}, t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-v22-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const file=fixture(dir), initial=sha(file), originalAudio=audio(file);
    const request=path.join(dir,'request.json');
    cli('snapshot','--folder',dir,request);
    const draft=json(request);
    assert.equal(draft.tracks.length,1);
    assert.equal(draft.tracks[0].tags.name,'Песня');
    // An equal request must stay a read-only no-op, even with old tags.
    const noop=path.join(dir,'noop.json');
    assert.match(cli('prepare',request,noop),/No changes/);
    assert.equal(json(noop).tracks[0].id3_migration,undefined);
    cli('apply',noop);
    assert.equal(sha(file),initial);
    const forced=path.join(dir,'forced.json');
    assert.match(cli('prepare',request,forced,'--force','true'),/ID3v2.2 → ID3v2.3/);
    assert.equal(sha(file),initial);
    // Add a front cover while preserving the unrelated back cover.
    fs.writeFileSync(path.join(dir,'cover.png'),png);
    ok('/usr/bin/sips',['-s','format','jpeg',path.join(dir,'cover.png'),'--out',path.join(dir,'cover.jpg')]);
    draft.tracks[0].tags={name:'Новое название'};
    draft.tracks[0].artwork='cover.jpg';
    json(request,draft);
    const plan=path.join(dir,'plan.json');
    assert.match(cli('prepare',request,plan),/ID3v2.2 → ID3v2.3/);
    assert.deepEqual(json(plan).tracks[0].id3_migration,{from:2,to:3});
    assert.equal(sha(file),initial);
    assert.equal(json(plan).tracks[0].artwork.sha256,sha(path.join(dir,'cover.jpg')));
    // Unreviewed/old plans cannot silently migrate.
    const tampered=json(plan);delete tampered.tracks[0].id3_migration;
    const oldPlan=path.join(dir,'old-plan.json');json(oldPlan,tampered);
    const rejected=run(path.join(root,'music-tags'),['apply',oldPlan]);
    assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/ID3 migration differs from plan/);
    assert.equal(fs.existsSync(oldPlan+'.journal.json'),false);
    assert.equal(sha(file),initial);
    assert.match(cli('apply',plan),/Verified: 1/);
    assert.equal(fs.readFileSync(file)[3],3);
    assert.deepEqual(audio(file),originalAudio);
    const actual=JSON.parse(cli('inspect',plan)).tracks[0];
    assert.equal(actual.tags.name,'Новое название');
    assert.equal(actual.tags.artist,'Исполнитель');
    assert.equal(actual.tags.year,2001);
    assert.equal(actual.tags.trackNumber,2);assert.equal(actual.tags.trackCount,12);
    assert.equal(actual.has.lyrics,true);
    assert.equal(actual.artwork.sha256,sha(path.join(dir,'cover.jpg')));
    const journal=JSON.parse(cli('status',plan));
    assert.deepEqual(journal.tracks[0].changes.id3_version,{before:2,after:3});
    assert.equal(journal.tracks[0].file_status,'verified');
    // No repeated migration after a fresh snapshot, even when forced.
    const fresh=path.join(dir,'fresh.json'),again=path.join(dir,'again.json');
    cli('snapshot','--folder',dir,fresh);
    assert.doesNotMatch(cli('prepare',fresh,again,'--force','true'),/ID3v2.2/);
    assert.match(cli('apply',again),/Verified: 1/);
    assert.deepEqual(audio(file),originalAudio);
    const stale=run(path.join(root,'music-tags'),['prepare',request,path.join(dir,'stale.json')]);
    assert.notEqual(stale.status,0);assert.match(stale.stderr,/Stale snapshot/);
});

test('failed temporary migration retains original bytes and recovery copy', {
    skip: process.platform!=='darwin' || !fs.existsSync(helper)
}, t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-v22-recovery-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const file=fixture(dir), initial=sha(file), runtime=path.join(dir,'runtime');
    fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});
    for (const name of ['music-tags','jxa.js','core.js','filters.js','file-core.js','file-commands.js'])
        fs.copyFileSync(path.join(root,name),path.join(runtime,name));
    fs.copyFileSync(helper,path.join(runtime,'bin/music-tags-file'));
    const commands=path.join(runtime,'file-commands.js');
    fs.writeFileSync(commands,fs.readFileSync(commands,'utf8').replace(
        "native(root,target(row,entry.temp,'write',plan.force));",
        "native(root,target(row,entry.temp,'write',plan.force)); throw new Error('Injected failure after temporary migration');"));
    const request=path.join(dir,'request.json'),plan=path.join(dir,'plan.json');
    cli('snapshot','--folder',dir,request);
    const draft=json(request);draft.tracks[0].tags={name:'Changed'};json(request,draft);
    cli('prepare',request,plan);
    const result=run(path.join(runtime,'music-tags'),['apply',plan]);
    assert.notEqual(result.status,0);assert.match(result.stderr,/Injected failure/);
    const journal=json(plan+'.journal.json');
    assert.equal(journal.status,'failed');
    assert.equal(journal.tracks[0].previous_stage,'writing_temp');
    assert.equal(sha(file),initial);
    assert.equal(sha(journal.tracks[0].backup),initial);
    assert.equal(fs.readFileSync(journal.tracks[0].temp)[3],3);
    // Verification must detect audio damage, not merely accept readable tags.
    const working=journal.tracks[0].temp;
    const broken=fs.readFileSync(working);
    broken[broken.length-20]^=1;fs.writeFileSync(working,broken);
    const check=native({op:'verify',path:working,original:file,tags:{name:'Changed'}});
    assert.equal(check.ok,false);
    assert.match(check.error,/Audio packets or decoding properties changed/);
    assert.equal(sha(file),initial);
});

test('v2.2 writes new Cyrillic lyrics with force off and on', {
    skip: process.platform!=='darwin' || !fs.existsSync(helper)
}, t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-v22-lyrics-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    for (const force of [false,true]) {
        const file=fixture(dir), originalAudio=audio(file);
        const request=path.join(dir,'lyrics-'+force+'.json'), plan=path.join(dir,'plan-'+force+'.json');
        cli('snapshot','--folder',dir,request);
        const draft=json(request);
        draft.tracks[0].tags={name:'Песня'};
        draft.tracks[0].lyrics='words.txt';
        const words='Новый текст\nВторая строка';
        fs.writeFileSync(path.join(dir,'words.txt'),words);
        json(request,draft);
        cli('prepare',request,plan,'--force',String(force));
        assert.deepEqual(json(plan).tracks[0].id3_migration,{from:2,to:3});
        assert.equal(Object.hasOwn(json(plan).tracks[0].tags,'name'),force);
        assert.match(cli('apply',plan),/Verified: 1/);
        assert.equal(fs.readFileSync(file)[3],3);
        assert.deepEqual(audio(file),originalAudio);
        const captured=native({op:'capture',paths:[file],extract:true}).result.rows[0];
        assert.equal(captured.lyrics.text,words);
        assert.equal(captured.tags.name,'Песня');
    }
});

test('prepare rejects unknown or obsolete v2.2 frames, unsafe headers and legacy tags before saving a plan', {
    skip: process.platform!=='darwin' || !fs.existsSync(helper)
}, t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-v22-errors-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    for (const [label,extra,flags,legacy] of [
        ['unknown',[frame('XYZ',Buffer.from('unknown'))],0,false],
        ['obsolete',[frame('TDA',Buffer.from('\x000101'))],0,false],
        ['header',[],128,false],['legacy',[],0,true]
    ]) {
        const file=fixture(dir,extra,flags);
        if (legacy) fs.appendFileSync(file,Buffer.concat([Buffer.from('TAG'),Buffer.alloc(125)]));
        const before=sha(file), request=path.join(dir,label+'.json'),plan=path.join(dir,label+'-plan.json');
        // Use the native reader to retain the real checksum/identity while changing a goal.
        const captured=native({op:'capture',paths:[file]}).result.rows[0];
        json(request,{version:2,tracks:[{path:file,sha256:captured.sha256,tags:{name:'Replacement'}}]});
        const result=run(path.join(root,'music-tags'),['prepare',request,plan]);
        assert.notEqual(result.status,0,label);
        assert.ok(result.stderr.includes(file),result.stderr);
        assert.match(result.stderr,/manual (migration|review)/);
        assert.equal(fs.existsSync(plan),false);assert.equal(fs.existsSync(plan+'.assets'),false);
        assert.equal(sha(file),before);
    }
});
