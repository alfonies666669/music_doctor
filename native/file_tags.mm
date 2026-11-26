#import <Foundation/Foundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <AVFoundation/AVFoundation.h>
#import <CommonCrypto/CommonDigest.h>

#include "mpegfile.h"
#include "mpegproperties.h"
#include "id3v1tag.h"
#include "id3v2tag.h"
#include "id3v2header.h"
#include "textidentificationframe.h"
#include "attachedpictureframe.h"
#include "unsynchronizedlyricsframe.h"
#include "apetag.h"
#include "mp4file.h"
#include "mp4tag.h"
#include "mp4atom.h"
#include "mp4properties.h"
#include "taglib.h"

#include <algorithm>
#include <array>
#include <fstream>
#include <fcntl.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <sys/acl.h>
#include <unistd.h>
#include <vector>

using namespace TagLib;
static void require(bool pass, const char *message) {
    if (!pass) throw std::runtime_error(message);
}
static NSString *ns(const String &value) {
    auto utf8 = value.to8Bit(true);
    return [[NSString alloc] initWithBytes:utf8.data() length:utf8.size() encoding:NSUTF8StringEncoding];
}
static String tagString(NSString *value) { return String(value.UTF8String, String::UTF8); }
static NSData *bytes(const ByteVector &value) {
    return [NSData dataWithBytes:value.data() length:value.size()];
}
static ByteVector tagBytes(NSData *value) {
    return ByteVector(static_cast<const char *>(value.bytes), static_cast<unsigned>(value.length));
}
static bool present(id value) { return value != nil && value != NSNull.null; }
static NSString *clean(NSString *value) {
    return [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}
class Hash {
    CC_SHA256_CTX context;
public:
    Hash() { CC_SHA256_Init(&context); }
    void add(const void *data, size_t length) {
        while (length) {
            auto n = static_cast<CC_LONG>(std::min<size_t>(length, 1 << 20));
            CC_SHA256_Update(&context, data, n);
            data = static_cast<const char *>(data) + n;
            length -= n;
        }
    }
    void add(NSData *data) { add(data.bytes, data.length); }
    NSString *result() {
        unsigned char digest[CC_SHA256_DIGEST_LENGTH];
        char hex[2 * CC_SHA256_DIGEST_LENGTH + 1];
        CC_SHA256_Final(digest, &context);
        for (size_t i = 0; i < sizeof(digest); ++i) snprintf(hex + 2*i, 3, "%02x", digest[i]);
        return @(hex);
    }
};
static NSString *digest(NSData *data) { Hash h; h.add(data); return h.result(); }
static NSString *fileHash(NSString *path) {
    std::ifstream stream(path.fileSystemRepresentation, std::ios::binary);
    require(stream.is_open(), "Cannot open file for SHA-256");
    Hash hash;
    std::array<char, 128*1024> buffer;
    while (stream.read(buffer.data(), buffer.size()) || stream.gcount())
        hash.add(buffer.data(), static_cast<size_t>(stream.gcount()));
    require(stream.eof() && !stream.bad(), "Could not finish reading file for SHA-256");
    return hash.result();
}
static struct stat statFile(NSString *path) {
    require([path isKindOfClass:NSString.class] && [path hasPrefix:@"/"] &&
            [path rangeOfString:[NSString stringWithFormat:@"%C", (unichar)0]].location == NSNotFound,
            "Expected an absolute local path");
    struct stat value{};
    require(lstat(path.fileSystemRepresentation, &value) == 0 && S_ISREG(value.st_mode),
            "Expected an accessible regular file (symbolic links are excluded)");
    require(value.st_nlink == 1, "Hard links require manual review");
    return value;
}
static bool sameStat(const struct stat &a, const struct stat &b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
           a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
           a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
static void audioProperty(AudioFileID file, AudioFilePropertyID prop, void *value, UInt32 size) {
    auto status = AudioFileGetProperty(file, prop, &size, value);
    if (status != noErr) throw std::runtime_error("Cannot read audio property " + std::to_string(prop) + " (status " + std::to_string(status) + ")");
}
static void hashAudioProperty(Hash &hash, AudioFileID file, AudioFilePropertyID prop, UInt32 maxSize) {
    UInt32 size = 0;
    if (AudioFileGetPropertyInfo(file, prop, &size, nullptr) != noErr || !size) return;
    require(size <= maxSize, "Oversized audio property");
    std::vector<char> data(size, 0);
    auto status = AudioFileGetProperty(file,prop,&size,data.data());
    hash.add(&prop,sizeof(prop));
    hash.add(&status,sizeof(status));
    if (status == noErr) hash.add(data.data(),size);
}
// Compare the compressed packets and decoding/timing parameters rather than the file layout.
static NSString *audioFingerprint(NSString *path) {
    AudioFileID file = nullptr;
    auto url = [NSURL fileURLWithPath:path];
    require(AudioFileOpenURL((__bridge CFURLRef)url, kAudioFileReadPermission, 0, &file) == noErr,
            "AudioToolbox cannot read the audio stream");
    struct Close { AudioFileID file; ~Close() { AudioFileClose(file); } } close{file};
    AudioStreamBasicDescription format{};
    UInt64 total = 0;
    UInt32 maxPacket = 0;
    audioProperty(file, kAudioFilePropertyDataFormat, &format, sizeof(format));
    audioProperty(file, kAudioFilePropertyAudioDataPacketCount, &total, sizeof(total));
    UInt32 size = sizeof(maxPacket);
    if (AudioFileGetProperty(file, kAudioFilePropertyPacketSizeUpperBound, &size, &maxPacket) != noErr || !maxPacket)
        audioProperty(file, kAudioFilePropertyMaximumPacketSize, &maxPacket, sizeof(maxPacket));
    require(total && maxPacket && maxPacket <= 1024*1024 && total <= INT64_MAX, "Invalid audio packet table");
    Hash hash;
    hash.add(&format, sizeof(format));
    hash.add(&total, sizeof(total));
    hashAudioProperty(hash, file, kAudioFilePropertyMagicCookieData, 1024*1024);
    hashAudioProperty(hash, file, kAudioFilePropertyChannelLayout, 1024*1024);
    hashAudioProperty(hash, file, kAudioFilePropertyPacketTableInfo, 64);
    const UInt32 batch = std::min<UInt32>(128, std::max<UInt32>(1, (512*1024)/maxPacket));
    std::vector<char> buffer(batch * maxPacket);
    std::vector<AudioStreamPacketDescription> descriptions(batch);
    for (UInt64 index = 0; index < total;) {
        UInt32 count = static_cast<UInt32>(std::min<UInt64>(batch, total-index));
        UInt32 length = static_cast<UInt32>(buffer.size());
        std::fill(descriptions.begin(), descriptions.end(), AudioStreamPacketDescription{});
        auto status = AudioFileReadPacketData(file, false, &length, descriptions.data(), index, &count, buffer.data());
        require((status == noErr || status == kAudioFileEndOfFileError) && count && count <= batch &&
                index + count <= total && length <= buffer.size(), "Could not read every audio packet");
        for (UInt32 i = 0; i < count; ++i) {
            auto desc = descriptions[i];
            if (!desc.mDataByteSize && format.mBytesPerPacket) {
                desc.mDataByteSize = format.mBytesPerPacket;
                desc.mStartOffset = static_cast<SInt64>(i) * format.mBytesPerPacket;
            }
            require(desc.mStartOffset >= 0 && desc.mDataByteSize &&
                    UInt64(desc.mStartOffset) + desc.mDataByteSize <= length, "Invalid packet offsets");
            hash.add(&desc.mDataByteSize, sizeof(desc.mDataByteSize));
            hash.add(&desc.mVariableFramesInPacket, sizeof(desc.mVariableFramesInPacket));
            hash.add(buffer.data() + desc.mStartOffset, desc.mDataByteSize);
        }
        index += count;
    }
    if ([path.pathExtension.lowercaseString isEqual:@"mp3"]) {
        MPEG::File mp3(path.fileSystemRepresentation,false);
        auto offset = mp3.firstFrameOffset();
        require(offset >= 0, "Missing MPEG frames");
        std::ifstream stream(path.fileSystemRepresentation,std::ios::binary);
        stream.seekg(offset);
        std::array<char,64*1024> data;
        while (stream.read(data.data(),data.size()) || stream.gcount())
            hash.add(data.data(),static_cast<size_t>(stream.gcount()));
        require(stream.eof() && !stream.bad(), "Cannot verify MPEG frame bytes");
    }
    return hash.result();
}

struct TextField { NSString *key; const char *id3; const char *mp4; };
static const TextField textFields[] = {
    {@"name","TIT2","\251nam"}, {@"artist","TPE1","\251ART"}, {@"album","TALB","\251alb"},
    {@"albumArtist","TPE2","aART"}, {@"composer","TCOM","\251wrt"}, {@"genre","TCON","\251gen"}
};
static NSArray *texts(const StringList &list) {
    NSMutableArray *values = [NSMutableArray array];
    for (const auto &item : list) {
        NSString *value = ns(item);
        if (clean(value).length) [values addObject:value];
    }
    return values;
}
static StringList tagTexts(id value) {
    StringList list;
    for (NSString *item in ([value isKindOfClass:NSArray.class] ? value : @[value]))
        list.append(tagString(item));
    return list;
}
static id compactText(NSArray *values) {
    if (values.count == 1) return values[0];
    return values.count ? values : nil;
}
static void addTag(NSMutableDictionary *tags, NSString *key, id value) {
    if (value) tags[key] = value;
}
static NSNumber *number(NSString *value) {
    if (!value.length || [value rangeOfString:@"^[0-9]+$" options:NSRegularExpressionSearch].location == NSNotFound)
        return nil;
    auto n = value.longLongValue;
    return n > 0 && n <= INT32_MAX ? @(n) : nil;
}
static NSArray<NSString *> *numberPair(NSString *value) {
    return [value ?: @"" componentsSeparatedByString:@"/"];
}
static NSString *withYear(NSString *date, NSNumber *year) {
    NSString *prefix = [NSString stringWithFormat:@"%04ld", (long)year.integerValue];
    if (date.length <= 4) return prefix;
    require([date rangeOfString:@"^[0-9]{4}[-T]" options:NSRegularExpressionSearch].location == 0,
            "Ambiguous date, cannot safely replace only the year");
    return [prefix stringByAppendingString:[date substringFromIndex:4]];
}
static NSString *lyricsText(NSString *value) {
    NSString *normalized = [[value stringByReplacingOccurrencesOfString:@"\r\n" withString:@"\n"]
                             stringByReplacingOccurrencesOfString:@"\r" withString:@"\n"];
    if ([normalized hasPrefix:@"\ufeff"]) normalized = [normalized substringFromIndex:1];
    while ([normalized hasSuffix:@"\n"]) normalized = [normalized substringToIndex:normalized.length-1];
    return normalized;
}
static NSString *imageFormat(NSData *data) {
    const unsigned char *p = static_cast<const unsigned char *>(data.bytes);
    if (data.length >= 3 && p[0] == 0xff && p[1] == 0xd8 && p[2] == 0xff) return @"jpg";
    const char png[] = "\x89PNG\r\n\x1a\n";
    if (data.length >= 8 && memcmp(p, png, 8) == 0) return @"png";
    return nil;
}

// Conservative v2.2 -> v2.3 mapping. Unknown/obsolete frames must not be
// silently discarded by TagLib during migration. Extend only with tests.
static NSString *v22FrameID(NSString *key) {
    NSDictionary *mapping = @{
        @"TT1":@"TIT1", @"TT2":@"TIT2", @"TT3":@"TIT3",
        @"TP1":@"TPE1", @"TP2":@"TPE2", @"TP3":@"TPE3", @"TP4":@"TPE4",
        @"TAL":@"TALB", @"TCM":@"TCOM", @"TCO":@"TCON", @"TCP":@"TCMP",
        @"TRK":@"TRCK", @"TPA":@"TPOS", @"TYE":@"TYER",
        @"TXX":@"TXXX", @"COM":@"COMM", @"ULT":@"USLT", @"PIC":@"APIC",
        @"TBP":@"TBPM", @"TCR":@"TCOP", @"TEN":@"TENC", @"TLA":@"TLAN",
        @"TLE":@"TLEN", @"TPB":@"TPUB", @"TRC":@"TSRC", @"TSS":@"TSSE",
        @"UFI":@"UFID", @"CNT":@"PCNT", @"POP":@"POPM",
        @"WAF":@"WOAF", @"WAR":@"WOAR", @"WAS":@"WOAS", @"WCM":@"WCOM",
        @"WCP":@"WCOP", @"WPB":@"WPUB", @"WXX":@"WXXX"
    };
    NSString *mapped = mapping[key];
    if (!mapped) throw std::runtime_error(std::string("ID3v2.2 frame requires manual migration: ") + key.UTF8String);
    return mapped;
}

// Compare the on-disk frame inventory as well as TagLib's parsed frames.
static NSArray *id3Inventory(NSString *path, NSSet *excluded) {
    std::ifstream stream(path.fileSystemRepresentation,std::ios::binary);
    std::array<unsigned char,10> header{};
    require(static_cast<bool>(stream.read(reinterpret_cast<char *>(header.data()),10)), "Cannot read ID3 header");
    if (memcmp(header.data(),"ID3",3) != 0) return @[];
    const bool v22 = header[3] == 2;
    require((v22 && header[5] == 0) ||
            ((header[3] == 3 || header[3] == 4) && !(header[5] & 0xd0)),
            "ID3 version or header flags require manual review");
    auto size = [](const unsigned char *bytes, bool synchsafe) {
        uint32_t number = 0;
        for (int i=0;i<4;i++) {
            require(!synchsafe || !(bytes[i] & 128), "Invalid ID3 size");
            number = (number << (synchsafe ? 7 : 8)) | bytes[i];
        }
        return number;
    };
    auto length = size(header.data()+6,true);
    require(length <= 64*1024*1024, "ID3 metadata exceeds verification limit");
    std::vector<unsigned char> data(length);
    require(static_cast<bool>(stream.read(reinterpret_cast<char *>(data.data()),length)), "Truncated ID3 metadata");
    NSMutableArray *inventory = [NSMutableArray array];
    size_t offset = 0;
    const size_t idLength = v22 ? 3 : 4, headerLength = v22 ? 6 : 10;
    for (;offset+headerLength<=data.size() && data[offset];) {
        auto *frame = data.data()+offset;
        require(std::all_of(frame,frame+idLength,[](auto c){return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');}),
                "Invalid ID3 frame identifier");
        auto frameLength = v22 ? (uint32_t(frame[3])<<16 | uint32_t(frame[4])<<8 | frame[5]) :
                                size(frame+4,header[3]==4);
        require(frameLength > 0 && frameLength <= data.size()-offset-headerLength, "Truncated or empty ID3 frame");
        NSString *key = [[NSString alloc] initWithBytes:frame length:idLength encoding:NSISOLatin1StringEncoding];
        if (v22) key = v22FrameID(key);
        if (![excluded containsObject:key]) [inventory addObject:key];
        offset += headerLength+frameLength;
    }
    require(std::all_of(data.begin()+offset,data.end(),[](auto byte){ return byte == 0; }), "Unrecognized ID3 layout");
    return [inventory sortedArrayUsingSelector:@selector(compare:)];
}

class AudioTags {
    std::unique_ptr<MPEG::File> mp3;
    std::unique_ptr<MP4::File> m4a;
    NSString *path;

    ID3v2::Tag *id3(bool create = false) { return mp3->ID3v2Tag(create); }
    MP4::Tag *mp4tag() { return m4a->tag(); }
    MP4::Item item(const char *atom) { return mp4tag()->itemMap().value(atom); }
    ID3v2::FrameList frames(const char *key) {
        return id3() ? id3()->frameList(key) : ID3v2::FrameList{};
    }
    NSArray *valueList(const char *id, const char *atom) {
        if (m4a) return texts(item(atom).toStringList());
        NSMutableArray *values = [NSMutableArray array];
        for (auto *frame : frames(id)) {
            if (auto *text = dynamic_cast<ID3v2::TextIdentificationFrame *>(frame))
                [values addObjectsFromArray:texts(text->fieldList())];
        }
        return values;
    }
    void setText(const char *id, const char *atom, ::id value) {
        if (m4a) { mp4tag()->setItem(atom, tagTexts(value)); return; }
        require(frames(id).size() <= 1, "Duplicate targeted ID3 frame is ambiguous");
        auto *tag = id3(true);
        tag->removeFrames(id);
        auto *frame = new ID3v2::TextIdentificationFrame(id, id3Version() == 4 ? String::UTF8 : String::UTF16);
        frame->setText(tagTexts(value));
        tag->addFrame(frame);
    }
    int id3Version() { return mp3->hasID3v2Tag() ? id3()->header()->majorVersion() : 3; }
    NSArray *pictureEntries() {
        NSMutableArray *result = [NSMutableArray array];
        if (mp3) {
            for (auto *f : frames("APIC"))
                if (auto *p = dynamic_cast<ID3v2::AttachedPictureFrame *>(f))
                    [result addObject:@{@"data":bytes(p->picture()), @"front":@(p->type() == ID3v2::AttachedPictureFrame::FrontCover), @"mime":ns(p->mimeType()) ?: @""}];
        } else {
            for (const auto &p : item("covr").toCoverArtList())
                [result addObject:@{@"data":bytes(p.data()), @"front":@NO, @"mime":@(p.format())}];
        }
        return result;
    }
    NSArray *lyricEntries() {
        NSMutableArray *result = [NSMutableArray array];
        if (mp3) {
            for (auto *f : frames("USLT")) {
                if (auto *l = dynamic_cast<ID3v2::UnsynchronizedLyricsFrame *>(f)) {
                    [result addObject:lyricsText(ns(l->text())) ?: @""];
                }
            }
        } else {
            for (const auto &l : item("\251lyr").toStringList()) [result addObject:lyricsText(ns(l)) ?: @""];
        }
        return result;
    }
    NSInteger pictureIndex(NSArray *pictures) {
        if (pictures.count <= 1) return pictures.count ? 0 : -1;
        NSInteger front = -1;
        for (NSUInteger i=0; i<pictures.count; ++i) {
            if ([pictures[i][@"front"] boolValue]) {
                if (front >= 0) return -2;
                front = i;
            }
        }
        return front != -1 ? front : -2;
    }
    void setPicture(NSData *data) {
        NSString *format = imageFormat(data);
        require(format != nil, "Expected JPEG/PNG artwork");
        auto pictures = pictureEntries();
        NSInteger index = pictureIndex(pictures);
        require(index != -2, "Ambiguous primary cover");
        if (m4a) {
            mp4tag()->setItem("covr", MP4::CoverArtList{MP4::CoverArt(
                [format isEqual:@"jpg"] ? MP4::CoverArt::JPEG : MP4::CoverArt::PNG, tagBytes(data))});
            return;
        }
        auto all = frames("APIC");
        require(all.size() == pictures.count, "Unrecognized picture frame");
        auto *frame = index < 0 ? new ID3v2::AttachedPictureFrame :
            dynamic_cast<ID3v2::AttachedPictureFrame *>(all[index]);
        if(index < 0) {
            frame->setType(ID3v2::AttachedPictureFrame::FrontCover);
            id3(true)->addFrame(frame);
        }
        frame->setMimeType([format isEqual:@"jpg"] ? "image/jpeg" : "image/png");
        frame->setPicture(tagBytes(data));
    }
    void setLyrics(NSString *value) {
        require(lyricEntries().count <= 1, "Ambiguous unsynchronized lyrics");
        if (m4a) { mp4tag()->setItem("\251lyr", StringList(tagString(value))); return; }
        auto all = frames("USLT");
        require(all.size() <= 1, "Ambiguous unsynchronized lyrics");
        auto *frame = all.isEmpty() ? new ID3v2::UnsynchronizedLyricsFrame(id3Version() == 4 ? String::UTF8 : String::UTF16) :
            dynamic_cast<ID3v2::UnsynchronizedLyricsFrame *>(all.front());
        require(frame != nullptr, "Unrecognized lyrics frame");
        if (all.isEmpty()) { frame->setLanguage("und"); id3(true)->addFrame(frame); }
        frame->setTextEncoding(id3Version() == 4 ? String::UTF8 : String::UTF16);
        frame->setText(tagString(value));
    }
    void updatePair(NSDictionary *goals, NSString *indexKey, NSString *countKey, const char *id, const char *atom) {
        if (!goals[indexKey] && !goals[countKey]) return;
        if (m4a) {
            auto values = item(atom).toIntPair();
            auto index = goals[indexKey] ? [goals[indexKey] intValue] : values.first;
            auto count = goals[countKey] ? [goals[countKey] intValue] : values.second;
            mp4tag()->setItem(atom, MP4::Item(index, count));
        } else {
            auto existing = valueList(id, atom);
            auto pair = numberPair(existing.firstObject);
            require(existing.count <= 1 && pair.count <= 2, "Ambiguous numbering tag");
            NSString *index = goals[indexKey] ? [goals[indexKey] stringValue] : pair[0];
            NSString *count = goals[countKey] ? [goals[countKey] stringValue] : (pair.count == 2 ? pair[1] : @"");
            setText(id, atom, count.length ? [NSString stringWithFormat:@"%@/%@", index.length ? index : @"0", count] : index);
        }
    }
public:
    explicit AudioTags(NSString *file) : path(file) {
        statFile(path);
        auto ext = path.pathExtension.lowercaseString;
        if ([ext isEqual:@"mp3"]) {
            mp3 = std::make_unique<MPEG::File>(path.fileSystemRepresentation, true);
            require(mp3->isValid() && mp3->audioProperties() && mp3->audioProperties()->layer() == 3 &&
                    mp3->audioProperties()->sampleRate() > 0 && mp3->firstFrameOffset() >= 0, "Invalid MP3 audio");
        } else if ([ext isEqual:@"m4a"]) {
            m4a = std::make_unique<MP4::File>(path.fileSystemRepresentation, true);
            auto *props = m4a->audioProperties();
            require(m4a->isValid() && props && props->sampleRate() > 0 &&
                    (props->codec() == MP4::Properties::AAC || props->codec() == MP4::Properties::ALAC), "Expected AAC/ALAC in an M4A container");
            MP4::Atoms atoms(m4a.get());
            auto *movie = atoms.find("moov");
            require(movie && movie->findall("trak").size() == 1 && !atoms.find("moof") &&
                    !movie->find("mvex"), "Only non-fragmented single-track M4A is supported");
            auto *track = movie->find("trak");
            require(!track->findall("sinf", true).size(), "Encrypted M4A is unsupported");
            auto asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
            require(!asset.hasProtectedContent, "Protected M4A is unsupported");
        } else {
            throw std::runtime_error("Only local MP3 and M4A are supported");
        }
    }
    NSDictionary *read(bool extract) {
        NSMutableDictionary *tags = [NSMutableDictionary dictionary], *has = [NSMutableDictionary dictionary];
        NSMutableArray *issues = [NSMutableArray array];
        for (auto field : textFields) {
            id value = compactText(valueList(field.id3, field.mp4));
            if (!value && mp3 && mp3->hasID3v1Tag() && !mp3->hasID3v2Tag()) {
                auto *legacy = mp3->ID3v1Tag();
                String old;
                if ([field.key isEqual:@"name"]) old = legacy->title();
                if ([field.key isEqual:@"artist"]) old = legacy->artist();
                if ([field.key isEqual:@"album"]) old = legacy->album();
                if ([field.key isEqual:@"genre"]) old = legacy->genre();
                if (clean(ns(old)).length) value = ns(old);
            }
            addTag(tags,field.key,value);
            has[field.key] = @(value != nil);
        }
        NSArray *dates = valueList("TDRC","\251day");
        NSString *date = dates.firstObject;
        NSNumber *year = date.length >= 4 ? number([date substringToIndex:4]) : nil;
        if (!date && mp3 && mp3->hasID3v1Tag() && !mp3->hasID3v2Tag() && mp3->ID3v1Tag()->year())
            year = @(mp3->ID3v1Tag()->year());
        addTag(tags,@"year",year);
        has[@"year"] = date && (!year || dates.count > 1) ? NSNull.null : @(year != nil);
        for (bool disc : {false,true}) {
            NSString *indexKey = disc ? @"discNumber" : @"trackNumber", *countKey = disc ? @"discCount" : @"trackCount";
            const char *frame = disc ? "TPOS" : "TRCK", *atom = disc ? "disk" : "trkn";
            NSArray *values = valueList(frame,atom);
            auto pair = numberPair(values.firstObject);
            NSNumber *index = number(pair[0]), *count = pair.count == 2 ? number(pair[1]) : nil;
            bool unreadable = values.count > 1 || pair.count > 2;
            if (m4a) {
                auto value = item(atom);
                auto p = value.toIntPair();
                index = p.first > 0 ? @(p.first) : nil;
                count = p.second > 0 ? @(p.second) : nil;
                unreadable = mp4tag()->contains(atom) && value.type() != MP4::Item::Type::IntPair;
            } else if (!disc && !values.count && mp3->hasID3v1Tag() && !mp3->hasID3v2Tag() && mp3->ID3v1Tag()->track()) {
                index = @(mp3->ID3v1Tag()->track());
            }
            addTag(tags,indexKey,index); addTag(tags,countKey,count);
            for (NSUInteger i=0;i<2;i++) {
                auto *key = i ? countKey : indexKey;
                auto *n = i ? count : index;
                NSString *part = pair.count > i ? pair[i] : @"";
                has[key] = unreadable || (!m4a && part.length && ![part isEqual:@"0"] && !n) ? NSNull.null : @(n != nil);
            }
        }
        NSArray *comp = valueList("TCMP","cpil");
        NSString *compText = comp.firstObject;
        if (m4a && mp4tag()->contains("cpil")) {
            auto value = item("cpil");
            if (value.type() == MP4::Item::Type::Bool) tags[@"compilation"] = @(value.toBool());
            else has[@"compilation"] = NSNull.null;
        }
        if (mp3 && compText) {
            if (comp.count == 1 && ([compText isEqual:@"0"] || [compText isEqual:@"1"])) tags[@"compilation"] = @([compText isEqual:@"1"]);
            else has[@"compilation"] = NSNull.null;
        }
        if (!has[@"compilation"]) has[@"compilation"] = @(tags[@"compilation"] != nil);
        NSArray *pictures = pictureEntries(), *lyrics = lyricEntries();
        has[@"artwork"] = @NO; has[@"lyrics"] = @NO;
        for (NSDictionary *p in pictures) if ([p[@"data"] length]) has[@"artwork"] = @YES;
        for (NSString *l in lyrics) if (clean(l).length) has[@"lyrics"] = @YES;
        NSInteger index = pictureIndex(pictures);
        NSMutableDictionary *result = [@{@"tags":tags,@"has":has,@"issues":issues,
            @"duration":@((mp3 ? mp3->audioProperties()->lengthInMilliseconds() : m4a->audioProperties()->lengthInMilliseconds()) / 1000.0),
            @"format":mp3 ? @"mp3" : @"m4a"} mutableCopy];
        if (index == -2) [issues addObject:@"Ambiguous primary artwork"];
        if (lyrics.count > 1) [issues addObject:@"Multiple unsynchronized lyrics entries"];
        for (NSString *key in has) if (!present(has[key])) [issues addObject:[@"Unreadable field: " stringByAppendingString:key]];
        if (index >= 0) {
            NSData *image = pictures[index][@"data"];
            auto fmt = imageFormat(image);
            if (fmt && image.length <= 15000000) {
                NSMutableDictionary *art = [@{@"format":fmt,@"sha256":digest(image),@"size":@(image.length)} mutableCopy];
                if (extract) art[@"base64"] = [image base64EncodedStringWithOptions:0];
                result[@"artwork"] = art;
            } else [issues addObject:@"Primary artwork is not supported JPEG/PNG or exceeds size limit"];
        }
        if (lyrics.count == 1 && clean(lyrics[0]).length) {
            NSData *data = [lyrics[0] dataUsingEncoding:NSUTF8StringEncoding];
            NSMutableDictionary *lyric = [@{@"sha256":digest(data),@"size":@(data.length)} mutableCopy];
            if (extract && data.length <= 400000) lyric[@"text"] = lyrics[0];
            result[@"lyrics"] = lyric;
        }
        return result;
    }
    void checkWritable() {
        if (mp3) {
            require(id3Version() == 2 || id3Version() == 3 || id3Version() == 4, "ID3 version requires manual migration");
            // Validate raw frames before TagLib can discard an unrecognized one.
            id3Inventory(path,[NSSet set]);
            require(!mp3->hasAPETag() && !mp3->hasID3v1Tag(), "MP3 with legacy ID3v1 or APE tags requires manual review");
        }
    }
    NSDictionary *migration() {
        return mp3 && id3Version() == 2 ? @{@"from":@2,@"to":@3} : nil;
    }
    void write(NSDictionary *goals, NSData *picture, NSString *lyrics) {
        checkWritable();
        const auto version = mp3 && id3Version() == 4 ? ID3v2::v4 : ID3v2::v3;
        for (auto field : textFields)
            if (goals[field.key]) setText(field.id3,field.mp4,goals[field.key]);
        if (goals[@"year"]) {
            auto dates = valueList("TDRC","\251day");
            require(dates.count <= 1, "Ambiguous dates");
            setText("TDRC","\251day",withYear(dates.firstObject,goals[@"year"]));
        }
        if (goals[@"compilation"]) {
            const bool value = [goals[@"compilation"] boolValue];
            if (m4a) mp4tag()->setItem("cpil",MP4::Item(value));
            else setText("TCMP","cpil",value ? @"1" : @"0");
        }
        updatePair(goals,@"trackNumber",@"trackCount","TRCK","trkn");
        updatePair(goals,@"discNumber",@"discCount","TPOS","disk");
        if (picture) setPicture(picture);
        if (lyrics) setLyrics(lyrics);
        require(mp3 ? mp3->save(MPEG::File::ID3v2,File::StripNone,version,File::DoNotDuplicate) : m4a->save(), "TagLib save failed");
    }
    NSArray *untouched(NSDictionary *goals, bool replaceCover, bool replaceLyrics, bool migrating = false) {
        NSMutableSet *skip = [NSMutableSet set];
        for (auto field : textFields) {
            if (goals[field.key]) {
                const char *name = mp3 ? field.id3 : field.mp4;
                [skip addObject:[[NSString alloc] initWithBytes:name length:4 encoding:NSISOLatin1StringEncoding]];
            }
        }
        if (goals[@"year"]) [skip addObject:mp3 ? @"TDRC" : @"©day"];
        if (goals[@"compilation"]) [skip addObject:mp3 ? @"TCMP" : @"cpil"];
        if (goals[@"trackNumber"] || goals[@"trackCount"]) [skip addObject:mp3 ? @"TRCK" : @"trkn"];
        if (goals[@"discNumber"] || goals[@"discCount"]) [skip addObject:mp3 ? @"TPOS" : @"disk"];
        if (replaceLyrics) [skip addObject:mp3 ? @"USLT" : @"©lyr"];
        if (replaceCover && m4a) [skip addObject:@"covr"];
        NSMutableArray *result = [NSMutableArray array];
        if (mp3) {
            NSMutableSet *inventorySkip = [skip mutableCopy];
            if (replaceCover) [inventorySkip addObject:@"APIC"];
            if (goals[@"year"]) [inventorySkip addObjectsFromArray:@[@"TYER",@"TDAT",@"TIME"]];
            for (NSString *key in id3Inventory(path,inventorySkip)) [result addObject:[@"disk:" stringByAppendingString:key]];
        }
        if (mp3 && id3()) {
            auto pics = frames("APIC");
            auto idx = replaceCover ? pictureIndex(pictureEntries()) : -1;
            require(idx != -2, "Ambiguous primary artwork");
            auto *target = idx >= 0 ? pics[idx] : nullptr;
            for (auto *frame : id3()->frameList()) {
                NSString *key = ns(String(frame->frameID(), String::Latin1));
                if (frame != target && ![skip containsObject:key]) {
                    auto rendered = frame->render();
                    // Frame headers encode sizes differently across versions;
                    // compare the normalized payload, not those size bytes.
                    if (migrating) {
                        require(frame->frameID().size() == 4 && rendered.size() >= 10, "Unrecognized frame during ID3 migration");
                        rendered = rendered.mid(10);
                    }
                    [result addObject:[key stringByAppendingString:digest(bytes(rendered))]];
                }
            }
        }
        if (m4a) {
            MP4::Atoms atoms(m4a.get());
            auto *ilst = atoms.find("moov","udta","meta","ilst");
            NSMutableSet *seenTarget = [NSMutableSet set];
            std::ifstream stream(path.fileSystemRepresentation,std::ios::binary);
            require(stream.is_open(), "Cannot check MP4 atoms");
            if (ilst) for (auto *atom : ilst->children()) {
                auto name = atom->name();
                NSString *key = [[NSString alloc] initWithBytes:name.data() length:name.size() encoding:NSISOLatin1StringEncoding];
                if ([skip containsObject:key]) {
                    require(![seenTarget containsObject:key], "Duplicate targeted MP4 atom is ambiguous");
                    [seenTarget addObject:key];
                    continue;
                }
                auto size = atom->length();
                require(size >= 8 && size <= 32*1024*1024, "Oversized or invalid metadata atom");
                std::vector<char> data(static_cast<size_t>(size));
                stream.seekg(atom->offset());
                require(static_cast<bool>(stream.read(data.data(),size)), "Cannot read original MP4 atom");
                Hash hash; hash.add(data.data(),data.size());
                [result addObject:[key stringByAppendingString:hash.result()]];
            }
        }
        return [result sortedArrayUsingSelector:@selector(compare:)];
    }
    bool matchingVersion(AudioTags &after) {
        return !mp3 || (after.mp3 && after.id3Version() == (id3Version() == 2 ? 3 : id3Version()));
    }
    bool matchingDateTail(AudioTags &after) {
        auto a = valueList("TDRC","\251day");
        auto b = after.valueList("TDRC","\251day");
        if (a.count != 1 || [a[0] length] <= 4) return true;
        return b.count == 1 && [b[0] length] > 4 &&
               [[a[0] substringFromIndex:4] isEqual:[b[0] substringFromIndex:4]];
    }
};

static NSDictionary *capture(NSString *path, bool full, bool extract) {
    auto before = statFile(path);
    NSString *hash = full ? fileHash(path) : nil;
    AudioTags file(path);
    NSMutableDictionary *out = [file.read(extract) mutableCopy];
    require(sameStat(before,statFile(path)), "File changed while reading");
    out[@"path"] = path;
    out[@"identity"] = [NSString stringWithFormat:@"%llu:%llu",
                        (unsigned long long)before.st_dev,(unsigned long long)before.st_ino];
    if (hash) out[@"sha256"] = hash;
    return out;
}
static void checkExpected(NSString *path, NSString *hash, NSString *identity) {
    auto row = capture(path,true,false);
    require([row[@"sha256"] isEqual:hash] && (!identity || [row[@"identity"] isEqual:identity]), "Stale source file or identity");
}
static bool equalText(id expected, id observed) {
    NSArray *a = [expected isKindOfClass:NSArray.class] ? expected : @[expected];
    NSArray *b = [observed isKindOfClass:NSArray.class] ? observed : (observed ? @[observed] : @[]);
    return [a isEqual:b];
}
static void verify(NSString *original, NSString *output, NSDictionary *goals, NSString *art, NSString *lyrics) {
    auto aStat = statFile(original), bStat = statFile(output);
    AudioTags before(original), after(output);
    NSDictionary *a = before.read(false), *b = after.read(false);
    require([a[@"format"] isEqual:b[@"format"]] && before.matchingVersion(after), "Format or ID3 version changed");
    const bool migrating = before.migration() != nil;
    NSArray *originalTags = before.untouched(goals,art != nil,lyrics != nil,migrating);
    NSArray *writtenTags = after.untouched(goals,art != nil,lyrics != nil,migrating);
    if (![originalTags isEqual:writtenTags]) {
        for (NSString *entry in originalTags)
            if (![writtenTags containsObject:entry])
                throw std::runtime_error(std::string("Unrelated tag content changed: ") + [entry substringToIndex:4].UTF8String);
        for (NSString *entry in writtenTags)
            if (![originalTags containsObject:entry])
                throw std::runtime_error(std::string("Unexpected tag appeared: ") + [entry substringToIndex:4].UTF8String);
        throw std::runtime_error("Multiplicity of unrelated tags changed");
    }
    NSDictionary *beforeTags = a[@"tags"], *afterTags = b[@"tags"];
    for (NSString *key in goals) {
        id target = goals[key], observed = afterTags[key];
        bool matches = [target isKindOfClass:NSNumber.class] ? [target isEqual:observed] : equalText(target, observed);
        if (!matches) throw std::runtime_error(std::string("Tag verification failed: ") + key.UTF8String);
    }
    for (NSString *key in beforeTags) {
        if (!goals[key]) require([beforeTags[key] isEqual:afterTags[key]], "Unchanged logical tag differs");
    }
    if (goals[@"year"]) require(before.matchingDateTail(after), "Date detail was lost");
    if (art) require([b[@"artwork"][@"sha256"] isEqual:fileHash(art)], "Artwork bytes differ");
    if (lyrics) {
        NSData *data = [lyricsText(lyrics) dataUsingEncoding:NSUTF8StringEncoding];
        require([b[@"lyrics"][@"sha256"] isEqual:digest(data)], "Lyrics content differs");
    }
    require([audioFingerprint(original) isEqual:audioFingerprint(output)], "Audio packets or decoding properties changed");
    require(sameStat(aStat,statFile(original)) && sameStat(bStat,statFile(output)), "Files changed during verification");
}
static NSData *imageAt(NSString *path) {
    auto info = statFile(path);
    require(info.st_size > 0 && info.st_size <= 15000000, "Invalid artwork size");
    NSData *data = [NSData dataWithContentsOfFile:path];
    require(data != nil && imageFormat(data), "Invalid JPEG/PNG");
    return data;
}
static NSDictionary *extendedAttributes(NSString *path) {
    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    const char *name = path.fileSystemRepresentation;
    auto size = listxattr(name,nullptr,0,XATTR_NOFOLLOW);
    require(size >= 0 && size <= 1024*1024, "Cannot inspect extended attributes");
    if (size == 0) return result;
    std::vector<char> names(size);
    require(listxattr(name,names.data(),names.size(),XATTR_NOFOLLOW) == size, "Extended attributes changed during inspection");
    for (size_t i=0;i<names.size();) {
        const char *attribute = names.data()+i;
        size_t length = strnlen(attribute,names.size()-i);
        require(length && i+length < names.size(), "Invalid extended attribute list");
        auto bytes = getxattr(name,attribute,nullptr,0,0,XATTR_NOFOLLOW);
        require(bytes >= 0 && bytes <= 32*1024*1024, "Cannot inspect extended attribute");
        std::vector<char> data(bytes);
        require(getxattr(name,attribute,data.data(),data.size(),0,XATTR_NOFOLLOW) == bytes, "Extended attribute changed");
        NSString *key = @(attribute);
        require(key != nil, "Invalid extended attribute name");
        result[key] = [NSData dataWithBytes:data.data() length:data.size()];
        i += length+1;
    }
    return result;
}
static NSData *accessControl(NSString *path) {
    auto acl = acl_get_file(path.fileSystemRepresentation,ACL_TYPE_EXTENDED);
    if (!acl) {
        require(errno == ENOENT || errno == ENOTSUP, "Cannot inspect access control list");
        return [NSData data];
    }
    ssize_t length = 0;
    char *text = acl_to_text(acl,&length);
    acl_free(acl);
    require(text && length >= 0, "Cannot render access control list");
    auto result = [NSData dataWithBytes:text length:length];
    acl_free(text);
    return result;
}
// cp -p may rewrite quarantine metadata on macOS. Restore metadata only on
// checked, distinct working/backup files; never remove the comparison at commit.
static void restoreMetadata(NSString *source, NSString *target, NSString *sourceHash,
                            NSString *identity, NSString *targetHash) {
    checkExpected(source,sourceHash,identity);
    auto original = statFile(source), replacement = statFile(target);
    require(original.st_dev != replacement.st_dev || original.st_ino != replacement.st_ino,
            "Metadata restoration requires a distinct copy");
    require([fileHash(target) isEqual:targetHash], "Copy bytes changed before metadata restoration");
    require(original.st_mode == replacement.st_mode && original.st_uid == replacement.st_uid &&
            original.st_gid == replacement.st_gid && original.st_flags == replacement.st_flags,
            "Copy has different ownership or mode");
    NSDictionary *expected = extendedAttributes(source), *actual = extendedAttributes(target);
    NSData *expectedACL = accessControl(source);
    for (NSString *key in actual) {
        if (!expected[key])
            require(removexattr(target.fileSystemRepresentation,key.UTF8String,XATTR_NOFOLLOW) == 0,
                    "Cannot remove an unexpected attribute from the copy");
    }
    for (NSString *key in expected) {
        NSData *value = expected[key];
        if (![value isEqual:actual[key]]) {
            if (setxattr(target.fileSystemRepresentation,key.UTF8String,value.bytes,value.length,0,XATTR_NOFOLLOW) != 0)
                throw std::runtime_error(std::string("Cannot preserve extended attribute on copy: ") + key.UTF8String);
        }
    }
    if (![expectedACL isEqual:accessControl(target)]) {
        auto acl = acl_get_file(source.fileSystemRepresentation,ACL_TYPE_EXTENDED);
        require(acl != nullptr, "Cannot read source ACL for copy");
        int status = acl_set_file(target.fileSystemRepresentation,ACL_TYPE_EXTENDED,acl);
        acl_free(acl);
        require(status == 0, "Cannot preserve ACL on copy");
    }
    require([expected isEqual:extendedAttributes(target)] && [expectedACL isEqual:accessControl(target)],
            "Copy metadata differs after restoration");
    require([fileHash(target) isEqual:targetHash], "Copy bytes changed during metadata restoration");
    require(sameStat(original,statFile(source)), "Source changed during metadata restoration");
}

static void syncPath(NSString *path, bool directory) {
    int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | (directory ? O_DIRECTORY : 0));
    require(fd >= 0, "Cannot open path for synchronization");
    int status = fsync(fd);
    close(fd);
    require(status == 0, "Could not synchronize file");
}
static NSDictionary *dispatch(NSDictionary *request) {
    NSString *op = request[@"op"];
    require([request[@"protocol"] isEqual:@1], "Unsupported helper protocol");
    if ([op isEqual:@"version"]) return @{@"module":@"0.9.3",@"taglib":[NSString stringWithFormat:@"%d.%d.%d",TAGLIB_MAJOR_VERSION,TAGLIB_MINOR_VERSION,TAGLIB_PATCH_VERSION]};
    if ([op isEqual:@"read"] || [op isEqual:@"capture"]) {
        NSMutableArray *rows = [NSMutableArray array];
        for (NSString *path in request[@"paths"]) {
            @autoreleasepool {
                try { [rows addObject:capture(path,[op isEqual:@"capture"],[request[@"extract"] boolValue])]; }
                catch (const std::exception &e) { [rows addObject:@{@"path":path,@"error":@(e.what())}]; }
            }
        }
        return @{@"rows":rows};
    }
    NSString *path = request[@"path"];
    if ([op isEqual:@"sync"]) {
        syncPath(path,false);
        syncPath(path.stringByDeletingLastPathComponent,true);
        return @{};
    }
    if ([op isEqual:@"preflight"]) {
        checkExpected(path,request[@"sha256"],request[@"identity"]);
        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        if ([request[@"write"] boolValue]) {
            AudioTags source(path);
            source.checkWritable();
            if (source.migration()) result[@"id3_migration"] = source.migration();
            require(access(path.fileSystemRepresentation,W_OK) == 0 &&
                    access(path.stringByDeletingLastPathComponent.fileSystemRepresentation,W_OK) == 0, "Source file or directory is not writable");
        }
        return result;
    }
    if ([op isEqual:@"write"] || [op isEqual:@"verify"]) {
        NSDictionary *goals = request[@"tags"];
        NSString *art = request[@"artwork_path"], *lyricsPath = request[@"lyrics_path"];
        if (art) require([fileHash(art) isEqual:request[@"artwork_sha256"]], "Artwork asset changed");
        NSString *lyrics = nil;
        if (lyricsPath) {
            require([fileHash(lyricsPath) isEqual:request[@"lyrics_sha256"]], "Lyrics asset changed");
            auto info = statFile(lyricsPath);
            require(info.st_size > 0 && info.st_size <= 400000, "Invalid lyrics asset size");
            lyrics = [NSString stringWithContentsOfFile:lyricsPath encoding:NSUTF8StringEncoding error:nil];
            require(clean(lyrics).length > 0 && lyrics.length <= 100000, "Invalid UTF-8 lyrics");
        }
        if ([op isEqual:@"verify"]) {
            verify(request[@"original"],path,goals,art,lyrics);
            return @{@"sha256":fileHash(path)};
        }
        AudioTags temporary(path);
        temporary.write(goals,art ? imageAt(art) : nil,lyrics);
        return @{@"saved":@YES};
    }
    if ([op isEqual:@"restore_metadata"]) {
        restoreMetadata(request[@"source"],path,request[@"sha256"],request[@"identity"],request[@"target_sha256"]);
        return @{};
    }
    if ([op isEqual:@"commit"]) {
        NSString *temp = request[@"temp"];
        auto original = statFile(path), replacement = statFile(temp);
        require(original.st_dev == replacement.st_dev, "Temporary file must be on the same volume");
        require(original.st_mode == replacement.st_mode && original.st_uid == replacement.st_uid &&
                original.st_flags == replacement.st_flags && original.st_gid == replacement.st_gid, "Temporary file has different ownership or mode");
        require([extendedAttributes(path) isEqual:extendedAttributes(temp)], "Temporary copy changed extended attributes");
        require([accessControl(path) isEqual:accessControl(temp)], "Temporary copy changed ACL");
        require([fileHash(temp) isEqual:request[@"target_sha256"]] && sameStat(replacement,statFile(temp)), "Verified temporary file changed");
        syncPath(temp,false);
        checkExpected(path,request[@"sha256"],request[@"identity"]);
        require(sameStat(original,statFile(path)) && sameStat(replacement,statFile(temp)), "File changed before replacement");
        require(rename(temp.fileSystemRepresentation,path.fileSystemRepresentation) == 0, "Could not replace original file");
        syncPath(path.stringByDeletingLastPathComponent,true);
        // Music can move the file immediately after rename; retain its inode
        // without reopening an already stale pathname.
        return @{@"sha256":request[@"target_sha256"],
                 @"identity":[NSString stringWithFormat:@"%llu:%llu",
                     (unsigned long long)replacement.st_dev,(unsigned long long)replacement.st_ino]};
    }
    throw std::runtime_error("Unsupported helper operation");
}
int main() {
    @autoreleasepool {
        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        id parsed = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
        NSDictionary *out;
        @try {
            try {
                require([parsed isKindOfClass:NSDictionary.class], "Expected a JSON request");
                out = @{@"ok":@YES,@"result":dispatch(parsed)};
            } catch (const std::exception &e) {
                out = @{@"ok":@NO,@"error":@(e.what())};
            }
        } @catch (NSException *e) {
            out = @{@"ok":@NO,@"error":e.reason ?: @"Invalid native request"};
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
        if (!json) return 1;
        fwrite(json.bytes,1,json.length,stdout);
        fputc('\n',stdout);
        return 0;
    }
}
