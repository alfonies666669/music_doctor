'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function run(bin,args) {const r=spawnSync(bin,args,{encoding:'utf8'});assert.equal(r.status,0,r.error||r.stderr);return r.stdout;}
test('production AppleScript image I/O preserves JPEG and PNG bytes without Music events',{skip:process.platform!=='darwin'},t=>{
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-artwork-io-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const png=path.join(dir,'image.png'),jpg=path.join(dir,'image.jpg');
    fs.writeFileSync(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLE8AAAAASUVORK5CYII=','base64'));
    run('sips',['-s','format','jpeg',png,'--out',jpg]);
    const sync=fs.readFileSync(path.join(root,'sync-artwork.applescript'),'utf8');
    const extract=fs.readFileSync(path.join(root,'extract-artwork.applescript'),'utf8');
    // Replace only Apple events sent to Music. Execute the actual image reader
    // and file writer, including data classes and Standard Additions events.
    const reader=sync.slice(sync.indexOf('    if imageFormat'),sync.indexOf('    tell application'));
    const writer=extract.slice(extract.indexOf('    -- Explicit Standard'),extract.lastIndexOf('end run'));
    const script=path.join(dir,'roundtrip.applescript');
    fs.writeFileSync(script,'on run argv\n    set imagePath to item 1 of argv\n    set imageFormat to item 2 of argv\n    set outputPath to item 3 of argv\n'+reader+'    set artworkBytes to imageData\n'+writer+'end run\n');
    for(const [format,input] of [['png',png],['jpg',jpg]]) {
        const output=path.join(dir,'export-'+format);
        const result=spawnSync('osascript',[script,input,format,output],{encoding:'utf8'});
        if (result.status!==0 && /sandbox_extension_issue_file failed/.test(result.stderr) && /-1708/.test(result.stderr)) {
            t.skip('This host denies Standard Additions file access; script compilation is checked separately.');return;
        }
        assert.equal(result.status,0,result.error||result.stderr);
        assert.deepEqual(fs.readFileSync(output),fs.readFileSync(input));
    }
});
