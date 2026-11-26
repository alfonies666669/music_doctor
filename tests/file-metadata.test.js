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
function run(bin,args,input) {return spawnSync(bin,args,{input,encoding:'utf8',maxBuffer:8*1024*1024});}
function ok(bin,args,input) {
    const r=run(bin,args,input); assert.equal(r.status,0,r.error||r.stderr||r.stdout); return r.stdout;
}
function native(payload) {return JSON.parse(ok(helper,[],JSON.stringify({protocol:1,...payload})));}
function sha(file) {return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function cli(...args) {return ok(path.join(root,'music-tags'),args);}
function json(file,value) {
    if(value) fs.writeFileSync(file,JSON.stringify(value,null,2));
    else return JSON.parse(fs.readFileSync(file));
}
function attributes(file) {
    const names=ok('/usr/bin/xattr',[file]).trim().split('\n').filter(Boolean);
    return Object.fromEntries(names.sort().map(name=>[name,ok('/usr/bin/xattr',['-px',name,file]).replace(/\s/g,'')]));
}
function acl(file) {return ok('/bin/ls',['-le',file]).split('\n').filter(line=>/^ \d+:/.test(line)).join('\n');}
function source(dir) {
    const file=path.join(dir,'fixture.mp3');
    ok('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=500:duration=0.35',
        '-c:a','libmp3lame','-id3v2_version','3','-metadata','title=Before',file]);
    ok('/usr/bin/xattr',['-w','com.apple.quarantine','0082;677282b9;com.apple.Music;',file]);
    ok('/usr/bin/xattr',['-w','com.music-doctor.fixture','preserve custom metadata',file]);
    ok('/bin/chmod',['+a',`user:${os.userInfo().username} allow read,write,readattr,writeattr,readextattr,writeextattr,readsecurity`,file]);
    assert.ok(acl(file));
    return file;
}

test('apply preserves exact quarantine, custom attributes and ACL on a real tagged file', {skip}, t=>{
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-metadata-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const file=source(dir), request=path.join(dir,'request.json'), plan=path.join(dir,'plan.json');
    cli('snapshot','--folder',dir,request);
    const expected=attributes(file), expectedACL=acl(file), beforeHash=sha(file), beforeStat=fs.statSync(file);
    const draft=json(request);draft.tracks[0].tags={name:'После записи'};json(request,draft);
    cli('prepare',request,plan);
    assert.equal(sha(file),beforeHash);
    assert.match(cli('apply',plan),/Verified: 1/);
    assert.deepEqual(attributes(file),expected);
    assert.equal(acl(file),expectedACL);
    assert.equal(fs.statSync(file).mode,beforeStat.mode);
    assert.equal(JSON.parse(cli('inspect',plan)).tracks[0].tags.name,'После записи');
    assert.equal(json(plan+'.journal.json').tracks[0].file_status,'verified');
});

test('metadata restoration checks copies and retains the final attribute/ACL guards', {skip}, t=>{
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-restore-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const file=source(dir), copy=path.join(dir,'copy.mp3');
    const captured=native({op:'capture',paths:[file]}).result.rows[0];
    assert.ok(!captured.error,captured.error);
    const originalHash=sha(file), expected=attributes(file), expectedACL=acl(file);
    ok('/bin/cp',['-p',file,copy]);
    ok('/usr/bin/xattr',['-w','com.apple.quarantine','0082;00000001;different;',copy]);
    ok('/usr/bin/xattr',['-w','com.music-doctor.unexpected','new attribute',copy]);
    ok('/bin/chmod',['-N',copy]);
    const payload={op:'restore_metadata',source:file,path:copy,sha256:originalHash,
        identity:captured.identity,target_sha256:sha(copy)};
    const broken=native({...payload,target_sha256:'0'.repeat(64)});
    assert.equal(broken.ok,false);assert.match(broken.error,/Copy bytes changed/);
    assert.equal(native(payload).ok,true);
    assert.deepEqual(attributes(copy),expected);assert.equal(acl(copy),expectedACL);
    assert.equal(sha(copy),originalHash);assert.equal(sha(file),originalHash);
    assert.equal(native({...payload,path:file}).ok,false);
    const commit={op:'commit',path:file,temp:copy,sha256:originalHash,identity:captured.identity,target_sha256:sha(copy)};
    ok('/usr/bin/xattr',['-w','com.music-doctor.unexpected','tampered',copy]);
    const badAttr=native(commit);
    assert.equal(badAttr.ok,false);assert.match(badAttr.error,/changed extended attributes/);
    assert.equal(native(payload).ok,true);
    ok('/bin/chmod',['-N',copy]);
    const badACL=native(commit);
    assert.equal(badACL.ok,false);assert.match(badACL.error,/changed ACL/);
    assert.equal(sha(file),originalHash);
    assert.deepEqual(attributes(file),expected);assert.equal(acl(file),expectedACL);
});

test('metadata-stage failure leaves the original and exact recovery metadata intact', {skip}, t=>{
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-metadata-recovery-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const file=source(dir), runtime=path.join(dir,'runtime');
    fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});
    for(const name of ['music-tags','jxa.js','core.js','filters.js','file-commands.js'])
        fs.copyFileSync(path.join(root,name),path.join(runtime,name));
    fs.copyFileSync(helper,path.join(runtime,'bin/music-tags-file'));
    const commands=path.join(runtime,'file-commands.js');
    fs.writeFileSync(commands,fs.readFileSync(commands,'utf8').replace(
        "entry.file_status='preserving_metadata'; record();",
        "entry.file_status='preserving_metadata'; record(); throw new Error('Injected metadata restoration failure');"));
    const request=path.join(dir,'request.json'),plan=path.join(dir,'plan.json');
    cli('snapshot','--folder',dir,request);
    const expected=attributes(file),expectedACL=acl(file),beforeHash=sha(file);
    const draft=json(request);draft.tracks[0].tags={name:'Changed'};json(request,draft);
    cli('prepare',request,plan);
    const result=run(path.join(runtime,'music-tags'),['apply',plan]);
    assert.notEqual(result.status,0);assert.match(result.stderr,/Injected metadata restoration failure/);
    const entry=json(plan+'.journal.json').tracks[0];
    assert.equal(entry.file_status,'failed');assert.equal(entry.previous_stage,'preserving_metadata');
    assert.equal(sha(file),beforeHash);assert.deepEqual(attributes(file),expected);assert.equal(acl(file),expectedACL);
    assert.equal(sha(entry.backup),beforeHash);
    assert.deepEqual(attributes(entry.backup),expected);assert.equal(acl(entry.backup),expectedACL);
    assert.ok(fs.existsSync(entry.temp));
});
