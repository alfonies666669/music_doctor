'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'), helper=path.join(root,'bin/music-tags-file');
const skip=process.platform!=='darwin'||!fs.existsSync(helper);
function run(bin,args) {return spawnSync(bin,args,{encoding:'utf8',maxBuffer:8*1024*1024});}
function ok(bin,args) {const r=run(bin,args);assert.equal(r.status,0,r.error||r.stderr||r.stdout);return r.stdout;}
function json(file,data) {if(data)fs.writeFileSync(file,JSON.stringify(data,null,2));else return JSON.parse(fs.readFileSync(file));}
function sha(file) {return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function fixture(t,mode,extension='mp3') {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-artwork-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const runtime=path.join(dir,'runtime'),media=path.join(dir,'media');
    fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});fs.mkdirSync(media);
    for(const f of ['music-tags','jxa.js','core.js','filters.js','file-commands.js'])
        fs.copyFileSync(path.join(root,f),path.join(runtime,f));
    fs.copyFileSync(helper,path.join(runtime,'bin/music-tags-file'));
    const track=path.join(media,'Original.'+extension),moved=path.join(media,'Moved.'+extension);
    ok('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=500:duration=0.2',
        '-c:a',extension==='mp3'?'libmp3lame':'aac','-metadata','title=Original',track]);
    const cover=path.join(dir,'cover.png');
    fs.writeFileSync(cover,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLE8AAAAASUVORK5CYII=','base64'));
    const mutate=path.join(dir,'music-write.js'),calls=path.join(dir,'calls.json');
    fs.writeFileSync(mutate,`
        const fs=require('node:fs');
        const [file,mode]=process.argv.slice(2);
        const old=fs.readFileSync(file);
        if (mode==='corrupt') {
            const at=old.indexOf(Buffer.from('Original'));
            if(at<0) throw new Error('Test title missing');
            Buffer.from('Modified').copy(old,at);fs.writeFileSync(file,old);
        } else if (mode!=='pass') {
            const size=((old[6]&127)<<21)|((old[7]&127)<<14)|((old[8]&127)<<7)|(old[9]&127);
            const changed=Buffer.concat([old.subarray(0,10+size),Buffer.alloc(32),old.subarray(10+size)]);
            const next=size+32;
            for(let i=0;i<4;i++) changed[6+i]=(next>>>(21-7*i))&127;
            if(mode==='atomic') {fs.writeFileSync(file+'.music',changed);fs.renameSync(file+'.music',file);}
            else fs.writeFileSync(file,changed);
        }
    `);
    const fake=`function musicIO() {
        var mode=${JSON.stringify(mode)}, track=${JSON.stringify(track)}, moved=${JSON.stringify(moved)};
        if(mode==='offline') throw new Error('Music unavailable');
        var current=exists(moved)?moved:track;
        return {
            filePath:function() {return mode==='wrong' ? ${JSON.stringify(cover)} : current;},
            refreshFile:function() {},
            replaceArtwork:function(id,art,expectedPath) {
                if(sha(art.path)!==art.sha256 || absolute(expectedPath)!==absolute(current)) throw new Error('Bad artwork target: '+expectedPath+' != '+current);
                var calls=${JSON.stringify(calls)}, ids=exists(calls)?JSON.parse(textFile(calls)):[];
                ids.push(id);$(JSON.stringify(ids)).writeToFileAtomicallyEncodingError($(calls),true,$.NSUTF8StringEncoding,null);
                var operation=mode==='failed' || mode==='moved' ? 'padding' : mode;
                task(${JSON.stringify(process.execPath)},[${JSON.stringify(mutate)},current,operation]);
                if(mode==='moved' && current===track) {task('/bin/mv',[track,moved]);current=moved;}
                if(mode==='failed') throw new Error('Readback failed after assignment');
            },
            matchesFile:function() {return true;}
        };
    }`;
    const jxa=path.join(runtime,'jxa.js');
    fs.writeFileSync(jxa,fs.readFileSync(jxa,'utf8').replace('function run(argv) {',fake+'\nfunction run(argv) {'));
    const cli=(...args)=>ok(path.join(runtime,'music-tags'),args);
    const request=path.join(dir,'request.json'),plan=path.join(dir,'plan.json');
    cli('snapshot','--folder',media,request);
    const draft=json(request);draft.tracks[0].tags={};draft.tracks[0].artwork=cover;
    draft.tracks[0].music_ids=['1111111111111111','2222222222222222'];
    json(request,draft);cli('prepare',request,plan);
    return {dir,runtime,track,moved,cover,calls,plan,cli,before:sha(track)};
}
for(const mode of ['padding','atomic','moved']) {
    test('Music artwork assignment verifies rewritten bytes and supports '+mode,{skip},t=>{
        const f=fixture(t,mode);
        const output=f.cli('apply',f.plan);
        assert.match(output,/Music artwork assigned: 1/,JSON.stringify(json(f.plan+'.journal.json')));
        assert.deepEqual(json(f.calls),['1111111111111111','2222222222222222']);
        const entry=json(f.plan+'.journal.json').tracks[0];
        const current=mode==='moved'?f.moved:f.track;
        assert.equal(entry.file_status,'verified');assert.equal(entry.music_status,'refreshed');
        assert.equal(entry.music_artwork_status,'verified');assert.equal(entry.music_file_verified,true);
        assert.notEqual(entry.file_sha256_before_music,entry.after_sha256);
        assert.equal(entry.after_sha256,sha(current));assert.equal(entry.expected_sha256,sha(current));
        const stat=fs.statSync(current);assert.equal(entry.after_identity,`${stat.dev}:${stat.ino}`);
        assert.equal(fs.existsSync(entry.backup),false);
        const actual=JSON.parse(f.cli('inspect',f.plan)).tracks[0];
        assert.equal(actual.tags.name,'Original');assert.equal(actual.artwork.sha256,sha(f.cover));
        assert.equal(JSON.parse(f.cli('status',f.plan)).tracks[0].observed_state,'matches_verified_music');
        assert.match(f.cli('apply',f.plan),/Already complete/);
        assert.equal(json(f.calls).length,2);
    });
}
test('M4A receives the same additional Music artwork step',{skip},t=>{
    const f=fixture(t,'pass','m4a');
    assert.match(f.cli('apply',f.plan),/Music artwork assigned: 1/);
    assert.equal(json(f.plan+'.journal.json').tracks[0].music_artwork_status,'verified');
    assert.equal(JSON.parse(f.cli('inspect',f.plan)).tracks[0].artwork.sha256,sha(f.cover));
});
for(const mode of ['offline','wrong','failed']) {
    test('Music '+mode+' keeps the verified file result separate',{skip},t=>{
        const f=fixture(t,mode);
        assert.match(f.cli('apply',f.plan),/Verified: 1 files\. Music warnings: 1/);
        const entry=json(f.plan+'.journal.json').tracks[0];
        assert.equal(entry.file_status,'verified');assert.equal(entry.music_status,'unavailable_or_failed');
        assert.equal(entry.music_artwork_status,'failed');assert.equal(entry.after_sha256,sha(f.track));
        assert.equal(fs.existsSync(entry.backup),false);
        assert.equal(fs.existsSync(f.calls),mode==='failed');
        if(mode==='failed') {
            assert.equal(entry.music_file_verified,true);
            assert.notEqual(entry.file_sha256_before_music,entry.after_sha256);
        }
    });
}
test('unrelated tags changed by Music fail verification and retain the backup',{skip},t=>{
    const f=fixture(t,'corrupt');
    const result=run(path.join(f.runtime,'music-tags'),['apply',f.plan]);
    assert.notEqual(result.status,0);assert.match(result.stderr,/Unrelated tag content changed|Unchanged logical tag differs/);
    const journal=json(f.plan+'.journal.json'),entry=journal.tracks[0];
    assert.equal(journal.status,'failed');assert.equal(entry.file_status,'failed');
    assert.equal(entry.music_artwork_status,'failed');assert.equal(entry.file_written,true);
    assert.equal(sha(entry.backup),f.before);
    assert.notEqual(sha(f.track),entry.expected_sha256);
});
