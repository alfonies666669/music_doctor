/* Foundation/JXA checks only. No live Music events and no library writes. */
ObjC.import('Foundation');
function run(argv) {
    var root=argv[0];
    if (!root || root[0]!=='/') throw new Error('Pass the absolute project directory');
    var source=ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(root+'/jxa.js'),$.NSUTF8StringEncoding,null));
    eval(source.slice(0,source.indexOf('function run(argv)')));
    var core=eval(textFile(root+'/core.js')+'\nMusicCore;');
    var dir=ObjC.unwrap($.NSTemporaryDirectory())+'music-doctor-native-'+ObjC.unwrap($.NSUUID.UUID.UUIDString);
    var passed=[];
    function check(name,value) {if (!value) throw new Error('FAILED: '+name);passed.push('PASS '+name);}
    try {
        mkdir(dir+'/nested');check('Foundation directory creation',exists(dir+'/nested'));
        saveJSON(dir+'/request.json',{version:2,tracks:[]},false);
        check('JSON round trip',JSON.parse(textFile(dir+'/request.json')).version===2);
        check('stdout stays separate',task('/bin/sh',['-c','printf output; printf diagnostic >&2'])==='output');
        var detail=false;
        try {task('/bin/sh',['-c','printf "specific failure" >&2; exit 7']);}
        catch(e) {detail=/exit 7.*specific failure/.test(String(e));}
        check('stderr and exit code survive in errors',detail);
        check('file hash',/^[a-f0-9]{64}$/.test(sha(dir+'/request.json')));
        $('\ufeffFirst\r\nSecond\r\n').writeToFileAtomicallyEncodingError($(dir+'/words.txt'),true,$.NSUTF8StringEncoding,null);
        check('lyrics normalize through real UTF-8 reader',lyricsFile(dir+'/words.txt',core)==='First\nSecond');
        var png=$.NSData.alloc.initWithBase64EncodedStringOptions('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLE8AAAAASUVORK5CYII=',0);
        png.writeToFileAtomically($(dir+'/cover.png'),true);
        check('PNG validation through AppKit',imageInfo(dir+'/cover.png').format==='png');
        var literals='a $(literal) "quote"';
        check('subprocess arguments remain data',task('/usr/bin/printf',['%s',literals])===literals);
        return passed.join('\n')+'\nNo Music events or music writes.';
    } finally {if (exists(dir)) fm.removeItemAtPathError($(dir),null);}
}
